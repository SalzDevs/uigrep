import { expect, test, type Page } from "@playwright/test";
import type { AgentOption, SetupStatus } from "../apps/desktop/src/setup-state";

type CommandCall = { command: string; args: Record<string, unknown> };
type SimulatedSetup = {
  status: SetupStatus;
  calls: CommandCall[];
  autoPair: boolean;
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
        ? (JSON.parse(saved) as Pick<
            SimulatedSetup,
            "status" | "calls" | "autoPair"
          >)
        : { status: initialStatus, calls: [], autoPair: false };
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
              case "set_auto_pair":
                mock.autoPair = Boolean(args.enabled);
                return Promise.resolve(structuredClone(mock.status));
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
              case "finish_setup": {
                if (
                  !mock.status.daemonReady ||
                  !mock.status.pairedBrowsers.length ||
                  !mock.status.agentConfigured
                )
                  return Promise.reject(new Error("Setup is incomplete"));
                mock.patch({ completed: true });
                return Promise.resolve(structuredClone(mock.status));
              }
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

test.describe("Onboarding UI — one-click setup, simulated native IPC", () => {
  test.beforeEach(async ({ page }) => {
    await installNativeSimulation(page);
    await page.goto("/?view=setup");
  });

  test("one click configures the agent, approves the browser and finishes", async ({
    page,
  }) => {
    const requestId = "a612e0f1-5815-4de2-9c02-aa1469d34ca2";

    await expect(
      page.getByRole("button", { name: "Set up uigrep" }),
    ).toBeEnabled();
    await expect(
      page.getByText("Waiting — starts when you press Set up"),
    ).toBeVisible(); // agent box
    await expect(
      page.getByText("Waiting — starts after the agent is set up"),
    ).toBeVisible(); // browser box

    await page.getByRole("button", { name: "Set up uigrep" }).click();
    await expect(
      page.getByRole("button", { name: "Setting up…" }),
    ).toBeDisabled();
    // The dev-mode companion hint appears in the browser phase while it waits.
    await expect(
      page.getByText("Dev build: load the unpacked companion", {
        exact: false,
      }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Set up uigrep" }).click();
    await expect(
      page.getByRole("button", { name: "Setting up…" }),
    ).toBeDisabled();
    await expect.poll(() => callsFor(page, "set_auto_pair")).toHaveLength(1);
    expect(await callsFor(page, "set_auto_pair")).toEqual([
      { command: "set_auto_pair", args: { enabled: true } },
    ]);
    await expect.poll(() => callsFor(page, "configure_agent")).toHaveLength(1);
    expect(await callsFor(page, "configure_agent")).toEqual([
      { command: "configure_agent", args: { agentId: "vscode" } },
    ]);

    // The backend (not this UI) approves pairings while armed; the UI only
    // reacts to the resulting paired state.
    await patchStatus(page, {
      pendingPairings: [],
      pairedBrowsers: [{ id: requestId, name: "Chrome" }],
    });
    await expect
      .poll(() => page.evaluate(() => window.__onboardingMock.status.completed))
      .toBe(true);
    expect(await callsFor(page, "finish_setup")).toHaveLength(1);
    expect(await callsFor(page, "approve_pairing")).toHaveLength(0);
  });

  test("incomplete state blocks the button and shows errors", async ({
    page,
  }) => {
    await patchStatus(page, { daemonReady: false });
    await expect(
      page.getByRole("button", { name: "Set up uigrep" }),
    ).toBeDisabled();

    await patchStatus(page, {
      daemonReady: true,
      error: "Cannot run local daemon: port busy.",
    });
    await expect(
      page.getByText("Cannot run local daemon: port busy.", { exact: true }),
    ).toBeVisible();

    await page.reload();
    // State persists across reload; the restored error is still shown.
    await expect(
      page.getByText("Cannot run local daemon: port busy.", { exact: true }),
    ).toBeVisible();
  });

  test("continue later hides the window without finishing", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Continue later" }).click();
    await expect
      .poll(() => callsFor(page, "plugin:window|hide"))
      .toHaveLength(1);
    await expect.poll(() => callsFor(page, "set_auto_pair")).toHaveLength(1);
    expect(await callsFor(page, "set_auto_pair")).toEqual([
      { command: "set_auto_pair", args: { enabled: false } },
    ]);
    expect(await callsFor(page, "configure_agent")).toHaveLength(0);
    expect(
      await page.evaluate(() => window.__onboardingMock.status.completed),
    ).toBe(false);
  });
});
