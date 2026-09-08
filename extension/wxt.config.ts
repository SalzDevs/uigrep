import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "uigrep",
    description: "Grep your UI — point at what's wrong, an agent fixes it.",
    permissions: ["activeTab", "storage"],
    host_permissions: ["<all_urls>"],
    commands: {
      "toggle-pick": {
        suggested_key: { default: "Alt+Shift+U" },
        description: "Toggle uigrep element picking",
      },
      "toggle-panel": {
        suggested_key: { default: "Alt+Shift+P" },
        description: "Toggle uigrep review queue",
      },
    },
    icons: {},
  },
});
