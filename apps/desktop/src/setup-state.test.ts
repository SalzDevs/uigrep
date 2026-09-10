import { describe, expect, it } from "vitest";
import { canFinish, type SetupStatus } from "./setup-state";

const initial: SetupStatus = {
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

describe("one-click setup gate", () => {
  it("needs daemon, paired browser and configured agent", () => {
    expect(canFinish(initial)).toBe(false);
    const paired = {
      ...initial,
      pairedBrowsers: [{ id: "browser", name: "Chrome" }],
    };
    expect(canFinish(paired)).toBe(false);
    expect(canFinish({ ...paired, agentConfigured: true })).toBe(true);
    expect(
      canFinish({ ...paired, agentConfigured: true, daemonReady: false }),
    ).toBe(false);
    expect(
      canFinish({ ...paired, agentConfigured: true, pairedBrowsers: [] }),
    ).toBe(false);
  });

  it("capture and MCP verification are optional", () => {
    const paired = {
      ...initial,
      pairedBrowsers: [{ id: "browser", name: "Chrome" }],
      agentConfigured: true,
    };
    expect(canFinish({ ...paired, testCaptureId: null })).toBe(true);
    expect(canFinish({ ...paired, mcpVerified: false })).toBe(true);
  });
});
