# Browser integration tests

Run from the repository root with `pnpm exec playwright test`.

## Prerequisites

- Install root development dependency `@playwright/test` (the parent task owns dependency installation).
- Install its matching Chromium browser with `pnpm exec playwright install chromium`. Use full Chromium, not only the headless shell: extension loading needs `channel: 'chromium'`.
- Install the existing workspace dependencies and build the actual companion with `pnpm --filter @uigrep/extension build` before running. Tests intentionally do not build or modify extension sources.
- Leave **127.0.0.1:47831 free**. If the desktop daemon or another test owns it, the extension test fails explicitly. It never kills that process or sends requests to it. Stop it manually before retrying.

The [configuration](../playwright.config.ts) starts the desktop **Vite frontend only** at http://localhost:1420 with `pnpm --filter @uigrep/desktop dev --host localhost`. Locally it may reuse an existing frontend; CI starts its own. Tests use one worker, no full parallelism and no retries because the companion's daemon port is fixed. Do not run multiple copies concurrently or override the worker count.

## What these tests establish

- [Onboarding UI tests](onboarding.spec.ts) load the real React Setup frontend with `page.addInitScript` replacing Tauri internals. They cover unavailable store listing, offline installation gating, pending browser approval, explicit agent configuration consent and displayed path, Continue later/window-hide IPC, simulated capture arrival, the MCP verification completion gate, and reload/resume. Session storage preserves the **simulated** status across reloads within an isolated browser context.
- [Companion integration test](extension.spec.ts) loads the actual built MV3 extension in a fresh temporary Chromium profile. Its actual background worker auto-requests pairing, options displays pending approval, and claim polling stores a browser credential only after the mock grants approval. The real content script receives `start-capture` through `chrome.tabs.sendMessage`, collects a mouse-drag selection and comment through its unmodified closed-shadow overlay, and sends via Control+Enter. The mock validates authentication and the shared capture schema; assertions cover page URL/origin, drag bounds, comment and the practice card's `testId` target.

**These are not native desktop tests or real-backend end-to-end tests.** No Rust/Tauri process, native window hiding, OS shortcut, store installation, real pairing approval, config backup/write, agent client, or MCP retrieval is exercised. The onboarding IPC mock reports configuration success without touching any client configuration. The companion uses a mock HTTP daemon, not the real bridge. Its `/v1/events` WebSocket upgrade is deliberately rejected: HTTP pairing/capture work independently, but daemon-triggered activation, connected badges, heartbeat and reconnect success are not verified. No direct `ws` or Chrome typings dependency is needed.

## Isolation and evidence

No real VS Code/Cursor config or normal browser profile is read or modified. Files created at runtime are limited to browser-test artifacts, the disposable Chromium profile and normal Vite caches. The mock binds loopback only, grants CORS only to syntactically valid Chrome extension origins, binds pairing/capture to the requesting extension origin, and caps JSON bodies (4 KiB pairing, 8 MiB captures). Credentials remain in test-process/temporary-profile memory and are never logged or returned by storage assertions. Traces and videos are disabled to avoid retaining credential-bearing network traffic. The test closes its own browser and server and removes its temporary profile in `finally`.

Successful tests save a simulated-ready onboarding screenshot and a real-overlay/mock-daemon screenshot under Playwright's test-specific output directories. Default page fixtures also retain failure screenshots. Screenshots are visual evidence of browser behavior, **not proof of native setup or MCP execution**.

The parent task must also include these new tests in its lint/typecheck setup if required: the current ESLint project service excludes files outside existing package TypeScript projects. No lint settings, package manifests, lockfiles or application sources are changed by this four-file addition. Playwright transpiles TypeScript for execution; it is not a typechecker.