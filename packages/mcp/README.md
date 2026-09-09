# @uigrep/mcp

Generic local MCP adapter for uigrep. The harness launches this process from its own workspace, so that workspace remains the authoritative codebase root.

The adapter reads the local pairing token created by the desktop app or `UIGREP_TOKEN`, connects to the loopback daemon, and exposes compact capture retrieval tools. Deep evidence is opt-in.
