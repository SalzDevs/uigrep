export type BackgroundRequest =
  | { type: "send-capture"; capture: unknown }
  | { type: "capture-visible-tab" }
  | { type: "daemon-status" };

export type ContentRequest =
  { type: "start-capture" } | { type: "cancel-capture" };

export type DaemonStatus = {
  connected: boolean;
  configured: boolean;
};
