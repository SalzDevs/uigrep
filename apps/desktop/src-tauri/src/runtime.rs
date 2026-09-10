//! Headless MCP routing; never constructs a Tauri application.
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};

pub fn runtime_dir() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime"));
    }
    let info = tauri::utils::PackageInfo {
        name: env!("CARGO_PKG_NAME").into(),
        version: env!("CARGO_PKG_VERSION")
            .parse()
            .map_err(|_| "Invalid package version")?,
        authors: env!("CARGO_PKG_AUTHORS"),
        description: env!("CARGO_PKG_DESCRIPTION"),
        crate_name: env!("CARGO_PKG_NAME"),
    };
    // Tauri resolves Windows exe-relative, macOS ../Resources, and Linux
    // AppImage APPDIR / installed /usr/lib/<package> resources.
    tauri::utils::platform::resource_dir(&info, &tauri::Env::default())
        .map(|dir| dir.join("runtime"))
        .map_err(|_| "Cannot locate the installed uigrep runtime.".into())
}

pub fn run_mcp() -> Result<i32, String> {
    let dir = runtime_dir()?;
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let script = dir.join("mcp.cjs");
    if !node.is_file() || !script.is_file() {
        return Err(
            "Private runtime is missing. Reinstall uigrep (developers: prepare the runtime)."
                .into(),
        );
    }
    let status = Command::new(node)
        .arg(script)
        // The agent owns cwd. Ignore injection into the private Node process.
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|_| "Could not launch the private uigrep runtime.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        Ok(status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
    }
    #[cfg(not(unix))]
    Ok(status.code().unwrap_or(1))
}
