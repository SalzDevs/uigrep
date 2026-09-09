use std::{
    fs,
    net::SocketAddr,
    path::Path,
    sync::{Arc, Mutex},
};

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, Request, State,
    },
    http::{header::CONTENT_TYPE, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::broadcast;
use tower_http::{cors::{AllowOrigin, CorsLayer}, limit::RequestBodyLimitLayer};
use uuid::Uuid;

const DAEMON_ADDRESS: &str = "127.0.0.1:47831";
const TOKEN_HEADER: &str = "x-uigrep-token";
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
struct DaemonState {
    inner: Arc<DaemonInner>,
}

struct DaemonInner {
    token: String,
    database: Mutex<Connection>,
    events: broadcast::Sender<String>,
    app: tauri::AppHandle,
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
        Self { status: StatusCode::BAD_REQUEST, message: message.into() }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: message.into() }
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
                    let summary = first_target
                        .and_then(|target| target.get("selectors"))
                        .and_then(|selectors| {
                            selectors
                                .get("testId")
                                .or_else(|| selectors.get("accessibleName"))
                        })
                        .or_else(|| first_target.and_then(|target| target.get("text")))
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("Visual region");
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
    request: Request,
    next: Next,
) -> Result<Response<Body>, StatusCode> {
    let supplied = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    if supplied != Some(state.inner.token.as_str()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(request).await)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": "0.1.0" }))
}

async fn create_capture(
    State(state): State<DaemonState>,
    Json(capture): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    let id = capture
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Capture id is required."))?;
    Uuid::parse_str(id).map_err(|_| ApiError::bad_request("Capture id must be a UUID."))?;
    let captured_at = capture
        .get("capturedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("capturedAt is required."))?;
    let status = capture.get("status").and_then(Value::as_str).unwrap_or("pending");
    let annotation_count = capture
        .get("annotations")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if annotation_count == 0 || annotation_count > 50 {
        return Err(ApiError::bad_request("A capture must contain between 1 and 50 annotations."));
    }

    let payload = serde_json::to_string(&capture).map_err(|error| ApiError::bad_request(error.to_string()))?;
    state
        .inner
        .database
        .lock()
        .map_err(|_| ApiError::internal("Database lock was poisoned."))?
        .execute(
            "INSERT INTO captures (id, captured_at, status, payload) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET captured_at = excluded.captured_at, status = excluded.status, payload = excluded.payload",
            params![id, captured_at, status, payload],
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let event = json!({ "type": "capture_stored", "sessionId": id }).to_string();
    let _ = state.inner.events.send(event);
    let _ = state.inner.app.emit("pill-state", PillState::Sent);
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

async fn list_captures(State(state): State<DaemonState>) -> Result<Json<Value>, ApiError> {
    let database = state.inner.database.lock().map_err(|_| ApiError::internal("Database lock was poisoned."))?;
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
    let database = state.inner.database.lock().map_err(|_| ApiError::internal("Database lock was poisoned."))?;
    let payload = database
        .query_row("SELECT payload FROM captures WHERE id = ?1", [id], |row| row.get::<_, String>(0))
        .map_err(|error| ApiError { status: StatusCode::NOT_FOUND, message: error.to_string() })?;
    let capture = serde_json::from_str(&payload).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(capture))
}

#[derive(Deserialize)]
struct EventSocketQuery {
    token: String,
}

async fn event_socket(
    State(state): State<DaemonState>,
    Query(query): Query<EventSocketQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<impl IntoResponse, StatusCode> {
    if query.token != state.inner.token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(upgrade.on_upgrade(move |socket| stream_events(socket, state.inner.events.subscribe())))
}

async fn stream_events(mut socket: WebSocket, mut receiver: broadcast::Receiver<String>) {
    while let Ok(event) = receiver.recv().await {
        if socket.send(Message::Text(event.into())).await.is_err() {
            break;
        }
    }
}

fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([CONTENT_TYPE, HeaderName::from_static(TOKEN_HEADER)])
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin
                .to_str()
                .is_ok_and(|value| value.starts_with("chrome-extension://") || value.starts_with("moz-extension://"))
        }))
}

async fn run_daemon(state: DaemonState) -> Result<(), String> {
    let protected = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/captures", get(list_captures).post(create_capture))
        .route("/v1/captures/{id}", get(get_capture))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let router = Router::new()
        .merge(protected)
        .route("/v1/events", get(event_socket))
        .layer(RequestBodyLimitLayer::new(MAX_CAPTURE_BYTES))
        .layer(cors_layer())
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(DAEMON_ADDRESS)
        .await
        .map_err(|error| error.to_string())?;
    axum::serve(listener, router).await.map_err(|error| error.to_string())
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("pill") {
                let _ = window.show();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![start_capture])
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            fs::create_dir_all(&config_dir)?;
            let token_path = config_dir.join("token");
            let token = fs::read_to_string(&token_path).unwrap_or_else(|_| {
                let token = Uuid::new_v4().to_string();
                let _ = fs::write(&token_path, &token);
                token
            });
            let database = initialize_database(&config_dir.join("uigrep.sqlite3"))
                .map_err(std::io::Error::other)?;
            let (events, _) = broadcast::channel(64);
            let state = DaemonState {
                inner: Arc::new(DaemonInner {
                    token: token.trim().to_owned(),
                    database: Mutex::new(database),
                    events,
                    app: app.handle().clone(),
                }),
            };
            app.manage(state.clone());
            tauri::async_runtime::spawn(async move {
                if run_daemon(state.clone()).await.is_err() {
                    let _ = state.inner.app.emit("pill-state", PillState::Error);
                }
            });
            let _ = app.emit("pill-state", PillState::Ready);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running uigrep");
}
