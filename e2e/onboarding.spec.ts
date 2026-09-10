import { expect, test, type Page } from "@playwright/test";
import type { AgentOption, SetupStatus } from "../apps/desktop/src/setup-state";

type CommandCall = { command: string; args: Record<string, unknown> };
type SimulatedSetup = {
  status: SetupStatus;
  calls: CommandCall[];
  patch: (next: Partial<SetupStatus>) => void;
};

declare global {
  interface Window {
    __onboardingMock: SimulatedSetup;
  }
}

const initialStatus: SetupStatus = {
  daemonReady: true,
  pairedBrowsers: [],
  pendingPairings: [],
  agentConfigured: false,
  testCaptureId: null,
  mcpVerified: false,
  completed: false,
  storeUrl: null,
  developmentMode: true,
  error: null,
};
const configPath = "C:\\simulated-client\\Code\\User\\mcp.json";
const agents: AgentOption[] = [
  { id: "vscode", name: "VS Code", configPath, available: true },
  {
    id: "cursor",
    name: "Cursor",
    configPath: "C:\\simulated-client\\Cursor\\mcp.json",
    available: false,
  },
];

async function installNativeSimulation(page: Page): Promise<void> {
  await page.addInitScript(
    ({ initialStatus, agents }) => {
      // This runs before the actual React frontend, including after reload.
      // Storage is isolated to this test's browser context, not a client file.
      const key = "uigrep-e2e-simulated-setup";
      const saved = sessionStorage.getItem(key);
      const restored = saved
        ? (JSON.parse(saved) as Pick<SimulatedSetup, "status" | "calls">)
        : { status: initialStatus, calls: [] };
      const persist = () => {
        sessionStorage.setItem(
          key,
          JSON.stringify({ status: mock.status, calls: mock.calls }),
        );
      };
      const mock: SimulatedSetup = {
        ...restored,
        patch(next) {
          Object.assign(mock.status, next);
          persist();
        },
      };
      window.__onboardingMock = mock;
      let callbackId = 0;
      const callbacks = new Map<number, (payload: unknown) => void>();
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "setup" },
            currentWebview: { label: "setup" },
          },
          transformCallback(
            callback?: (payload: unknown) => void,
            once = false,
          ) {
            const id = ++callbackId;
            callbacks.set(id, (payload) => {
              if (once) callbacks.delete(id);
              callback?.(payload);
            });
            return id;
          },
          unregisterCallback(id: number) {
            callbacks.delete(id);
          },
          runCallback(id: number, payload: unknown) {
            callbacks.get(id)?.(payload);
          },
          invoke(command: string, args: Record<string, unknown> = {}) {
            mock.calls.push({ command, args });
            persist();
            switch (command) {
              case "setup_status":
                return Promise.resolve(structuredClone(mock.status));
              case "agent_options":
                return Promise.resolve(structuredClone(agents));
              case "approve_pairing": {
                const request = mock.status.pendingPairings.find(
                  (item) => item.id === args.requestId,
                );
                if (!request)
                  return Promise.reject(new Error("No pending request"));
                mock.patch({
                  pendingPairings: [],
                  pairedBrowsers: [{ id: request.id, name: request.name }],
                });
                return Promise.resolve(structuredClone(mock.status));
              }
              case "configure_agent": {
                const agent = agents.find((item) => item.id === args.agentId);
                if (!agent) return Promise.reject(new Error("Unknown agent"));
                mock.patch({ agentConfigured: true });
                return Promise.resolve({
                  agentId: agent.id,
                  configPath: agent.configPath,
                  message:
                    "Simulated only; no client configuration was written.",
                });
              }
              case "open_test_capture":
                mock.patch({ testCaptureId: null, mcpVerified: false });
                return Promise.resolve(structuredClone(mock.status));
              case "finish_setup":
                if (
                  !mock.status.daemonReady ||
                  !mock.status.pairedBrowsers.length ||
                  !mock.status.agentConfigured ||
                  !mock.status.testCaptureId ||
                  !mock.status.mcpVerified
                )
                  return Promise.reject(
                    new Error("Verification is incomplete"),
                  );
                mock.patch({ completed: true });
                return Promise.resolve(structuredClone(mock.status));
              case "plugin:window|hide":
                return Promise.resolve();
              default:
                return Promise.reject(
                  new Error(`Unexpected simulated command: ${command}`),
                );
            }
          },
        },
      });
    },
    { initialStatus, agents },
  );
}

async function patchStatus(
  page: Page,
  next: Partial<SetupStatus>,
): Promise<void> {
  await page.evaluate((patch) => window.__onboardingMock.patch(patch), next);
}

async function callsFor(page: Page, command: string): Promise<CommandCall[]> {
  return page.evaluate(
    (name) =>
      window.__onboardingMock.calls.filter((call) => call.command === name),
    command,
  );
}

test.describe("Onboarding UI — simulated native IPC, not native tests", () => {
  test.beforeEach(async ({ page }) => {
    await installNativeSimulation(page);
    await page.goto("/?view=setup");
  });

  test("no published listing cannot launch installation or advance", async ({
    page,
  }) => {
    await expect(
      page.getByText("This build has no published Chrome listing configured.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Chrome Web Store" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Choose agent" }),
    ).toBeDisabled();
    expect(await callsFor(page, "begin_browser_setup")).toHaveLength(0);
    expect(await callsFor(page, "configure_agent")).toHaveLength(0);

    await patchStatus(page, {
      daemonReady: false,
      storeUrl: "https://chromewebstore.google.com/",
    });
    await expect(
      page.getByText("Connecting to desktop…", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Chrome Web Store" }),
    ).toBeDisabled();
  });

  test("explicit approvals, resume, capture receipt and MCP verification gate completion", async ({
    page,
  }, testInfo) => {
    const requestId = "a612e0f1-5815-4de2-9c02-aa1469d34ca2";
    const origin = `chrome-extension://${"a".repeat(32)}`;
    await patchStatus(page, {
      pendingPairings: [{ id: requestId, name: "Chrome", origin }],
    });
    await expect(
      page.getByRole("heading", { name: "Approve Chrome?" }),
    ).toBeVisible();
    await expect(page.getByText(origin, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Choose agent" }),
    ).toBeDisabled();
    expect(await callsFor(page, "approve_pairing")).toHaveLength(0);
    await page
      .getByRole("button", { name: "Approve browser", exact: true })
      .click();
    expect(await callsFor(page, "approve_pairing")).toEqual([
      { command: "approve_pairing", args: { requestId } },
    ]);

    await expect(
      page.getByRole("heading", { name: "Choose your coding agent." }),
    ).toBeVisible();
    await expect(page.getByText(configPath, { exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: /VS Code/ })).toBeChecked();
    expect(await callsFor(page, "configure_agent")).toHaveLength(0);
    await page.getByRole("button", { name: "Continue later" }).click();
    await expect
      .poll(() => callsFor(page, "plugin:window|hide"))
      .toHaveLength(1);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Choose your coding agent." }),
    ).toBeVisible();
    expect(await callsFor(page, "configure_agent")).toHaveLength(0);

    await page.getByRole("button", { name: "Approve & connect agent" }).click();
    await expect(
      page.getByRole("heading", { name: "One capture. Real context." }),
    ).toBeVisible();
    expect(await callsFor(page, "configure_agent")).toEqual([
      { command: "configure_agent", args: { agentId: "vscode" } },
    ]);
    await expect(
      page.getByText("Simulated only; no client configuration was written.", {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open test page" }).click();
    await expect
      .poll(() => callsFor(page, "open_test_capture"))
      .toHaveLength(1);
    await expect(
      page.getByText("Waiting for your browser capture", { exact: false }),
    ).toBeVisible();

    const captureId = "ab772b28-08a9-47b8-a4b5-11c5c16b934a";
    await patchStatus(page, { testCaptureId: captureId });
    await expect(
      page.getByText("Browser capture received", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Test prompt to send to your agent" }),
    ).toHaveValue(
      `Use the uigrep MCP tool uigrep_get_capture with sessionId "${captureId}". Summarize the test annotation. This is an installation test; do not edit any project files.`,
    );
    await expect(
      page.getByText("Waiting for the MCP read receipt", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Ready" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Finish setup" }),
    ).toHaveCount(0);
    expect(await callsFor(page, "finish_setup")).toHaveLength(0);

    // Reload must resume the saved-but-not-verified state, not reset or finish it.
    await page.reload();
    await expect(
      page.getByText("Browser capture received", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Ready" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Finish setup" }),
    ).toHaveCount(0);
    await patchStatus(page, { mcpVerified: true });
    await expect(
      page.getByRole("heading", { name: "Point. Explain. Build." }),
    ).toBeVisible();
    expect(await callsFor(page, "finish_setup")).toHaveLength(0);
    await page.screenshot({
      path: testInfo.outputPath("onboarding-simulated-ready.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__onboardingMock.status.completed))
      .toBe(true);
    expect(await callsFor(page, "finish_setup")).toHaveLength(1);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Point. Explain. Build." }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.__onboardingMock.status.completed),
    ).toBe(true);
    expect(await callsFor(page, "configure_agent")).toHaveLength(1);
  });
});
