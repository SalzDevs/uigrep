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

export function setupStep(status: SetupStatus): number {
  if (!status.daemonReady || status.pairedBrowsers.length === 0) return 0;
  if (!status.agentConfigured) return 1;
  if (!status.testCaptureId || !status.mcpVerified) return 2;
  return 3;
}

export function canFinish(status: SetupStatus): boolean {
  return setupStep(status) === 3;
}

export function testPrompt(captureId: string): string {
  return `Use the uigrep MCP tool uigrep_get_capture with sessionId "${captureId}". Summarize the test annotation. This is an installation test; do not edit any project files.`;
}
