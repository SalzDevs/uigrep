use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use futures_util::sink::SinkExt;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path as AxumPath, Request, State,
    },
    http::{header::CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::broadcast;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    limit::RequestBodyLimitLayer,
};
use uuid::Uuid;

mod agents;
mod capture_validation;
mod master_token;
mod setup;

pub(crate) fn mark_agent_configured(state: &DaemonState) -> Result<(), String> {
    setup::mark_agent_configured(state)
}
pub(crate) fn clear_agent_configured(state: &DaemonState) -> Result<(), String> {
    setup::clear_agent_configured(state)
}

const DAEMON_ADDRESS: &str = "127.0.0.1:47831";
const TOKEN_HEADER: &str = "x-uigrep-token";
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct DaemonState {
    pub(crate) inner: Arc<DaemonInner>,
}

pub(crate) struct DaemonInner {
    token: String,
    database: Mutex<Connection>,
    events: broadcast::Sender<String>,
    app: tauri::AppHandle,
    pub(crate) setup: Mutex<setup::SetupMachine>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PillState {
    Ready,
    Selecting,
    Annotated { count: usize },
    Sending,
    Sent,
    Error,
    Paused,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

fn initialize_database(path: &Path) -> Result<Connection, String> {
    let database = Connection::open(path).map_err(|error| error.to_string())?;
    database
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS captures (
               id TEXT PRIMARY KEY,
               captured_at TEXT NOT NULL,
               status TEXT NOT NULL,
               payload TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );",
        )
        .map_err(|error| error.to_string())?;
    Ok(database)
}

fn summarize_target(target: Option<&Value>) -> String {
    let Some(target) = target else {
        return "Visual region".into();
    };
    let selectors = &target["selectors"];
    // Match TS nullish precedence: an empty testId does not fall through.
    let identity = selectors["testId"]
        .as_str()
        .or_else(|| selectors["accessibleName"].as_str())
        .or_else(|| target["text"].as_str())
        .unwrap_or("");
    let tag = target["tag"].as_str().unwrap_or("");
    let summary = [tag, identity.trim_matches(js_whitespace)]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    // Zod/JS count UTF-16 units. Do not emit a broken surrogate when the
    // boundary falls inside an astral character (JS slice can split it).
    let mut units = 0;
    summary
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 500
        })
        .collect()
}

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn compact_manifest(capture: &Value) -> Value {
    let annotations = capture
        .get("annotations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|annotation| {
                    let first_target = annotation
                        .get("targets")
                        .and_then(Value::as_array)
                        .and_then(|targets| targets.first());
                    let summary = summarize_target(first_target);
                    json!({
                        "id": annotation.get("id"),
                        "order": annotation.get("order"),
                        "comment": annotation.get("comment"),
                        "status": annotation.get("status").cloned().unwrap_or_else(|| json!("pending")),
                        "targetSummary": summary,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "schemaVersion": capture.get("schemaVersion"),
        "id": capture.get("id"),
        "capturedAt": capture.get("capturedAt"),
        "status": capture.get("status"),
        "page": capture.get("page"),
        "annotations": annotations,
        "relationshipCount": capture.get("relationships").and_then(Value::as_array).map_or(0, Vec::len),
    })
}

async fn authenticate(
    State(state): State<DaemonState>,
    mut request: Request,
    next: Next,
) -> Result<Response<Body>, StatusCode> {
    let supplied = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    let supplied = supplied.ok_or(StatusCode::UNAUTHORIZED)?;
    let origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok());
    let auth = if setup::constant_eq(supplied, &state.inner.token) {
        if !master_request_allowed(request.headers()) {
            return Err(StatusCode::FORBIDDEN);
        }
        Auth::Master
    } else {
        let browser = state
            .inner
            .setup
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .browser_for_token(supplied, origin)
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if request.method() != Method::POST || request.uri().path() != "/v1/captures" {
            return Err(StatusCode::FORBIDDEN);
        }
        Auth::Browser {
            id: browser,
            token: supplied.to_owned(),
            origin: origin.unwrap().to_owned(),
        }
    };
    request.extensions_mut().insert(auth);
    Ok(next.run(request).await)
}

#[derive(Clone)]
enum Auth {
    Master,
    Browser {
        id: String,
        token: String,
        origin: String,
    },
}

fn master_request_allowed(headers: &HeaderMap) -> bool {
    // Native MCP clients do not send browser provenance headers. Never accept
    // the master credential from a web page, including same-origin GETs.
    !headers.contains_key("origin")
        && !headers.contains_key("sec-fetch-site")
        && !headers.contains_key("referer")
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": "0.1.0" }))
}

async fn create_capture(
    State(state): State<DaemonState>,
    Extension(auth): Extension<Auth>,
    Json(mut capture): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    capture_validation::normalize_capture(&mut capture);
    capture_validation::validate_capture(&capture).map_err(ApiError::bad_request)?;
    let id = capture
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Capture id is required."))?;
    Uuid::parse_str(id).map_err(|_| ApiError::bad_request("Capture id must be a UUID."))?;
    let captured_at = capture
        .get("capturedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("capturedAt is required."))?;
    let status = capture
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("pending");
    let annotation_count = capture
        .get("annotations")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if annotation_count == 0 || annotation_count > 50 {
        return Err(ApiError::bad_request(
            "A capture must contain between 1 and 50 annotations.",
        ));
    }

    let payload = serde_json::to_string(&capture)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    {
        // All writes acquire setup BEFORE database. Commit the capture and its
        // setup evidence together; never hold a DB lock while acquiring setup.
        let mut machine = state
            .inner
            .setup
            .lock()
            .map_err(|_| ApiError::internal("Setup lock poisoned."))?;
        let from_browser = match &auth {
            Auth::Master => false,
            Auth::Browser { id, token, origin } => {
                if machine.browser_for_token(token, Some(origin)).as_ref() != Some(id) {
                    return Err(ApiError {
                        status: StatusCode::UNAUTHORIZED,
                        message: "Browser was revoked.".into(),
                    });
                }
                true
            }
        };
        let mut database = state
            .inner
            .database
            .lock()
            .map_err(|_| ApiError::internal("Database lock poisoned."))?;
        let transaction = database
            .transaction()
            .map_err(|e| ApiError::internal(e.to_string()))?;
        // Immutable IDs prevent another client overwriting setup evidence.
        transaction.execute("INSERT INTO captures (id, captured_at, status, payload) VALUES (?1, ?2, ?3, ?4)", params![id, captured_at, status, payload])
            .map_err(|e| ApiError { status: if matches!(e, rusqlite::Error::SqliteFailure(ref code, _) if code.code == rusqlite::ErrorCode::ConstraintViolation) { StatusCode::CONFLICT } else { StatusCode::INTERNAL_SERVER_ERROR }, message: e.to_string() })?;
        let old = machine.data.clone();
        let receipt = machine.retrieved_test.clone();
        let has_drag = capture["annotations"].as_array().is_some_and(|a| {
            a.iter().any(|a| {
                a["selectionMethod"] == "drag"
                    && a["viewportRect"]["width"].as_f64().unwrap_or(0.) >= 4.
                    && a["viewportRect"]["height"].as_f64().unwrap_or(0.) >= 4.
            })
        });
        machine.note_capture(
            id,
            capture["page"]["url"].as_str().unwrap_or(""),
            from_browser,
            has_drag,
        );
        if let Err(error) = setup::save(&transaction, &machine.data)
            .and_then(|_| transaction.commit().map_err(|e| e.to_string()))
        {
            machine.data = old;
            machine.retrieved_test = receipt;
            return Err(ApiError::internal(error));
        }
    }

    let event = json!({ "type": "capture_stored", "sessionId": id }).to_string();
    let _ = state.inner.events.send(event);
    let _ = state.inner.app.emit("pill-state", PillState::Sent);
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

async fn list_captures(State(state): State<DaemonState>) -> Result<Json<Value>, ApiError> {
    let database = state
        .inner
        .database
        .lock()
        .map_err(|_| ApiError::internal("Database lock was poisoned."))?;
    let mut statement = database
        .prepare("SELECT payload FROM captures ORDER BY captured_at DESC LIMIT 100")
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let manifests = rows
        .filter_map(Result::ok)
        .filter_map(|payload| serde_json::from_str::<Value>(&payload).ok())
        .map(|capture| compact_manifest(&capture))
        .collect::<Vec<_>>();
    Ok(Json(Value::Array(manifests)))
}

async fn get_capture(
    State(state): State<DaemonState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    Uuid::parse_str(&id).map_err(|_| ApiError::bad_request("Capture id must be a UUID."))?;
    let payload = {
        let database = state
            .inner
            .database
            .lock()
            .map_err(|_| ApiError::internal("Database lock was poisoned."))?;
        database
            .query_row("SELECT payload FROM captures WHERE id = ?1", [&id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| ApiError {
                status: StatusCode::NOT_FOUND,
                message: error.to_string(),
            })?
    };
    let capture =
        serde_json::from_str(&payload).map_err(|error| ApiError::internal(error.to_string()))?;
    let mut machine = state
        .inner
        .setup
        .lock()
        .map_err(|_| ApiError::internal("Setup lock poisoned."))?;
    if machine.data.test_capture_id.as_deref() == Some(&id) {
        machine.retrieved_test = Some(id);
    }
    Ok(Json(capture))
}

async fn event_socket(
    State(state): State<DaemonState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .filter(|o| setup::extension_origin_allowed(o))
        .ok_or(StatusCode::FORBIDDEN)?
        .to_owned();
    Ok(upgrade
        .max_message_size(4096)
        .max_frame_size(4096)
        .on_upgrade(move |socket| stream_events(socket, state, origin)))
}

async fn stream_events(mut socket: WebSocket, state: DaemonState, origin: String) {
    use std::time::Duration;
    let token = match tokio::time::timeout(Duration::from_secs(5), socket.recv()).await {
        Ok(Some(Ok(Message::Text(frame)))) => serde_json::from_str::<Value>(&frame)
            .ok()
            .filter(|v| v.as_object().is_some_and(|o| o.len() == 1))
            .and_then(|v| v["token"].as_str().map(str::to_owned)),
        _ => None,
    };
    let Some(token) = token else {
        let _ = socket.close().await;
        return;
    };
    let authorized = || {
        state
            .inner
            .setup
            .lock()
            .is_ok_and(|m| m.browser_for_token(&token, Some(&origin)).is_some())
    };
    if !authorized() {
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1008,
                reason: "Pairing required".into(),
            })))
            .await;
        return;
    }
    let mut receiver = state.inner.events.subscribe();
    if socket
        .send(Message::Text(
            json!({"type":"authenticated"}).to_string().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_pong = tokio::time::Instant::now();
    loop {
        let outgoing = tokio::select! {
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(60) { break; }
                Some(json!({"type":"heartbeat"}).to_string())
            },
            event = receiver.recv() => match event { Ok(event) => Some(event), Err(broadcast::error::RecvError::Lagged(_)) => continue, Err(_) => break },
            frame = socket.recv() => match frame {
                Some(Ok(Message::Text(text))) if text == "{\"type\":\"pong\"}" => { last_pong = tokio::time::Instant::now(); None },
                Some(Ok(Message::Pong(_))) => { last_pong = tokio::time::Instant::now(); None },
                Some(Ok(Message::Ping(_))) => None,
                _ => break,
            }
        };
        if !authorized() {
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1008,
                    reason: "Browser revoked".into(),
                })))
                .await;
            return;
        }
        if let Some(event) = outgoing {
            if !matches!(
                tokio::time::timeout(
                    Duration::from_secs(5),
                    socket.send(Message::Text(event.into()))
                )
                .await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
    }
    let _ = socket.close().await;
}

fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([CONTENT_TYPE, HeaderName::from_static(TOKEN_HEADER)])
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin.to_str().is_ok_and(setup::extension_origin_allowed)
        }))
}

fn daemon_router(state: DaemonState) -> Router {
    let protected = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/captures", get(list_captures).post(create_capture))
        .route("/v1/captures/{id}", get(get_capture))
        .route("/v1/setup/verify", post(setup::verify))
        // Master-only test hook: fires the same daemon event as the notch
        // trigger, so real-daemon end-to-end tests can drive the full capture
        // path without touching the native UI.
        .route("/v1/trigger-capture", post(trigger_capture))
        .route("/v1/test-approve-pairing", post(test_approve_pairing))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Router::new()
        .merge(protected)
        .route("/v1/events", get(event_socket))
        .route("/v1/pair/request", post(setup::pair_request))
        .route("/v1/pair/claim", post(setup::pair_claim))
        .route("/setup/test/{challenge}", get(setup::test_page))
        // Json otherwise applies Axum's default 2 MiB limit before our 8 MiB
        // transport budget. Keep both limits explicit and equal.
        .layer(DefaultBodyLimit::max(MAX_CAPTURE_BYTES))
        .layer(RequestBodyLimitLayer::new(MAX_CAPTURE_BYTES))
        .layer(cors_layer())
        .with_state(state)
}

async fn run_daemon(state: DaemonState) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(DAEMON_ADDRESS)
        .await
        .map_err(|error| error.to_string())?;
    state
        .inner
        .setup
        .lock()
        .map_err(|_| "Setup lock poisoned.")?
        .ready = true;
    let _ = state.inner.app.emit("pill-state", PillState::Ready);
    axum::serve(listener, daemon_router(state))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_capture(state: tauri::State<'_, DaemonState>) -> Result<(), String> {
    let _ = state.inner.app.emit("pill-state", PillState::Selecting);
    state
        .inner
        .events
        .send(json!({ "type": "start_capture" }).to_string())
        .map(|_| ())
        .map_err(|_| "No browser companion is connected.".to_string())
}

async fn trigger_capture(
    State(state): State<DaemonState>,
    Extension(auth): Extension<Auth>,
) -> Result<Json<Value>, ApiError> {
    if !matches!(auth, Auth::Master) {
        return Err(ApiError { status: StatusCode::FORBIDDEN, message: "Master credential required.".into() });
    }
    let _ = state.inner.app.emit("pill-state", PillState::Selecting);
    state
        .inner
        .events
        .send(json!({ "type": "start_capture" }).to_string())
        .map(|_| Json(json!({ "ok": true })))
        .map_err(|_| ApiError::bad_request("No browser companion is connected."))
}

async fn test_approve_pairing(
    State(state): State<DaemonState>,
    Extension(auth): Extension<Auth>,
) -> Result<Json<Value>, ApiError> {
    if !matches!(auth, Auth::Master) {
        return Err(ApiError { status: StatusCode::FORBIDDEN, message: "Master credential required.".into() });
    }
    let mut machine = state
        .inner
        .setup
        .lock()
        .map_err(|_| ApiError::internal("Setup lock poisoned."))?;
    let approved = machine.approve_all_pending();
    Ok(Json(json!({ "ok": true, "approved": approved })))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let completed = app
                .state::<DaemonState>()
                .inner
                .setup
                .lock()
                .map(|m| m.data.completed)
                .unwrap_or(false);
            let window = app.get_webview_window(if completed { "pill" } else { "setup" });
            if let Some(window) = window {
                let _ = window.show();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            start_capture,
            setup::setup_status,
            setup::begin_browser_setup,
            setup::approve_pairing,
            setup::reject_pairing,
            setup::set_auto_pair,
            setup::revoke_browser,
            setup::open_test_capture,
            setup::finish_setup,
            setup::reopen_setup,
            agents::agent_options,
            agents::configure_agent,
            agents::restore_agent_config
        ])
        .on_window_event(|window, event| {
            if window.label() == "setup" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let token = master_token::load_or_create(&config_dir)
                .map_err(std::io::Error::other)?;
            let database = initialize_database(&config_dir.join("uigrep.sqlite3"))
                .map_err(std::io::Error::other)?;
            let setup_machine = setup::load(&database).map_err(std::io::Error::other)?;
            let first_run = !setup_machine.data.completed;
            let (events, _) = broadcast::channel(64);
            let state = DaemonState {
                inner: Arc::new(DaemonInner {
                    token,
                    database: Mutex::new(database),
                    setup: Mutex::new(setup_machine),
                    events,
                    app: app.handle().clone(),
                }),
            };
            app.manage(state.clone());
            let setup_item =
                tauri::menu::MenuItem::with_id(app, "setup", "Setup…", true, None::<&str>)?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&setup_item, &quit_item])?;
            let mut tray = tauri::tray::TrayIconBuilder::new()
                .tooltip("uigrep")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "setup" => {
                        let _ = setup::show_setup(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            // Belt-and-braces: force a fully transparent window background on
            // macOS so only the notch is rendered, never an opaque rectangle.
            #[cfg(target_os = "macos")]
            if let Some(pill) = app.get_webview_window("pill") {
                use tauri::window::Color;
                let _ = pill.set_background_color(Some(Color(0, 0, 0, 0)));
            }
            if first_run {
                setup::show_setup(app.handle()).map_err(std::io::Error::other)?;
            } else {
                if let Some(pill) = app.get_webview_window("pill") {
                    pill.show().map_err(std::io::Error::other)?;
                }
            }
            tauri::async_runtime::spawn(async move {
                if let Err(error) = run_daemon(state.clone()).await {
                    if let Ok(mut machine) = state.inner.setup.lock() {
                        machine.ready = false;
                        machine.error = Some(format!("Cannot run local daemon: {error}"));
                    }
                    let _ = state.inner.app.emit("pill-state", PillState::Error);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running uigrep");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_summary_matches_shared_precedence_and_format() {
        assert_eq!(summarize_target(None), "Visual region");
        let mut target = json!({"tag":"button", "text":"Fallback", "selectors":{
            "testId":"\u{feff} save \u{00a0}", "accessibleName":"Save changes"
        }});
        assert_eq!(summarize_target(Some(&target)), "button · save");
        target["selectors"]["testId"] = "".into();
        assert_eq!(summarize_target(Some(&target)), "button");
        target["selectors"].as_object_mut().unwrap().remove("testId");
        assert_eq!(summarize_target(Some(&target)), "button · Save changes");
        target["selectors"] = json!({});
        assert_eq!(summarize_target(Some(&target)), "button · Fallback");
        target["tag"] = "".into();
        assert_eq!(summarize_target(Some(&target)), "Fallback");
    }

    #[test]
    fn manifest_summaries_fit_500_utf16_units() {
        for text in ["x".repeat(2000), "é".repeat(2000), "😀".repeat(1000)] {
            let target = json!({"tag":"button", "text":text, "selectors":{}});
            let mut capture = capture_validation::fixture();
            capture["annotations"][0]["targets"] = json!([target]);
            capture_validation::normalize_capture(&mut capture);
            let manifest = compact_manifest(&capture);
            let summary = manifest["annotations"][0]["targetSummary"].as_str().unwrap();
            assert!(summary.starts_with("button · "));
            assert!((499..=500).contains(&summary.encode_utf16().count()));
            assert_eq!(manifest["annotations"][0]["status"], "pending");
        }
    }
}
