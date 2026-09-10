import { describe, expect, it } from "vitest";
import {
  canFinish,
  setupStep,
  testPrompt,
  type SetupStatus,
} from "./setup-state";

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

describe("resumable setup steps", () => {
  it("requires a paired browser, configured agent, capture and real MCP receipt", () => {
    expect(setupStep(initial)).toBe(0);
    const paired = {
      ...initial,
      pairedBrowsers: [{ id: "browser", name: "Chrome" }],
    };
    expect(setupStep(paired)).toBe(1);
    const configured = { ...paired, agentConfigured: true };
    expect(setupStep(configured)).toBe(2);
    expect(canFinish({ ...configured, testCaptureId: "capture" })).toBe(false);
    const verified = {
      ...configured,
      testCaptureId: "capture",
      mcpVerified: true,
    };
    expect(canFinish(verified)).toBe(true);
    expect(canFinish({ ...verified, daemonReady: false })).toBe(false);
    expect(canFinish({ ...verified, pairedBrowsers: [] })).toBe(false);
  });
  it("does not trust a persisted completed flag over current health", () => {
    expect(canFinish({ ...initial, completed: true })).toBe(false);
  });
  it("asks for retrieval, not a synthetic fix", () => {
    expect(testPrompt("123")).toContain('sessionId "123"');
    expect(testPrompt("123")).toContain("do not edit");
  });
});
