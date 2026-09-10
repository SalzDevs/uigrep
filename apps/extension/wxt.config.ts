import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "uigrep companion",
    description: "Select and annotate UI regions for local coding agents.",
    permissions: ["activeTab", "storage", "alarms"],
    host_permissions: ["http://127.0.0.1:47831/*"],
    commands: {
      "start-capture": {
        suggested_key: {
          default: "Alt+Shift+G",
          mac: "Alt+Shift+G",
        },
        description: "Start a uigrep capture session",
      },
    },
    browser_specific_settings: {
      gecko: {
        id: "companion@uigrep.dev",
        strict_min_version: "128.0",
      },
    },
  },
});
