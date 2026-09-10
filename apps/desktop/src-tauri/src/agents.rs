//! Explicit, user-requested MCP configuration and reversible, byte-exact ownership.
//!
//! Receipts are a bounded JSON header followed by the original and installed raw
//! bytes (not JSON byte arrays, which would multiply the storage requirement).
//! Persisting the receipt before installation permits recovery after interruption.
//! All paths, including ancestors, are checked without following symlinks or
//! Windows reparse points. The mutex serializes our commands; standard-library
//! path operations cannot eliminate races with another process replacing a parent
//! directory or editing a file between the final comparison and rename.
use std::{
    env,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const MAX_CONFIG: usize = 1024 * 1024;
const MAX_RECEIPT: usize = 3 * 1024 * 1024;
const MAX_HEADER: usize = 16 * 1024;
const MAGIC: &[u8; 8] = b"UIGREPA1";
const CHANGED: &str = "The client configuration changed since setup. No changes were made; restore it manually or undo those edits first.";
static OPERATIONS: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Agent {
    Vscode,
    Cursor,
}

impl Agent {
    fn from_id(id: &str) -> Result<Self, String> {
        match id {
            "vscode" => Ok(Self::Vscode),
            "cursor" => Ok(Self::Cursor),
            _ => Err("Unsupported agent. Choose VS Code or Cursor.".into()),
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Vscode => "vscode",
            Self::Cursor => "cursor",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Vscode => "VS Code",
            Self::Cursor => "Cursor",
        }
    }
    fn key(self) -> &'static str {
        match self {
            Self::Vscode => "servers",
            Self::Cursor => "mcpServers",
        }
    }
    fn entry(self, executable: &Path) -> Result<Value, String> {
        if !executable.is_absolute() {
            return Err("The uigrep executable path must be absolute.".into());
        }
        let command = executable
            .to_str()
            .ok_or("The executable path is not valid Unicode.")?;
        Ok(match self {
            Self::Vscode => json!({"type":"stdio", "command":command, "args":["--mcp"]}),
            Self::Cursor => json!({"command":command, "args":["--mcp"]}),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentOption {
    id: String,
    name: String,
    config_path: String,
    available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigResult {
    agent_id: String,
    config_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    backup_path: Option<String>,
    message: String,
}

fn config_path(app: &AppHandle, agent: Agent) -> Result<PathBuf, String> {
    let home = || {
        app.path()
            .home_dir()
            .map_err(|_| "Cannot locate the user home directory.".to_string())
    };
    let path = match agent {
        Agent::Cursor => home()?.join(".cursor/mcp.json"),
        Agent::Vscode => {
            #[cfg(windows)]
            let base = env::var_os("APPDATA")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .ok_or("APPDATA is not configured.")?;
            #[cfg(target_os = "macos")]
            let base = home()?.join("Library/Application Support");
            #[cfg(not(any(windows, target_os = "macos")))]
            let base = match env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
                Some(value) => PathBuf::from(value),
                None => home()?.join(".config"),
            };
            base.join("Code/User/mcp.json")
        }
    };
    validate_absolute(&path)?;
    Ok(path)
}

fn receipt_path(app: &AppHandle, agent: Agent) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot locate the uigrep configuration directory.")?
        .join(format!("agent-{}.receipt", agent.id()));
    validate_absolute(&path)?;
    Ok(path)
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "A configuration path is not valid Unicode.".into())
}

#[tauri::command]
pub(crate) fn agent_options(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<AgentOption>, String> {
    crate::setup::require_setup_window(&window)?;
    [Agent::Vscode, Agent::Cursor]
        .into_iter()
        .map(|agent| {
            let path = config_path(&app, agent)?;
            // This is directory discovery, NOT an assertion that an editor is installed.
            let available = inspect(parent(&path)?, true)?.is_some();
            Ok(AgentOption {
                id: agent.id().into(),
                name: format!(
                    "{} (configuration directory {})",
                    agent.name(),
                    if available { "found" } else { "not found" }
                ),
                config_path: path_text(&path)?,
                available,
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) fn configure_agent(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, crate::DaemonState>,
    agent_id: String,
) -> Result<ConfigResult, String> {
    crate::setup::require_setup_window(&window)?;
    let _guard = OPERATIONS
        .lock()
        .map_err(|_| "Agent configuration lock is unavailable.")?;
    let agent = Agent::from_id(&agent_id)?;
    let path = config_path(&app, agent)?;
    let receipt = receipt_path(&app, agent)?;
    let executable = env::current_exe().map_err(|_| "Cannot locate the uigrep executable.")?;
    // Only this explicit command creates missing parent directories. Discovery
    // above is read-only; the invoking setup button supplies user consent.
    let owned = install(agent, &path, &receipt, &agent.entry(&executable)?, || {
        crate::mark_agent_configured(&state)
            .map_err(|_| "Could not save agent setup status.".into())
    })?;
    Ok(ConfigResult {
        agent_id,
        config_path: path_text(&path)?,
        backup_path: owned.backup_path(&path)?.as_deref().map(path_text).transpose()?,
        message: "uigrep is configured. Restart or reload the client to load its MCP server. Restore is available only while the configuration remains unchanged.".into(),
    })
}

#[tauri::command]
pub(crate) fn restore_agent_config(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, crate::DaemonState>,
    agent_id: String,
) -> Result<(), String> {
    crate::setup::require_setup_window(&window)?;
    let _guard = OPERATIONS
        .lock()
        .map_err(|_| "Agent configuration lock is unavailable.")?;
    let agent = Agent::from_id(&agent_id)?;
    restore(
        agent,
        &config_path(&app, agent)?,
        &receipt_path(&app, agent)?,
        || {
            crate::clear_agent_configured(&state)
                .map_err(|_| "Could not clear agent setup status.".into())
        },
    )
}

fn parse_config(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_CONFIG {
        return Err("Client configuration exceeds the 1 MiB limit.".into());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        "Client configuration is not valid plain JSON. JSONC comments and trailing commas are unsupported; convert it to plain JSON before setup.".to_string()
    })?;
    if !value.is_object() {
        return Err("Client configuration must be a JSON object.".into());
    }
    Ok(value)
}

fn merge_config(agent: Agent, before: Option<&[u8]>, entry: &Value) -> Result<Vec<u8>, String> {
    let mut value = match before {
        Some(bytes) => parse_config(bytes)?,
        None => json!({}),
    };
    let root = value
        .as_object_mut()
        .ok_or("Client configuration must be a JSON object.")?;
    let servers = root
        .entry(agent.key())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("The client server collection must be a JSON object.")?;
    if let Some(existing) = servers.get("uigrep") {
        if existing != entry {
            return Err("A different uigrep server configuration already exists. It will not be replaced; remove or rename it yourself before setup.".into());
        }
        // Do not reformat an already matching configuration, even without a receipt.
        return Ok(before.ok_or("Missing original configuration.")?.to_vec());
    }
    servers.insert("uigrep".into(), entry.clone());
    let mut bytes =
        serde_json::to_vec_pretty(&value).map_err(|_| "Cannot encode client configuration.")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_CONFIG {
        return Err("Updated client configuration would exceed 1 MiB.".into());
    }
    Ok(bytes)
}

fn validate_absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(
            "Configuration paths must be absolute and must not contain traversal components."
                .into(),
        );
    }
    Ok(())
}

fn parent(path: &Path) -> Result<&Path, String> {
    path.parent()
        .ok_or_else(|| "Configuration path has no parent directory.".into())
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes directory junctions and other non-symlink reparse points.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Check every existing component with symlink_metadata, including the leaf.
fn inspect(path: &Path, directory: bool) -> Result<Option<Metadata>, String> {
    validate_absolute(path)?;
    let mut current = PathBuf::new();
    let mut result = None;
    let mut missing = false;
    for component in path.components() {
        current.push(component.as_os_str());
        // A Windows drive prefix alone is not an absolute path to inspect.
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if missing || is_link(&metadata) {
                    return Err(
                        "Symlinks and reparse points are not supported in configuration paths."
                            .into(),
                    );
                }
                let wants_directory = current != path || directory;
                if (wants_directory && !metadata.is_dir())
                    || (!wants_directory && !metadata.is_file())
                {
                    return Err("Configuration paths must contain only directories and a regular target file.".into());
                }
                result = Some(metadata);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing = true;
                result = None;
            }
            Err(_) => {
                return Err(
                    "Cannot inspect a configuration path; check directory permissions.".into(),
                )
            }
        }
    }
    Ok(result)
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    if inspect(path, true)?.is_some() {
        return Ok(());
    }
    ensure_directory(parent(path)?)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => sync_directory(parent(path)?)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(_) => return Err("Cannot create the configuration directory.".into()),
    }
    inspect(path, true)?.ok_or("Configuration directory disappeared.")?;
    Ok(())
}

fn read_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let Some(metadata) = inspect(path, false)? else {
        return Ok(None);
    };
    if metadata.len() > limit as u64 {
        return Err("Configuration or receipt exceeds its size limit.".into());
    }
    let file = File::open(path).map_err(|_| "Cannot read a configuration file.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect an open configuration file.")?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("Configuration is not a regular file within the size limit.".into());
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read a configuration file.")?;
    if bytes.len() > limit {
        return Err("Configuration or receipt exceeds its size limit.".into());
    }
    // Recheck ancestry as well as the open file before returning any contents.
    inspect(path, false)?.ok_or("Configuration file disappeared while reading.")?;
    Ok(Some(bytes))
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Cannot durably save the configuration directory.")?;
    }
    // std does not expose a portable Windows directory flush. File contents are
    // flushed before and after rename; fs::rename replaces an existing file on
    // Windows (MoveFileExW with MOVEFILE_REPLACE_EXISTING), without unlinking it.
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn create_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    inspect(path, false)?;
    inspect(parent(path)?, true)?.ok_or("The destination directory is missing.")?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot create a unique configuration staging or backup file.")?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(path);
        return Err("Cannot durably write configuration data.".into());
    }
    sync_directory(parent(path)?)
}

/// Compare exact bytes immediately before an atomic replacement/removal.
fn replace_checked(
    path: &Path,
    expected: Option<&[u8]>,
    replacement: Option<&[u8]>,
    limit: usize,
) -> Result<(), String> {
    if read_bounded(path, limit)?.as_deref() != expected {
        return Err(CHANGED.into());
    }
    if replacement == expected {
        return Ok(());
    }
    if let Some(bytes) = replacement {
        if bytes.len() > limit {
            return Err("Replacement exceeds its size limit.".into());
        }
        let stage = parent(path)?.join(format!(".uigrep-{}.stage", Uuid::new_v4()));
        create_new_file(&stage, bytes)?;
        let result = (|| {
            if read_bounded(path, limit)?.as_deref() != expected {
                return Err(CHANGED.into());
            }
            inspect(&stage, false)?.ok_or("Configuration staging file disappeared.")?;
            fs::rename(&stage, path).map_err(|_| {
                "Cannot atomically replace the configuration file; close the client and retry."
            })?;
            // Windows FlushFileBuffers requires a handle opened for writing.
            inspect(path, false)?.ok_or("Replaced configuration file disappeared.")?;
            OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|file| file.sync_all())
                .map_err(|_| "Cannot flush the replaced configuration file.")?;
            sync_directory(parent(path)?)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&stage);
        }
        result
    } else {
        fs::remove_file(path).map_err(|_| "Cannot remove the unchanged configuration file.")?;
        sync_directory(parent(path)?)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Prepared,
    Installed,
    Restoring,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u8,
    agent_id: String,
    config_path: PathBuf,
    backup_name: Option<String>,
    before_len: Option<usize>,
    after_len: usize,
    phase: Phase,
}

#[derive(Clone)]
struct Receipt {
    header: Header,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}

impl Receipt {
    fn encode(&self) -> Result<Vec<u8>, String> {
        let header =
            serde_json::to_vec(&self.header).map_err(|_| "Cannot encode the ownership receipt.")?;
        if header.len() > MAX_HEADER {
            return Err("Ownership receipt header is too large.".into());
        }
        let mut bytes = Vec::new();
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&header);
        if let Some(before) = &self.before {
            bytes.extend_from_slice(before);
        }
        bytes.extend_from_slice(&self.after);
        if bytes.len() > MAX_RECEIPT {
            return Err("Ownership receipt exceeds 3 MiB.".into());
        }
        Ok(bytes)
    }

    fn decode(bytes: &[u8], agent: Agent, path: &Path) -> Result<Self, String> {
        let invalid =
            || "The agent ownership receipt is invalid; no configuration was changed.".to_string();
        if bytes.len() < 12 || bytes.len() > MAX_RECEIPT || &bytes[..8] != MAGIC {
            return Err(invalid());
        }
        let size = u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| invalid())?) as usize;
        if size > MAX_HEADER || 12 + size > bytes.len() {
            return Err(invalid());
        }
        let header: Header =
            serde_json::from_slice(&bytes[12..12 + size]).map_err(|_| invalid())?;
        if header.version != 1
            || header.agent_id != agent.id()
            || header.config_path != path
            || header.before_len.is_some_and(|len| len > MAX_CONFIG)
            || header.after_len > MAX_CONFIG
            || header.before_len.is_some() != header.backup_name.is_some()
        {
            return Err(invalid());
        }
        let before_len = header.before_len.unwrap_or(0);
        let start = 12 + size;
        if start + before_len + header.after_len != bytes.len() {
            return Err(invalid());
        }
        let before = header
            .before_len
            .map(|_| bytes[start..start + before_len].to_vec());
        let after = bytes[start + before_len..].to_vec();
        let receipt = Self {
            header,
            before,
            after,
        };
        receipt.backup_path(path)?;
        // Do not trust a receipt that would restore unrelated, arbitrary bytes.
        // Its installed bytes must be exactly a valid merge of its original bytes.
        let value = parse_config(&receipt.after).map_err(|_| invalid())?;
        let entry = value
            .get(agent.key())
            .and_then(|v| v.get("uigrep"))
            .ok_or_else(invalid)?;
        let command = entry
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if agent.entry(Path::new(command)).map_err(|_| invalid())? != *entry
            || merge_config(agent, receipt.before.as_deref(), entry).map_err(|_| invalid())?
                != receipt.after
        {
            return Err(invalid());
        }
        Ok(receipt)
    }

    fn backup_path(&self, expected_config: &Path) -> Result<Option<PathBuf>, String> {
        if self.header.config_path != expected_config {
            return Err("Receipt configuration path does not match this agent.".into());
        }
        self.header
            .backup_name
            .as_deref()
            .map(|name| {
                let id = name
                    .strip_prefix(".mcp.json.uigrep-")
                    .and_then(|v| v.strip_suffix(".bak"))
                    .ok_or("Receipt backup name is invalid.")?;
                let uuid = Uuid::parse_str(id).map_err(|_| "Receipt backup name is invalid.")?;
                if uuid.to_string() != id {
                    return Err("Receipt backup name is invalid.".into());
                }
                // Only a generated basename is accepted, never an arbitrary stored path.
                Ok(parent(expected_config)?.join(format!(".mcp.json.uigrep-{uuid}.bak")))
            })
            .transpose()
    }

    fn validate_backup(&self, path: &Path) -> Result<(), String> {
        if let Some(backup) = self.backup_path(path)? {
            if read_bounded(&backup, MAX_CONFIG)? != self.before {
                return Err("The original configuration backup is missing or changed; no configuration was changed.".into());
            }
        }
        Ok(())
    }
}

fn load_receipt(
    agent: Agent,
    path: &Path,
    receipt_path: &Path,
) -> Result<Option<(Receipt, Vec<u8>)>, String> {
    read_bounded(receipt_path, MAX_RECEIPT)?
        .map(|bytes| {
            let receipt = Receipt::decode(&bytes, agent, path)?;
            receipt.validate_backup(path)?;
            Ok((receipt, bytes))
        })
        .transpose()
}

fn write_phase(
    receipt: &mut Receipt,
    path: &Path,
    bytes: &mut Vec<u8>,
    phase: Phase,
) -> Result<(), String> {
    let mut updated = receipt.clone();
    updated.header.phase = phase;
    let next = updated.encode()?;
    replace_checked(path, Some(bytes), Some(&next), MAX_RECEIPT)?;
    *receipt = updated;
    *bytes = next;
    Ok(())
}

fn undo_install(path: &Path, receipt: &Receipt) -> Result<(), String> {
    let current = read_bounded(path, MAX_CONFIG)?;
    if current.as_deref() == receipt.before.as_deref() {
        return Ok(());
    }
    replace_checked(
        path,
        Some(&receipt.after),
        receipt.before.as_deref(),
        MAX_CONFIG,
    )
}

fn install(
    agent: Agent,
    path: &Path,
    receipt_path: &Path,
    entry: &Value,
    mark: impl FnOnce() -> Result<(), String>,
) -> Result<Receipt, String> {
    let existing = load_receipt(agent, path, receipt_path)?;
    let current = read_bounded(path, MAX_CONFIG)?;
    let (mut receipt, mut receipt_bytes) = if let Some((receipt, bytes)) = existing {
        if receipt.header.phase == Phase::Restoring {
            return Err(
                "A restore was interrupted. Click Restore again before configuring this agent."
                    .into(),
            );
        }
        if current.as_deref() == Some(receipt.after.as_slice()) {
            // Also refuses silently updating an owned entry from a different executable.
            merge_config(agent, current.as_deref(), entry)?;
            if receipt.header.phase == Phase::Installed {
                mark()?;
                return Ok(receipt);
            }
        } else if receipt.header.phase != Phase::Prepared || current != receipt.before {
            return Err(CHANGED.into());
        }
        if merge_config(agent, receipt.before.as_deref(), entry)? != receipt.after {
            return Err("The pending installation belongs to a different uigrep executable. Restore it first.".into());
        }
        (receipt, bytes)
    } else {
        let after = merge_config(agent, current.as_deref(), entry)?;
        let receipt = Receipt {
            header: Header {
                version: 1,
                agent_id: agent.id().into(),
                config_path: path.to_path_buf(),
                backup_name: current
                    .as_ref()
                    .map(|_| format!(".mcp.json.uigrep-{}.bak", Uuid::new_v4())),
                before_len: current.as_ref().map(Vec::len),
                after_len: after.len(),
                phase: Phase::Prepared,
            },
            before: current,
            after,
        };
        let bytes = receipt.encode()?;
        ensure_directory(parent(path)?)?;
        ensure_directory(parent(receipt_path)?)?;
        if let (Some(backup), Some(before)) = (receipt.backup_path(path)?, &receipt.before) {
            create_new_file(&backup, before)?;
        }
        // The write-ahead receipt must be durable before the client is touched.
        replace_checked(receipt_path, None, Some(&bytes), MAX_RECEIPT)?;
        (receipt, bytes)
    };

    let result = (|| {
        let current = read_bounded(path, MAX_CONFIG)?;
        if current.as_deref() != Some(receipt.after.as_slice()) {
            replace_checked(
                path,
                receipt.before.as_deref(),
                Some(&receipt.after),
                MAX_CONFIG,
            )?;
        }
        write_phase(
            &mut receipt,
            receipt_path,
            &mut receipt_bytes,
            Phase::Installed,
        )?;
        mark()
    })();
    if result.is_err() {
        // A concurrent edit is never rolled back. Keep its recovery evidence.
        if undo_install(path, &receipt).is_err() {
            return Err("Setup could not finish, and automatic rollback was unsafe or failed. The receipt and backup were retained; no intervening edits were overwritten.".into());
        }
        // A flush failure can occur after a receipt rename. Reload its exact,
        // validated bytes rather than discarding recovery metadata blindly.
        let cleanup = load_receipt(agent, path, receipt_path).and_then(|loaded| {
            let (_, bytes) = loaded.ok_or("Ownership receipt disappeared during rollback.")?;
            replace_checked(receipt_path, Some(&bytes), None, MAX_RECEIPT)
        });
        if cleanup.is_err() {
            return Err("Setup could not finish. The original configuration was restored, but recovery metadata could not be removed.".into());
        }
        return Err("Setup could not finish. The original configuration was restored; any backup was retained.".into());
    }
    Ok(receipt)
}

fn restore(
    agent: Agent,
    path: &Path,
    receipt_path: &Path,
    clear: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let (mut receipt, mut bytes) = load_receipt(agent, path, receipt_path)?
        .ok_or("No uigrep-owned configuration receipt exists for this agent.")?;
    let current = read_bounded(path, MAX_CONFIG)?;
    let interrupted = matches!(receipt.header.phase, Phase::Restoring | Phase::Prepared)
        && current == receipt.before;
    if current.as_deref() != Some(receipt.after.as_slice()) && !interrupted {
        return Err(CHANGED.into());
    }
    let previous_phase = receipt.header.phase;
    write_phase(&mut receipt, receipt_path, &mut bytes, Phase::Restoring)?;
    undo_install(path, &receipt)?;
    if clear().is_err() {
        // Compensate for a failed database commit only if the restored bytes have
        // not subsequently changed. Keep the journal for retry in either case.
        if replace_checked(
            path,
            receipt.before.as_deref(),
            current.as_deref(),
            MAX_CONFIG,
        )
        .is_ok()
        {
            let _ = write_phase(&mut receipt, receipt_path, &mut bytes, previous_phase);
        }
        return Err("Could not save restore status. Recovery metadata was retained; retry Restore. Intervening edits will not be overwritten.".into());
    }
    replace_checked(receipt_path, Some(&bytes), None, MAX_RECEIPT)?;
    // Backups are intentionally retained in the client's directory for manual recovery.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox {
        root: PathBuf,
        config: PathBuf,
        receipt: PathBuf,
    }
    impl Sandbox {
        fn new() -> Self {
            // Canonicalize the temp root because macOS /var itself is a symlink.
            let root = fs::canonicalize(env::temp_dir())
                .unwrap()
                .join(format!("uigrep-agents-{}", Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self {
                config: root.join("client/mcp.json"),
                receipt: root.join("app/agent-vscode.receipt"),
                root,
            }
        }
        fn seed(&self, bytes: &[u8]) {
            ensure_directory(parent(&self.config).unwrap()).unwrap();
            fs::write(&self.config, bytes).unwrap();
        }
        fn install(&self) -> Receipt {
            install(
                Agent::Vscode,
                &self.config,
                &self.receipt,
                &entry(Agent::Vscode),
                || Ok(()),
            )
            .unwrap()
        }
        fn restore(&self) -> Result<(), String> {
            restore(Agent::Vscode, &self.config, &self.receipt, || Ok(()))
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn entry(agent: Agent) -> Value {
        agent.entry(&env::current_exe().unwrap()).unwrap()
    }

    #[test]
    fn merges_both_formats_preserving_unknown_fields() {
        for agent in [Agent::Vscode, Agent::Cursor] {
            let mut original = json!({"inputs":[{"id":"secret","type":"promptString"}], "unknown":{"nested":[1,true,null]}});
            original[agent.key()] = json!({"other":{"command":"custom", "env":{"KEEP":"yes"}}});
            let bytes = serde_json::to_vec(&original).unwrap();
            let installed = merge_config(agent, Some(&bytes), &entry(agent)).unwrap();
            let mut merged: Value = serde_json::from_slice(&installed).unwrap();
            let server = merged[agent.key()]
                .as_object_mut()
                .unwrap()
                .remove("uigrep")
                .unwrap();
            assert_eq!(merged, original);
            assert_eq!(server["args"], json!(["--mcp"]));
            assert!(Path::new(server["command"].as_str().unwrap()).is_absolute());
            assert!(server.get("cwd").is_none());
            assert!(server.get("env").is_none());
            assert_eq!(server.get("type").is_some(), agent == Agent::Vscode);
        }
    }

    #[test]
    fn refuses_conflicts_and_invalid_structures() {
        for input in [
            r#"{"servers":{"uigrep":{"command":"other"}}}"#,
            r#"{"servers":{"uigrep":null}}"#,
            r#"{"servers":[]}"#,
            r#"{"servers":null}"#,
            "[]",
            "null",
            "",
            "{broken",
            "{\"servers\":{},}",
            "{// comment\n}",
        ] {
            assert!(
                merge_config(Agent::Vscode, Some(input.as_bytes()), &entry(Agent::Vscode)).is_err()
            );
        }
        let error = parse_config(b"{ /* private contents */ }").unwrap_err();
        assert!(error.contains("JSONC"));
        assert!(!error.contains("private contents"));
        assert!(Agent::from_id("../../other").is_err());
    }

    #[test]
    fn matching_unowned_entry_is_preserved_byte_for_byte() {
        let s = Sandbox::new();
        let original = format!(
            "  {{\"servers\":{{\"uigrep\":{}}},\"other\":true}}\r\n",
            entry(Agent::Vscode)
        );
        s.seed(original.as_bytes());
        s.install();
        assert_eq!(fs::read(&s.config).unwrap(), original.as_bytes());
        s.restore().unwrap();
        assert_eq!(fs::read(&s.config).unwrap(), original.as_bytes());
    }

    #[test]
    fn owned_rerun_reuses_receipt_and_exact_backup_then_restores() {
        let s = Sandbox::new();
        let original = b" { \"unknown\" : [1, 2], \"servers\": {} }\r\n";
        s.seed(original);
        let first = s.install();
        let receipt_bytes = fs::read(&s.receipt).unwrap();
        let second = s.install();
        assert_eq!(first.header.backup_name, second.header.backup_name);
        assert_eq!(fs::read(&s.receipt).unwrap(), receipt_bytes);
        let backup = first.backup_path(&s.config).unwrap().unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original);
        s.restore().unwrap();
        assert_eq!(fs::read(&s.config).unwrap(), original);
        assert!(!s.receipt.exists());
        assert!(backup.exists());
    }

    #[test]
    fn new_config_restore_removes_only_unchanged_file() {
        let s = Sandbox::new();
        let owned = s.install();
        assert!(owned.before.is_none());
        assert!(owned.header.backup_name.is_none());
        s.restore().unwrap();
        assert!(!s.config.exists());
        assert!(s.config.parent().unwrap().is_dir());
    }

    #[test]
    fn edited_configs_cannot_be_restored_or_reconfigured() {
        for existed in [false, true] {
            let s = Sandbox::new();
            if existed {
                s.seed(b"{}");
            }
            let installed = s.install();
            let mut edited = installed.after.clone();
            edited.extend_from_slice(b" \n"); // Even whitespace edits are owned by the user.
            fs::write(&s.config, &edited).unwrap();
            assert!(s.restore().is_err());
            assert!(install(
                Agent::Vscode,
                &s.config,
                &s.receipt,
                &entry(Agent::Vscode),
                || Ok(())
            )
            .is_err());
            assert_eq!(fs::read(&s.config).unwrap(), edited);
            assert!(s.receipt.exists());
        }
    }

    #[test]
    fn failed_mark_rolls_back_new_and_existing_configs() {
        for existed in [false, true] {
            let s = Sandbox::new();
            if existed {
                s.seed(b"{ \"other\": true }");
            }
            let original = read_bounded(&s.config, MAX_CONFIG).unwrap();
            let result = install(
                Agent::Vscode,
                &s.config,
                &s.receipt,
                &entry(Agent::Vscode),
                || Err("private database error".into()),
            );
            assert!(result.is_err());
            assert!(!result.err().unwrap().contains("private database error"));
            assert_eq!(read_bounded(&s.config, MAX_CONFIG).unwrap(), original);
            assert!(!s.receipt.exists());
        }
    }

    #[test]
    fn failed_mark_does_not_clobber_intervening_edit() {
        let s = Sandbox::new();
        let result = install(
            Agent::Vscode,
            &s.config,
            &s.receipt,
            &entry(Agent::Vscode),
            || {
                fs::write(&s.config, b"{\"userEdit\":true}").unwrap();
                Err("mark failed".into())
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&s.config).unwrap(), b"{\"userEdit\":true}");
        assert!(s.receipt.exists());
    }

    #[test]
    fn failed_clear_reinstalls_only_unchanged_restored_config() {
        for edit in [false, true] {
            let s = Sandbox::new();
            s.seed(b"{}");
            let installed = s.install();
            assert!(restore(Agent::Vscode, &s.config, &s.receipt, || {
                if edit {
                    fs::write(&s.config, b"{\"newEdit\":true}").unwrap();
                }
                Err("clear failed".into())
            })
            .is_err());
            if edit {
                assert_eq!(fs::read(&s.config).unwrap(), b"{\"newEdit\":true}");
                assert!(s.restore().is_err());
            } else {
                assert_eq!(fs::read(&s.config).unwrap(), installed.after);
                s.restore().unwrap();
            }
        }
    }

    #[test]
    fn changed_or_missing_backup_refuses_restore() {
        let s = Sandbox::new();
        s.seed(b"{}");
        let installed = s.install();
        let backup = installed.backup_path(&s.config).unwrap().unwrap();
        fs::write(&backup, b"{\"tampered\":true}").unwrap();
        assert!(s.restore().is_err());
        fs::remove_file(&backup).unwrap();
        assert!(s.restore().is_err());
        assert_eq!(fs::read(&s.config).unwrap(), installed.after);
    }

    #[test]
    fn receipt_rejects_arbitrary_paths_lengths_and_payloads() {
        let s = Sandbox::new();
        s.seed(b"{}");
        let original = s.install();
        for name in [
            "../victim",
            "/tmp/victim",
            "C:\\victim",
            ".mcp.json.uigrep-../victim.bak",
            ".mcp.json.uigrep-not-a-uuid.bak",
        ] {
            let mut bad = original.clone();
            bad.header.backup_name = Some(name.into());
            assert!(Receipt::decode(&bad.encode().unwrap(), Agent::Vscode, &s.config).is_err());
        }
        let mut bad = original.clone();
        bad.header.config_path = s.root.join("victim");
        assert!(Receipt::decode(&bad.encode().unwrap(), Agent::Vscode, &s.config).is_err());
        let mut bad = original.clone();
        bad.header.before_len = Some(usize::MAX);
        assert!(Receipt::decode(&bad.encode().unwrap(), Agent::Vscode, &s.config).is_err());
        let mut bad = original.clone();
        bad.before = Some(b"{\"unrelated\":true}".to_vec());
        bad.header.before_len = bad.before.as_ref().map(Vec::len);
        assert!(Receipt::decode(&bad.encode().unwrap(), Agent::Vscode, &s.config).is_err());
        let bytes = original.encode().unwrap();
        for len in [0, 7, 11, 12, bytes.len() - 1] {
            assert!(Receipt::decode(&bytes[..len], Agent::Vscode, &s.config).is_err());
        }
    }

    #[test]
    fn size_limits_are_bounded_without_byte_array_expansion() {
        assert!(parse_config(&vec![b' '; MAX_CONFIG + 1]).is_err());
        let s = Sandbox::new();
        let mut original = vec![b' '; MAX_CONFIG - 2];
        original.extend_from_slice(b"{}");
        s.seed(&original);
        let receipt = s.install();
        assert!(receipt.encode().unwrap().len() < MAX_RECEIPT);
        s.restore().unwrap();
        assert_eq!(fs::read(&s.config).unwrap(), original);
        fs::write(&s.receipt, vec![0; MAX_RECEIPT + 1]).unwrap();
        assert!(read_bounded(&s.receipt, MAX_RECEIPT).is_err());
        s.seed(&vec![b' '; MAX_CONFIG + 1]);
        assert!(read_bounded(&s.config, MAX_CONFIG).is_err());
    }

    #[test]
    fn nonregular_targets_and_ancestors_are_rejected() {
        let s = Sandbox::new();
        ensure_directory(&s.config).unwrap();
        assert!(read_bounded(&s.config, MAX_CONFIG).is_err());
        let other = s.root.join("not-a-directory");
        fs::write(&other, b"x").unwrap();
        assert!(read_bounded(&other.join("mcp.json"), MAX_CONFIG).is_err());
        assert!(validate_absolute(Path::new("relative/mcp.json")).is_err());
        assert!(validate_absolute(&s.root.join("../mcp.json")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_targets_and_ancestors_are_rejected() {
        use std::os::unix::fs::symlink;
        let s = Sandbox::new();
        let target = s.root.join("real");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("mcp.json"), b"{}").unwrap();
        symlink(&target, s.config.parent().unwrap()).unwrap();
        assert!(read_bounded(&s.config, MAX_CONFIG).is_err());
        fs::remove_file(s.config.parent().unwrap()).unwrap();
        fs::create_dir(s.config.parent().unwrap()).unwrap();
        symlink(target.join("mcp.json"), &s.config).unwrap();
        assert!(read_bounded(&s.config, MAX_CONFIG).is_err());
        fs::remove_file(&s.config).unwrap();
        symlink(target.join("missing"), &s.config).unwrap();
        assert!(read_bounded(&s.config, MAX_CONFIG).is_err());
    }

    #[test]
    fn atomic_rename_replaces_existing_destination_including_windows() {
        let s = Sandbox::new();
        s.seed(b"before");
        replace_checked(&s.config, Some(b"before"), Some(b"after"), MAX_CONFIG).unwrap();
        assert_eq!(fs::read(&s.config).unwrap(), b"after");
        assert!(replace_checked(&s.config, Some(b"before"), Some(b"clobber"), MAX_CONFIG).is_err());
        assert_eq!(fs::read(&s.config).unwrap(), b"after");
    }

    #[test]
    fn exclusive_creation_never_overwrites_backup() {
        let s = Sandbox::new();
        s.seed(b"original");
        assert!(create_new_file(&s.config, b"overwrite").is_err());
        assert_eq!(fs::read(&s.config).unwrap(), b"original");
    }

    #[test]
    fn interrupted_prepared_install_and_restore_are_recoverable() {
        for already_written in [false, true] {
            let s = Sandbox::new();
            s.seed(b"{}");
            let mut owned = s.install();
            owned.header.phase = Phase::Prepared;
            fs::write(&s.receipt, owned.encode().unwrap()).unwrap();
            if !already_written {
                fs::write(&s.config, owned.before.as_ref().unwrap()).unwrap();
            }
            s.install();
            owned.header.phase = Phase::Restoring;
            fs::write(&s.receipt, owned.encode().unwrap()).unwrap();
            fs::write(&s.config, owned.before.as_ref().unwrap()).unwrap();
            s.restore().unwrap();
            assert_eq!(fs::read(&s.config).unwrap(), b"{}");
            assert!(!s.receipt.exists());
        }
    }
}
