export type SetupStatus = {
  daemonReady: boolean;
  agentConfigured: boolean;
  completed: boolean;
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

/** One-click setup gate: daemon + configured agent. */
export function canFinish(status: SetupStatus): boolean {
  return status.daemonReady && status.agentConfigured;
}
