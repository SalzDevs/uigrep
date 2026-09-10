# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: onboarding.spec.ts >> Onboarding UI — one-click setup, simulated native IPC >> one click configures the agent, approves the browser and finishes
- Location: e2e/onboarding.spec.ts:173:7

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Set up uigrep' })

```

# Page snapshot

```yaml
- main [ref=e4]:
    - generic [ref=e5]:
        - generic [aria-hidden] [ref=e6]: ⌖
        - text: uigrep
    - paragraph [ref=e7]: One click sets everything up. Local only — no account, no cloud.
    - generic [ref=e8]:
        - generic [ref=e9]:
            - generic [aria-hidden] [ref=e10]: ✓
            - generic [ref=e11]:
                - heading "1. Desktop app" [level=2] [ref=e12]
                - paragraph [ref=e13]: Running
        - generic [ref=e14]:
            - generic [aria-hidden] [ref=e15]: ✓
            - generic [ref=e16]:
                - heading "2. Coding agents" [level=2] [ref=e17]
                - paragraph [ref=e18]: Configured
                - paragraph [ref=e19]: VS Code · GitHub Copilot
        - generic [ref=e20]:
            - generic [aria-hidden] [ref=e21]: …
            - generic [ref=e22]:
                - heading "3. Browser companion" [level=2] [ref=e23]
                - paragraph [ref=e24]: Waiting for the browser companion to connect
                - paragraph [ref=e25]: "Dev build: load the unpacked companion — it pairs by itself."
    - button "Setting up…" [disabled] [ref=e26]
    - button "Continue later" [ref=e27] [cursor=pointer]
```

# Test source

```ts
  99  |               case "agent_options":
  100 |                 return Promise.resolve(structuredClone(agents));
  101 |               case "set_auto_pair":
  102 |                 mock.autoPair = Boolean(args.enabled);
  103 |                 return Promise.resolve(structuredClone(mock.status));
  104 |               case "approve_pairing": {
  105 |                 const request = mock.status.pendingPairings.find(
  106 |                   (item) => item.id === args.requestId,
  107 |                 );
  108 |                 if (!request)
  109 |                   return Promise.reject(new Error("No pending request"));
  110 |                 mock.patch({
  111 |                   pendingPairings: [],
  112 |                   pairedBrowsers: [{ id: request.id, name: request.name }],
  113 |                 });
  114 |                 return Promise.resolve(structuredClone(mock.status));
  115 |               }
  116 |               case "configure_agent": {
  117 |                 const agent = agents.find((item) => item.id === args.agentId);
  118 |                 if (!agent) return Promise.reject(new Error("Unknown agent"));
  119 |                 mock.patch({ agentConfigured: true });
  120 |                 return Promise.resolve({
  121 |                   agentId: agent.id,
  122 |                   configPath: agent.configPath,
  123 |                   message:
  124 |                     "Simulated only; no client configuration was written.",
  125 |                 });
  126 |               }
  127 |               case "finish_setup": {
  128 |                 if (
  129 |                   !mock.status.daemonReady ||
  130 |                   !mock.status.pairedBrowsers.length ||
  131 |                   !mock.status.agentConfigured
  132 |                 )
  133 |                   return Promise.reject(new Error("Setup is incomplete"));
  134 |                 mock.patch({ completed: true });
  135 |                 return Promise.resolve(structuredClone(mock.status));
  136 |               }
  137 |               case "plugin:window|hide":
  138 |                 return Promise.resolve();
  139 |               default:
  140 |                 return Promise.reject(
  141 |                   new Error(`Unexpected simulated command: ${command}`),
  142 |                 );
  143 |             }
  144 |           },
  145 |         },
  146 |       });
  147 |     },
  148 |     { initialStatus, agents },
  149 |   );
  150 | }
  151 |
  152 | async function patchStatus(
  153 |   page: Page,
  154 |   next: Partial<SetupStatus>,
  155 | ): Promise<void> {
  156 |   await page.evaluate((patch) => window.__onboardingMock.patch(patch), next);
  157 | }
  158 |
  159 | async function callsFor(page: Page, command: string): Promise<CommandCall[]> {
  160 |   return page.evaluate(
  161 |     (name) =>
  162 |       window.__onboardingMock.calls.filter((call) => call.command === name),
  163 |     command,
  164 |   );
  165 | }
  166 |
  167 | test.describe("Onboarding UI — one-click setup, simulated native IPC", () => {
  168 |   test.beforeEach(async ({ page }) => {
  169 |     await installNativeSimulation(page);
  170 |     await page.goto("/?view=setup");
  171 |   });
  172 |
  173 |   test("one click configures the agent, approves the browser and finishes", async ({
  174 |     page,
  175 |   }) => {
  176 |     const requestId = "a612e0f1-5815-4de2-9c02-aa1469d34ca2";
  177 |
  178 |     await expect(
  179 |       page.getByRole("button", { name: "Set up uigrep" }),
  180 |     ).toBeEnabled();
  181 |     await expect(
  182 |       page.getByText("Waiting — starts when you press Set up"),
  183 |     ).toBeVisible(); // agent box
  184 |     await expect(
  185 |       page.getByText("Waiting — starts after the agent is set up"),
  186 |     ).toBeVisible(); // browser box
  187 |
  188 |     await page.getByRole("button", { name: "Set up uigrep" }).click();
  189 |     await expect(
  190 |       page.getByRole("button", { name: "Setting up…" }),
  191 |     ).toBeDisabled();
  192 |     // The dev-mode companion hint appears in the browser phase while it waits.
  193 |     await expect(
  194 |       page.getByText("Dev build: load the unpacked companion", {
  195 |         exact: false,
  196 |       }),
  197 |     ).toBeVisible();
  198 |
> 199 |     await page.getByRole("button", { name: "Set up uigrep" }).click();
      |                                                               ^ Error: locator.click: Test timeout of 60000ms exceeded.
  200 |     await expect(
  201 |       page.getByRole("button", { name: "Setting up…" }),
  202 |     ).toBeDisabled();
  203 |     await expect.poll(() => callsFor(page, "set_auto_pair")).toHaveLength(1);
  204 |     expect(await callsFor(page, "set_auto_pair")).toEqual([
  205 |       { command: "set_auto_pair", args: { enabled: true } },
  206 |     ]);
  207 |     await expect.poll(() => callsFor(page, "configure_agent")).toHaveLength(1);
  208 |     expect(await callsFor(page, "configure_agent")).toEqual([
  209 |       { command: "configure_agent", args: { agentId: "vscode" } },
  210 |     ]);
  211 |
  212 |     // The backend (not this UI) approves pairings while armed; the UI only
  213 |     // reacts to the resulting paired state.
  214 |     await patchStatus(page, {
  215 |       pendingPairings: [],
  216 |       pairedBrowsers: [{ id: requestId, name: "Chrome" }],
  217 |     });
  218 |     await expect
  219 |       .poll(() => page.evaluate(() => window.__onboardingMock.status.completed))
  220 |       .toBe(true);
  221 |     expect(await callsFor(page, "finish_setup")).toHaveLength(1);
  222 |     expect(await callsFor(page, "approve_pairing")).toHaveLength(0);
  223 |   });
  224 |
  225 |   test("incomplete state blocks the button and shows errors", async ({
  226 |     page,
  227 |   }) => {
  228 |     await patchStatus(page, { daemonReady: false });
  229 |     await expect(
  230 |       page.getByRole("button", { name: "Set up uigrep" }),
  231 |     ).toBeDisabled();
  232 |
  233 |     await patchStatus(page, {
  234 |       daemonReady: true,
  235 |       error: "Cannot run local daemon: port busy.",
  236 |     });
  237 |     await expect(
  238 |       page.getByText("Cannot run local daemon: port busy.", { exact: true }),
  239 |     ).toBeVisible();
  240 |
  241 |     await page.reload();
  242 |     // State persists across reload; the restored error is still shown.
  243 |     await expect(
  244 |       page.getByText("Cannot run local daemon: port busy.", { exact: true }),
  245 |     ).toBeVisible();
  246 |   });
  247 |
  248 |   test("continue later hides the window without finishing", async ({
  249 |     page,
  250 |   }) => {
  251 |     await page.getByRole("button", { name: "Continue later" }).click();
  252 |     await expect
  253 |       .poll(() => callsFor(page, "plugin:window|hide"))
  254 |       .toHaveLength(1);
  255 |     await expect.poll(() => callsFor(page, "set_auto_pair")).toHaveLength(1);
  256 |     expect(await callsFor(page, "set_auto_pair")).toEqual([
  257 |       { command: "set_auto_pair", args: { enabled: false } },
  258 |     ]);
  259 |     expect(await callsFor(page, "configure_agent")).toHaveLength(0);
  260 |     expect(
  261 |       await page.evaluate(() => window.__onboardingMock.status.completed),
  262 |     ).toBe(false);
  263 |   });
  264 | });
  265 |
```
