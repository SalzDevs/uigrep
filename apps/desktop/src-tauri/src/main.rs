mod runtime;

fn main() {
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "--mcp") {
        let code = runtime::run_mcp().unwrap_or_else(|error| {
            eprintln!("uigrep MCP: {error}");
            1
        });
        std::process::exit(code);
    }
    uigrep_desktop_lib::run();
}
