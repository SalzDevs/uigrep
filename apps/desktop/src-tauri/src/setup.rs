use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    Json,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;
use uuid::Uuid;

use crate::{ApiError, DaemonState, DAEMON_ADDRESS};

const PAIRING_TTL: Duration = Duration::from_secs(300);
const MAX_PENDING: usize = 5;
const MAX_BROWSERS: usize = 20;

// Tauri injects the invoking WebviewWindow; a JSON argument cannot spoof it.
pub(crate) fn require_setup_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(window.label(), &["setup"])
}

fn require_window_label(label: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&label) {
        Ok(())
    } else {
        Err("This command is not allowed from this window.".into())
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct SetupData {
    browsers: Vec<BrowserCredential>,
    agent_configured: bool,
    pub(crate) test_challenge: Option<String>,
    pub(crate) test_capture_id: Option<String>,
    mcp_verified: bool,
    pub(crate) completed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCredential {
    id: String,
    name: String,
    client_id: String,
    origin: String,
    token: String,
}

struct PendingPairing {
    id: String,
    client_id: String,
    name: String,
    origin: String,
    secret: String,
    expires: Instant,
    approved: bool,
}

#[derive(Default)]
pub(crate) struct SetupMachine {
    pub(crate) data: SetupData,
    pending: HashMap<String, PendingPairing>,
    pub(crate) ready: bool,
    pub(crate) error: Option<String>,
    // A GET alone is not verification. An explicit master-only POST must follow.
    pub(crate) retrieved_test: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupStatus {
    daemon_ready: bool,
    paired_browsers: Vec<BrowserInfo>,
    pending_pairings: Vec<PendingInfo>,
    agent_configured: bool,
    test_capture_id: Option<String>,
    mcp_verified: bool,
    completed: bool,
    store_url: Option<String>,
    development_mode: bool,
    error: Option<String>,
}

#[derive(Serialize)]
struct BrowserInfo {
    id: String,
    name: String,
}
#[derive(Serialize)]
struct PendingInfo {
    id: String,
    name: String,
    origin: String,
}

pub(crate) fn official_id() -> Option<&'static str> {
    option_env!("UIGREP_CHROME_EXTENSION_ID").filter(|id| valid_chrome_id(id))
}
fn valid_chrome_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}
pub(crate) fn extension_origin_allowed(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .is_some_and(|id| {
            valid_chrome_id(id) && (cfg!(debug_assertions) || official_id() == Some(id))
        })
}
fn store_url() -> Option<String> {
    official_id().map(|id| format!("https://chromewebstore.google.com/detail/{id}"))
}
pub(crate) fn constant_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    a.as_bytes().ct_eq(b.as_bytes()).into()
}
fn new_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn valid_secret(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

impl SetupMachine {
    fn expire(&mut self, now: Instant) {
        self.pending.retain(|_, p| p.expires > now);
    }
    fn status(&mut self) -> SetupStatus {
        self.expire(Instant::now());
        let mut pending: Vec<_> = self
            .pending
            .values()
            .map(|p| PendingInfo {
                id: p.id.clone(),
                name: p.name.clone(),
                origin: p.origin.clone(),
            })
            .collect();
        pending.sort_by(|a, b| a.id.cmp(&b.id));
        SetupStatus {
            daemon_ready: self.ready,
            paired_browsers: self
                .data
                .browsers
                .iter()
                .map(|b| BrowserInfo {
                    id: b.id.clone(),
                    name: b.name.clone(),
                })
                .collect(),
            pending_pairings: pending,
            agent_configured: self.data.agent_configured,
            test_capture_id: self.data.test_capture_id.clone(),
            mcp_verified: self.data.mcp_verified,
            completed: self.data.completed,
            store_url: store_url(),
            development_mode: cfg!(debug_assertions),
            error: self.error.clone(),
        }
    }
    pub(crate) fn browser_for_token(&self, token: &str, origin: Option<&str>) -> Option<String> {
        self.data
            .browsers
            .iter()
            .find(|b| {
                constant_eq(&b.token, token)
                    && origin == Some(b.origin.as_str())
                    && extension_origin_allowed(&b.origin)
            })
            .map(|b| b.id.clone())
    }
    fn request(
        &mut self,
        r: PairRequest,
        origin: &str,
        now: Instant,
    ) -> Result<PairResponse, ApiError> {
        self.expire(now);
        Uuid::parse_str(&r.client_id)
            .map_err(|_| ApiError::bad_request("clientId must be a UUID."))?;
        if r.client_id.len() != 36
            || !valid_secret(&r.secret)
            || r.name.trim().is_empty()
            || r.name.len() > 80
            || r.name.chars().any(char::is_control)
        {
            return Err(ApiError::bad_request("Use a UUID clientId, a name of 1–80 UTF-8 bytes, and a random 64 lowercase hex secret."));
        }
        if let Some(p) = self
            .pending
            .values()
            .find(|p| p.client_id == r.client_id && p.origin == origin)
        {
            if !constant_eq(&p.secret, &r.secret) {
                return Err(ApiError { status: StatusCode::CONFLICT, message: "This browser already has a pending request. Wait up to five minutes before retrying.".into() });
            }
            return Ok(PairResponse {
                request_id: p.id.clone(),
                expires_in_seconds: p.expires.saturating_duration_since(now).as_secs(),
            });
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(ApiError { status: StatusCode::TOO_MANY_REQUESTS, message: "Five browsers are already waiting for approval. Reject a request or wait five minutes.".into() });
        }
        let id = Uuid::new_v4().to_string();
        self.pending.insert(
            id.clone(),
            PendingPairing {
                id: id.clone(),
                client_id: r.client_id,
                name: r.name.trim().into(),
                origin: origin.into(),
                secret: r.secret,
                expires: now + PAIRING_TTL,
                approved: false,
            },
        );
        Ok(PairResponse {
            request_id: id,
            expires_in_seconds: PAIRING_TTL.as_secs(),
        })
    }
    fn claim(
        &mut self,
        r: &ClaimRequest,
        origin: &str,
        now: Instant,
    ) -> Result<ClaimResponse, ApiError> {
        self.expire(now);
        let p = self.pending.get(&r.request_id).ok_or_else(|| ApiError { status: StatusCode::NOT_FOUND, message: "Pairing was rejected, expired, or already claimed. Click Connect to request approval again.".into() })?;
        if p.origin != origin || !constant_eq(&p.secret, &r.secret) {
            return Err(ApiError {
                status: StatusCode::UNAUTHORIZED,
                message: "Pairing secret or browser origin does not match.".into(),
            });
        }
        if !p.approved {
            return Ok(ClaimResponse {
                status: "pending",
                token: None,
                browser_id: None,
            });
        }
        let existing = self
            .data
            .browsers
            .iter()
            .position(|b| b.client_id == p.client_id && b.origin == p.origin);
        if existing.is_none() && self.data.browsers.len() >= MAX_BROWSERS {
            return Err(ApiError::bad_request(
                "Twenty browsers are paired. Revoke a browser before adding another.",
            ));
        }
        let id = existing
            .map(|i| self.data.browsers[i].id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let token = new_token();
        let credential = BrowserCredential {
            id: id.clone(),
            name: p.name.clone(),
            client_id: p.client_id.clone(),
            origin: p.origin.clone(),
            token: token.clone(),
        };
        if let Some(i) = existing {
            self.data.browsers[i] = credential;
        } else {
            self.data.browsers.push(credential);
        }
        // Handler removes only after the credential has been durably committed.
        Ok(ClaimResponse {
            status: "approved",
            token: Some(token),
            browser_id: Some(id),
        })
    }
    pub(crate) fn note_capture(
        &mut self,
        id: &str,
        page_url: &str,
        from_browser: bool,
        has_drag: bool,
    ) {
        if from_browser
            && has_drag
            && self
                .data
                .test_challenge
                .as_ref()
                .is_some_and(|c| page_url == test_url(c))
        {
            self.data.test_capture_id = Some(id.into());
            self.data.mcp_verified = false;
            self.data.completed = false;
            self.retrieved_test = None;
        }
    }
    fn verify(&mut self, id: &str) -> Result<(), ApiError> {
        if self.data.test_capture_id.as_deref() != Some(id)
            || self.retrieved_test.as_deref() != Some(id)
        {
            return Err(ApiError::bad_request("Retrieve the current test capture through MCP before verifying that same sessionId."));
        }
        self.data.mcp_verified = true;
        Ok(())
    }
    fn finish(&mut self) -> Result<(), String> {
        if !(self.ready && !self.data.browsers.is_empty() && self.data.agent_configured) {
            return Err(
                "Setup needs a healthy daemon, an approved browser, and a configured agent."
                    .into(),
            );
        }
        self.data.completed = true;
        Ok(())
    }
}

pub(crate) fn load(database: &rusqlite::Connection) -> Result<SetupMachine, String> {
    database.execute_batch("CREATE TABLE IF NOT EXISTS setup_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);").map_err(|e| e.to_string())?;
    use rusqlite::OptionalExtension;
    let payload: Option<String> = database
        .query_row("SELECT payload FROM setup_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let data = match payload {
        Some(p) => serde_json::from_str(&p).map_err(|e| format!("Cannot read setup state: {e}"))?,
        None => SetupData::default(),
    };
    Ok(SetupMachine {
        data,
        ..Default::default()
    })
}
pub(crate) fn save(database: &rusqlite::Connection, data: &SetupData) -> Result<(), String> {
    let payload = serde_json::to_string(data).map_err(|e| e.to_string())?;
    database.execute("INSERT INTO setup_state(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", params![payload]).map_err(|e| e.to_string())?;
    Ok(())
}
fn persist(state: &DaemonState, machine: &mut SetupMachine, old: SetupData) -> Result<(), String> {
    let result = state
        .inner
        .database
        .lock()
        .map_err(|_| "Database lock poisoned.".into())
        .and_then(|db| save(&db, &machine.data));
    if result.is_err() {
        machine.data = old;
    }
    result
}
fn mutate(
    state: &DaemonState,
    f: impl FnOnce(&mut SetupMachine) -> Result<(), String>,
) -> Result<SetupStatus, String> {
    let mut m = state
        .inner
        .setup
        .lock()
        .map_err(|_| "Setup lock poisoned.")?;
    let old = m.data.clone();
    f(&mut m)?;
    persist(state, &mut m, old)?;
    Ok(m.status())
}

pub(crate) fn mark_agent_configured(state: &DaemonState) -> Result<(), String> {
    mutate(state, |m| {
        m.data.agent_configured = true;
        Ok(())
    })
    .map(|_| ())
}
pub(crate) fn clear_agent_configured(state: &DaemonState) -> Result<(), String> {
    mutate(state, |m| {
        m.data.agent_configured = false;
        m.data.mcp_verified = false;
        m.data.completed = false;
        m.retrieved_test = None;
        Ok(())
    })
    .map(|_| ())
}

#[tauri::command]
pub(crate) fn setup_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
) -> Result<SetupStatus, String> {
    require_window_label(window.label(), &["setup", "pill"])?;
    Ok(state
        .inner
        .setup
        .lock()
        .map_err(|_| "Setup lock poisoned.")?
        .status())
}
#[tauri::command]
pub(crate) fn begin_browser_setup(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
) -> Result<SetupStatus, String> {
    require_setup_window(&window)?;
    let error = match store_url() {
        Some(url) => open::that_detached(url).err().map(|e| format!("Cannot open Chrome Web Store: {e}")),
        None => Some(if cfg!(debug_assertions) { "No official Chrome Web Store ID was compiled in. Development mode: load the unpacked Chrome companion and click Connect in its options." } else { "The official Chrome extension listing is not configured in this build. Install a release with UIGREP_CHROME_EXTENSION_ID set; no store page was opened." }.into()),
    };
    let mut m = state
        .inner
        .setup
        .lock()
        .map_err(|_| "Setup lock poisoned.")?;
    m.error = error;
    Ok(m.status())
}
#[tauri::command]
pub(crate) fn approve_pairing(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
    request_id: String,
) -> Result<SetupStatus, String> {
    require_setup_window(&window)?;
    let mut m = state
        .inner
        .setup
        .lock()
        .map_err(|_| "Setup lock poisoned.")?;
    m.expire(Instant::now());
    m.pending
        .get_mut(&request_id)
        .ok_or("Pairing request expired or no longer exists.")?
        .approved = true;
    m.error = None;
    Ok(m.status())
}
#[tauri::command]
pub(crate) fn reject_pairing(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
    request_id: String,
) -> Result<SetupStatus, String> {
    require_setup_window(&window)?;
    let mut m = state
        .inner
        .setup
        .lock()
        .map_err(|_| "Setup lock poisoned.")?;
    m.pending.remove(&request_id);
    Ok(m.status())
}
#[tauri::command]
pub(crate) fn revoke_browser(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
    browser_id: String,
) -> Result<SetupStatus, String> {
    require_setup_window(&window)?;
    let status = mutate(&state, |m| {
        m.data.browsers.retain(|b| b.id != browser_id);
        if m.data.browsers.is_empty() {
            m.data.completed = false;
            m.data.mcp_verified = false;
            m.retrieved_test = None;
        }
        Ok(())
    })?;
    // Wake sockets immediately; each socket revalidates before sending any event.
    let _ = state
        .inner
        .events
        .send(json!({"type":"state_changed","state":"ready"}).to_string());
    Ok(status)
}
fn test_url(challenge: &str) -> String {
    format!("http://{DAEMON_ADDRESS}/setup/test/{challenge}")
}
#[tauri::command]
pub(crate) fn open_test_capture(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
) -> Result<SetupStatus, String> {
    require_setup_window(&window)?;
    let challenge = Uuid::new_v4().to_string();
    mutate(&state, |m| {
        if !m.ready {
            return Err("The local daemon is not ready.".into());
        }
        m.data.test_challenge = Some(challenge.clone());
        m.data.test_capture_id = None;
        m.data.mcp_verified = false;
        m.data.completed = false;
        m.retrieved_test = None;
        m.error = None;
        Ok(())
    })?;
    open::that_detached(test_url(&challenge))
        .map_err(|e| format!("Cannot open the local test page: {e}"))?;
    setup_status(window, state)
}
#[tauri::command]
pub(crate) fn finish_setup(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
) -> Result<SetupStatus, String> {
    require_setup_window(&window)?;
    let status = mutate(&state, |m| m.finish())?;
    if let Some(window) = state.inner.app.get_webview_window("setup") {
        window.hide().map_err(|e| e.to_string())?;
    }
    if let Some(pill) = state.inner.app.get_webview_window("pill") {
        pill.show().map_err(|e| e.to_string())?;
    }
    Ok(status)
}
pub(crate) fn show_setup(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("setup")
        .ok_or("The separate setup window is missing from this build.")?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn reopen_setup(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
) -> Result<(), String> {
    // The pill's existing Setup action only shows the wizard; it grants no
    // permission to configure agents, approve browsers, or complete setup.
    require_window_label(window.label(), &["setup", "pill"])?;
    show_setup(&state.inner.app)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PairRequest {
    client_id: String,
    name: String,
    secret: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairResponse {
    request_id: String,
    expires_in_seconds: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClaimRequest {
    request_id: String,
    secret: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimResponse {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_id: Option<String>,
}
fn pairing_origin(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers.get("origin").and_then(|v| v.to_str().ok()).filter(|o| extension_origin_allowed(o)).ok_or_else(|| ApiError { status: StatusCode::FORBIDDEN, message: "Pairing requires the official Chrome extension origin. Unpacked Chrome is allowed only in debug builds; Firefox pairing is not supported yet.".into() })
}
pub(crate) async fn pair_request(
    State(state): State<DaemonState>,
    headers: HeaderMap,
    Json(r): Json<PairRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    let origin = pairing_origin(&headers)?;
    let result = state
        .inner
        .setup
        .lock()
        .map_err(|_| ApiError::internal("Setup lock poisoned."))?
        .request(r, origin, Instant::now())?;
    // Installation resumes the wizard, including when setup was previously closed.
    let _ = show_setup(&state.inner.app);
    Ok(Json(result))
}
pub(crate) async fn pair_claim(
    State(state): State<DaemonState>,
    headers: HeaderMap,
    Json(r): Json<ClaimRequest>,
) -> Result<Json<ClaimResponse>, ApiError> {
    if !valid_secret(&r.secret) || Uuid::parse_str(&r.request_id).is_err() {
        return Err(ApiError::bad_request("Invalid pairing claim."));
    }
    let origin = pairing_origin(&headers)?;
    let mut m = state
        .inner
        .setup
        .lock()
        .map_err(|_| ApiError::internal("Setup lock poisoned."))?;
    let old = m.data.clone();
    let response = m.claim(&r, origin, Instant::now())?;
    if response.token.is_some() {
        persist(&state, &mut m, old).map_err(ApiError::internal)?;
        m.pending.remove(&r.request_id);
        m.error = None;
    }
    Ok(Json(response))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VerifyRequest {
    session_id: String,
}
pub(crate) async fn verify(
    State(state): State<DaemonState>,
    Json(r): Json<VerifyRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Uuid::parse_str(&r.session_id)
        .map_err(|_| ApiError::bad_request("sessionId must be a UUID."))?;
    let mut m = state
        .inner
        .setup
        .lock()
        .map_err(|_| ApiError::internal("Setup lock poisoned."))?;
    let old = m.data.clone();
    m.verify(&r.session_id)?;
    persist(&state, &mut m, old).map_err(ApiError::internal)?;
    Ok(Json(json!({"ok":true})))
}
pub(crate) async fn test_page(
    State(state): State<DaemonState>,
    Path(challenge): Path<String>,
) -> Response {
    let valid = state
        .inner
        .setup
        .lock()
        .is_ok_and(|m| m.data.test_challenge.as_deref() == Some(&challenge));
    if !valid {
        return (
            StatusCode::NOT_FOUND,
            "This setup test expired. Open a new test from uigrep Setup.",
        )
            .into_response();
    }
    let mut response = Html(include_str!("setup_test.html")).into_response();
    response.headers_mut().insert("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_window_labels_are_exact_and_fail_closed() {
        assert!(require_window_label("setup", &["setup"]).is_ok());
        for label in ["pill", "", "Setup", "setup-child", "remote"] {
            assert!(require_window_label(label, &["setup"]).is_err());
        }
        assert!(require_window_label("pill", &["setup", "pill"]).is_ok());
        assert!(require_window_label("remote", &["setup", "pill"]).is_err());
    }

    const ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn request(m: &mut SetupMachine, now: Instant) -> (String, String) {
        let secret = "a".repeat(64);
        let id = m
            .request(
                PairRequest {
                    client_id: Uuid::new_v4().to_string(),
                    name: "Chrome".into(),
                    secret: secret.clone(),
                },
                ORIGIN,
                now,
            )
            .unwrap()
            .request_id;
        (id, secret)
    }
    #[test]
    fn expiry_wrong_secret_approval_and_replay() {
        let now = Instant::now();
        let mut m = SetupMachine::default();
        let (id, secret) = request(&mut m, now);
        let r = ClaimRequest {
            request_id: id.clone(),
            secret,
        };
        assert!(m
            .claim(
                &ClaimRequest {
                    request_id: id.clone(),
                    secret: "b".repeat(64)
                },
                ORIGIN,
                now
            )
            .is_err());
        assert!(m
            .claim(
                &r,
                "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                now
            )
            .is_err());
        assert_eq!(m.claim(&r, ORIGIN, now).unwrap().status, "pending");
        m.pending.get_mut(&id).unwrap().approved = true;
        assert!(m.claim(&r, ORIGIN, now).unwrap().token.is_some());
        m.pending.remove(&id); // durable handler commit consumes the claim
        assert!(m.claim(&r, ORIGIN, now).is_err());
        let (id, secret) = request(&mut m, now);
        assert!(m
            .claim(
                &ClaimRequest {
                    request_id: id,
                    secret
                },
                ORIGIN,
                now + PAIRING_TTL
            )
            .is_err());
    }
    #[test]
    fn deduplicate_and_limit() {
        let mut m = SetupMachine::default();
        let now = Instant::now();
        let client_id = Uuid::new_v4().to_string();
        let build = || PairRequest {
            client_id: client_id.clone(),
            name: "Chrome".into(),
            secret: "a".repeat(64),
        };
        let id = m.request(build(), ORIGIN, now).unwrap().request_id;
        assert_eq!(m.request(build(), ORIGIN, now).unwrap().request_id, id);
        for _ in 0..4 {
            request(&mut m, now);
        }
        assert!(m
            .request(
                PairRequest {
                    client_id: Uuid::new_v4().to_string(),
                    ..build()
                },
                ORIGIN,
                now
            )
            .is_err());
    }
    #[test]
    fn verification_and_finish_gates() {
        let mut m = SetupMachine::default();
        assert!(m.finish().is_err());
        let now = Instant::now();
        let (id, secret) = request(&mut m, now);
        m.pending.get_mut(&id).unwrap().approved = true;
        m.claim(
            &ClaimRequest {
                request_id: id,
                secret,
            },
            ORIGIN,
            now,
        )
        .unwrap();
        m.ready = true;
        m.data.agent_configured = true;
        // Browser + agent is enough for one-click setup; the capture test is optional.
        m.finish().unwrap();
        m.data.completed = false;
        m.data.test_challenge = Some(Uuid::new_v4().to_string());
        let url = test_url(m.data.test_challenge.as_ref().unwrap());
        let capture = Uuid::new_v4().to_string();
        m.note_capture(&capture, &url, false, true);
        assert!(m.data.test_capture_id.is_none());
        m.note_capture(&capture, "https://example.com", true, true);
        assert!(m.data.test_capture_id.is_none());
        m.note_capture(&capture, &url, true, true);
        assert!(m.verify(&capture).is_err());
        m.retrieved_test = Some(capture.clone());
        assert!(m.verify(&Uuid::new_v4().to_string()).is_err());
        m.verify(&capture).unwrap();
        m.note_capture(&Uuid::new_v4().to_string(), &url, true, true);
        assert!(!m.data.mcp_verified);
        assert!(!m.data.completed);
    }
    #[test]
    fn state_persists_without_pending_secrets_or_read_receipts() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        let mut m = load(&db).unwrap();
        request(&mut m, Instant::now());
        m.data.test_challenge = Some(Uuid::new_v4().to_string());
        save(&db, &m.data).unwrap();
        let restored = load(&db).unwrap();
        assert_eq!(restored.data.test_challenge, m.data.test_challenge);
        assert!(restored.pending.is_empty());
        assert!(restored.retrieved_test.is_none());
    }
    #[test]
    fn exact_origin_syntax() {
        for origin in [
            "https://example.com",
            "null",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.evil",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "moz-extension://aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        ] {
            assert!(!extension_origin_allowed(origin));
        }
        assert_eq!(
            extension_origin_allowed(ORIGIN),
            cfg!(debug_assertions) || official_id() == Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }
}
