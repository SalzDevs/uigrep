use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path as AxumPath, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{window::Color, Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;
use tower_http::limit::RequestBodyLimitLayer;
use uuid::Uuid;

mod agents;
mod capture_validation;
mod master_token;
mod runtime;
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
const CAPTURE_SHORTCUT: &str = "Option+Shift+G";

#[derive(Clone)]
pub(crate) struct DaemonState {
    pub(crate) inner: Arc<DaemonInner>,
}

pub(crate) struct DaemonInner {
    token: String,
    database: Mutex<Connection>,
    pub(crate) setup: Mutex<setup::SetupMachine>,
    app: tauri::AppHandle,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PillState {
    Ready,
    Selecting,
    Sending,
    Sent,
    Error { message: String },
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

fn compact_manifest(capture: &Value) -> Value {
    let annotations = capture
        .get("annotations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|annotation| {
                    json!({
                        "id": annotation.get("id"),
                        "order": annotation.get("order"),
                        "comment": annotation.get("comment"),
                        "rect": annotation.get("rect"),
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
        "app": capture.get("app"),
        "annotations": annotations,
    })
}

async fn authenticate(
    State(state): State<DaemonState>,
    mut request: Request,
    next: axum::middleware::Next,
) -> Result<Response<Body>, StatusCode> {
    let supplied = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let matches: bool = {
        use subtle::ConstantTimeEq;
        state
            .inner
            .token
            .as_bytes()
            .ct_eq(supplied.as_bytes())
            .into()
    };
    if !matches {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(request).await)
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": "0.2.0" }))
}

fn store_capture(state: &DaemonState, capture: &Value) -> Result<(), ApiError> {
    let id = capture
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Capture id is required."))?;
    let captured_at = capture
        .get("capturedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("capturedAt is required."))?;
    let status = capture
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Capture status is required."))?;
    let payload = serde_json::to_string(capture)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let mut database = state
        .inner
        .database
        .lock()
        .map_err(|_| ApiError::internal("Database lock poisoned."))?;
    database
        .execute(
            "INSERT INTO captures (id, captured_at, status, payload) VALUES (?1, ?2, ?3, ?4)",
            params![id, captured_at, status, payload],
        )
        .map_err(|e| ApiError {
            status: if matches!(e, rusqlite::Error::SqliteFailure(ref code, _)
                if code.code == rusqlite::ErrorCode::ConstraintViolation)
            {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            },
            message: e.to_string(),
        })?;
    Ok(())
}

async fn create_capture(
    State(state): State<DaemonState>,
    Json(mut capture): Json<Value>,
) -> Result<impl IntoResponse, ApiError> {
    capture_validation::normalize_capture(&mut capture);
    capture_validation::validate_capture(&capture).map_err(ApiError::bad_request)?;
    let id = capture
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("Capture id is required."))?
        .to_owned();
    store_capture(&state, &capture)?;
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
    Ok(Json(capture))
}

fn daemon_router(state: DaemonState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/captures", get(list_captures).post(create_capture))
        .route("/v1/captures/{id}", get(get_capture))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            authenticate,
        ))
        // Json otherwise applies Axum's default 2 MiB limit before our 8 MiB
        // transport budget. Keep both limits explicit and equal.
        .layer(DefaultBodyLimit::max(MAX_CAPTURE_BYTES))
        .layer(RequestBodyLimitLayer::new(MAX_CAPTURE_BYTES))
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

// --- Capture engine --------------------------------------------------------

#[derive(serde::Deserialize)]
struct RegionInput {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    comment: String,
}

fn frontmost_app() -> Result<(String, String, Option<String>), String> {
    let script = r#"
    tell application "System Events"
      set frontApp to first process whose frontmost is true
      set appName to name of frontApp
      try
        set appBundle to bundle identifier of frontApp
      on error
        set appBundle to "unknown"
      end try
      try
        set winTitle to name of front window of frontApp
      on error
        set winTitle to missing value
      end try
      return {appName, appBundle, winTitle}
    end tell"#;
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Cannot query the frontmost application: {e}"))?;
    if !output.status.success() {
        return Err("Cannot query the frontmost application.".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<String> = text
        .split(", ")
        .map(|p| p.trim().to_string())
        .collect();
    let name = parts.first().unwrap_or(&"unknown".into()).clone();
    let bundle = parts.get(1).unwrap_or(&"unknown".into()).clone();
    let title = parts
        .get(2)
        .filter(|t| !t.is_empty() && t.as_str() != "missing value")
        .cloned();
    Ok((name, bundle, title))
}

fn capture_region_png(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    path: &Path,
) -> Result<(), String> {
    let out = std::process::Command::new("screencapture")
        .arg("-x")
        .arg("-R")
        .arg(format!("{x},{y},{width},{height}"))
        .arg(path)
        .output()
        .map_err(|e| format!("Cannot run screencapture: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "screencapture failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn png_dimensions(bytes: &[u8]) -> Result<(u64, u64), String> {
    if bytes.len() < 24 || &bytes[12..16] != b"IHDR" {
        return Err("Screenshot is not a PNG".into());
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Ok((u64::from(width), u64::from(height)))
}

#[tauri::command]
async fn submit_capture(
    state: tauri::State<'_, DaemonState>,
    regions: Vec<RegionInput>,
) -> Result<(), String> {
    if regions.is_empty() || regions.len() > 50 {
        return Err("A capture must contain between 1 and 50 regions.".into());
    }
    let _ = state.inner.app.emit("pill-state", PillState::Sending);
    let config_dir = state
        .inner
        .app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    let capture_id = Uuid::new_v4().to_string();
    let capture_dir = config_dir.join("captures").join(&capture_id);
    std::fs::create_dir_all(&capture_dir).map_err(|e| e.to_string())?;

    // Hide the overlay so its outlines never leak into the pixels; hide is
    // async on macOS — give the compositor a beat before grabbing pixels.
    if let Some(window) = state.inner.app.get_webview_window("capture") {
        window.hide().map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(120));
    }

    // Region inputs are capture-window-local (CSS points). Convert to global
    // screen points for screencapture and stored rects.
    let (origin_x, origin_y) = if let Some(window) = state.inner.app.get_webview_window("capture") {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        (pos.x as f64, pos.y as f64)
    } else {
        (0.0, 0.0)
    };

    let (app_name, bundle_id, window_title) = frontmost_app()?;
    let mut annotations = Vec::with_capacity(regions.len());
    for (index, region) in regions.iter().enumerate() {
        let width = region.width.max(4.0);
        let height = region.height.max(4.0);
        let global_x = origin_x + region.x;
        let global_y = origin_y + region.y;
        let path = capture_dir.join(format!("a{}.png", index + 1));
        capture_region_png(global_x, global_y, width, height, &path)?;
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let (iw, ih) = png_dimensions(&bytes)?;
        annotations.push(json!({
            "id": Uuid::new_v4().to_string(),
            "order": index + 1,
            "comment": region.comment,
            "rect": { "x": global_x, "y": global_y, "width": width, "height": height },
            "image": {
                "resourceUri": format!(
                    "uigrep://captures/{capture_id}/{}",
                    path.file_name().and_then(|s| s.to_str()).unwrap_or("a1.png")
                ),
                "mimeType": "image/png",
                "byteLength": bytes.len(),
                "width": iw,
                "height": ih
            },
            "elements": []
        }));
    }
    let capture = json!({
        "schemaVersion": 2,
        "id": capture_id,
        "capturedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "status": "pending",
        "app": {
            "name": app_name,
            "bundleId": bundle_id,
            "windowTitle": window_title,
        },
        "annotations": annotations,
        "relationships": []
    });
    let mut normalized = capture.clone();
    capture_validation::normalize_capture(&mut normalized);
    capture_validation::validate_capture(&normalized)
        .map_err(|e| format!("Capture rejected: {e}"))?;
    store_capture(&state, &capture).map_err(|e| e.message)?;
    let _ = state.inner.app.emit("pill-state", PillState::Sent);
    Ok(())
}

fn show_capture_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    // Created lazily on first trigger: a hidden fullscreen transparent window
    // flashes opaque black on macOS during creation.
    let monitor = match app.cursor_position().ok().and_then(|cursor| {
        app.available_monitors()
            .ok()
            .and_then(|monitors| {
                monitors
                    .into_iter()
                    .find(|monitor| {
                        let position = monitor.position();
                        let size = monitor.size();
                        cursor.x >= f64::from(position.x)
                            && cursor.x < f64::from(position.x + size.width as i32)
                            && cursor.y >= f64::from(position.y)
                            && cursor.y < f64::from(position.y + size.height as i32)
                    })
            })
    }) {
        Some(monitor) => monitor,
        None => app
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("No display found.")?,
    };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let position = monitor.position().to_logical::<f64>(scale);
    if app.get_webview_window("capture").is_none() {
        tauri::WebviewWindowBuilder::new(
            app,
            "capture",
            tauri::WebviewUrl::App("index.html?view=capture".into()),
        )
        .title("uigrep capture")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .position(position.x, position.y)
        .inner_size(size.width, size.height)
        .build()
        .map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        if let Some(capture) = app.get_webview_window("capture") {
            let _ = capture.set_background_color(Some(Color(0, 0, 0, 0)));
        }
    }
    let _ = app.emit("pill-state", PillState::Selecting);
    let window = app
        .get_webview_window("capture")
        .ok_or("The capture overlay is missing from this build.")?;
    // Follow the cursor's display: reposition + resize before showing.
    window
        .set_position(tauri::LogicalPosition::new(position.x, position.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(size.width, size.height))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_capture(app: tauri::AppHandle) -> Result<(), String> {
    show_capture_overlay(&app)
}

#[tauri::command]
fn cancel_capture(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("capture") {
        window.hide().map_err(|e| e.to_string())?;
    }
    let _ = app.emit("pill-state", PillState::Ready);
    Ok(())
}

fn initialize_database(path: &Path) -> Result<Connection, String> {
    let database = Connection::open(path).map_err(|error| error.to_string())?;
    database
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS captures (
                id TEXT PRIMARY KEY,
                captured_at TEXT NOT NULL,
                status TEXT NOT NULL,
                payload TEXT NOT NULL
            );",
        )
        .map_err(|error| error.to_string())?;
    Ok(database)
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state
                        == tauri_plugin_global_shortcut::ShortcutState::Pressed
                        && shortcut.to_string().replace(' ', "") == "Option+Shift+G"
                    {
                        let _ = show_capture_overlay(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            setup::setup_status,
            setup::finish_setup,
            setup::reopen_setup,
            agents::agent_options,
            agents::configure_agent,
            agents::restore_agent_config,
            start_capture,
            cancel_capture,
            submit_capture
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
            let state = DaemonState {
                inner: Arc::new(DaemonInner {
                    token,
                    database: Mutex::new(database),
                    setup: Mutex::new(setup_machine),
                    app: app.handle().clone(),
                }),
            };
            app.manage(state.clone());

            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            app.global_shortcut()
                .register(CAPTURE_SHORTCUT)
                .map_err(std::io::Error::other)?;

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
            {
                if let Some(pill) = app.get_webview_window("pill") {
                    let _ = pill.set_background_color(Some(Color(0, 0, 0, 0)));
                }
                if let Some(capture) = app.get_webview_window("capture") {
                    let _ = capture.set_background_color(Some(Color(0, 0, 0, 0)));
                }
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
                    let _ = state
                        .inner
                        .app
                        .emit("pill-state", PillState::Error { message: "Local daemon failed to start.".into() });
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running uigrep");
}
