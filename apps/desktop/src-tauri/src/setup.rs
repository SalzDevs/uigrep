use std::{time::Instant};

use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

use crate::DaemonState;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct SetupData {
    agent_configured: bool,
    pub(crate) completed: bool,
}

#[derive(Default)]
pub(crate) struct SetupMachine {
    pub(crate) data: SetupData,
    pub(crate) ready: bool,
    pub(crate) error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupStatus {
    daemon_ready: bool,
    agent_configured: bool,
    completed: bool,
    development_mode: bool,
    error: Option<String>,
}

impl SetupMachine {
    fn status(&self) -> SetupStatus {
        SetupStatus {
            daemon_ready: self.ready,
            agent_configured: self.data.agent_configured,
            completed: self.data.completed,
            development_mode: cfg!(debug_assertions),
            error: self.error.clone(),
        }
    }
    pub(crate) fn finish(&mut self) -> Result<(), String> {
        if !(self.ready && self.data.agent_configured) {
            return Err(
                "Setup needs a healthy daemon and a configured agent.".into(),
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
        Some(p) => serde_json::from_str::<SetupData>(&p)
            .unwrap_or_default(),
        None => SetupData::default(),
    };
    Ok(SetupMachine {
        data,
        ..Default::default()
    })
}
pub(crate) fn save(database: &rusqlite::Connection, data: &SetupData) -> Result<(), String> {
    let payload = serde_json::to_string(data).map_err(|e| e.to_string())?;
    database.execute("INSERT INTO setup_state(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", rusqlite::params![payload]).map_err(|e| e.to_string())?;
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

fn require_window_label(label: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&label) {
        Ok(())
    } else {
        Err("This command is not allowed from this window.".into())
    }
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
        m.data.completed = false;
        Ok(())
    })
    .map(|_| ())
}

#[tauri::command]
pub(crate) fn finish_setup(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DaemonState>,
) -> Result<SetupStatus, String> {
    require_window_label(window.label(), &["setup"])?;
    let status = mutate(&state, |m| m.finish())?;
    if let Some(window) = state.inner.app.get_webview_window("setup") {
        window.hide().map_err(|e| e.to_string())?;
    }
    if let Some(pill) = state.inner.app.get_webview_window("pill") {
        pill.show().map_err(|e| e.to_string())?;
    }
    Ok(status)
}

pub(crate) fn require_setup_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    require_window_label(window.label(), &["setup"])
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
    require_window_label(window.label(), &["setup", "pill"])?;
    show_setup(&state.inner.app)
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

    #[test]
    fn finish_gate_needs_daemon_and_agent_only() {
        let mut m = SetupMachine::default();
        assert!(m.finish().is_err());
        m.ready = true;
        assert!(m.finish().is_err());
        m.data.agent_configured = true;
        m.finish().unwrap();
        assert!(m.data.completed);
    }
}
