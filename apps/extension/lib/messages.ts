export type BackgroundRequest =
  | { type: "send-capture"; capture: unknown }
  | { type: "daemon-status" }
  | { type: "connect-browser" };

export type ContentRequest =
  { type: "start-capture" } | { type: "cancel-capture" };

export type DaemonStatus = {
  connected: boolean;
  configured: boolean;
  phase:
    "idle" | "requesting" | "pending" | "connecting" | "connected" | "error";
  error?: string;
  expiresAt?: number;
};
