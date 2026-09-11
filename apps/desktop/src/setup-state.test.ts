import { describe, expect, it } from "vitest";
import { canFinish, type SetupStatus } from "./setup-state";

const initial: SetupStatus = {
  daemonReady: true,
  agentConfigured: false,
  completed: false,
  developmentMode: true,
  error: null,
};

describe("one-click setup gate", () => {
  it("needs daemon and configured agent", () => {
    expect(canFinish(initial)).toBe(false);
    expect(canFinish({ ...initial, agentConfigured: true })).toBe(true);
    expect(
      canFinish({ ...initial, agentConfigured: true, daemonReady: false }),
    ).toBe(false);
  });
});
