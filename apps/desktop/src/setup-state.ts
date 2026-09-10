export type SetupStatus = {
  daemonReady: boolean;
  pairedBrowsers: { id: string; name: string }[];
  pendingPairings: { id: string; name: string; origin: string }[];
  agentConfigured: boolean;
  testCaptureId: string | null;
  mcpVerified: boolean;
  completed: boolean;
  storeUrl: string | null;
  developmentMode: boolean;
  error: string | null;
};

export type AgentOption = {
  id: string;
  name: string;
  configPath: string;
  available: boolean;
};

export type ConfigResult = {
  agentId: string;
  configPath: string;
  backupPath?: string;
  message: string;
};

/** One-click setup gate: daemon + paired browser + configured agent. */
export function canFinish(status: SetupStatus): boolean {
  return (
    status.daemonReady &&
    status.pairedBrowsers.length > 0 &&
    status.agentConfigured
  );
}
