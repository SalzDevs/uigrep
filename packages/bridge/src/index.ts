import {
  captureManifestSchema,
  captureSessionSchema,
  type CaptureManifest,
  type CaptureSession,
} from "@uigrep/schema";

export const DEFAULT_DAEMON_ORIGIN = "http://127.0.0.1:47831";
export const AUTH_HEADER = "x-uigrep-token";

export class UigrepDaemonClient {
  public constructor(
    private readonly token: string,
    private readonly origin = DEFAULT_DAEMON_ORIGIN,
  ) {}

  public async health(): Promise<boolean> {
    const response = await this.request("/v1/health");
    return response.ok;
  }

  public async createCapture(capture: CaptureSession): Promise<void> {
    const body = JSON.stringify(captureSessionSchema.parse(capture));
    const response = await this.request("/v1/captures", {
      method: "POST",
      body,
    });
    if (!response.ok)
      throw new Error(`Unable to store capture: ${response.status}`);
  }

  public async listCaptures(): Promise<CaptureManifest[]> {
    const response = await this.request("/v1/captures");
    if (!response.ok)
      throw new Error(`Unable to list captures: ${response.status}`);
    return captureManifestSchema.array().parse(await response.json());
  }

  public async getCapture(id: string): Promise<CaptureSession> {
    const response = await this.request(
      `/v1/captures/${encodeURIComponent(id)}`,
    );
    if (!response.ok)
      throw new Error(`Unable to read capture: ${response.status}`);
    return captureSessionSchema.parse(await response.json());
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(AUTH_HEADER, this.token);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(`${this.origin}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(8_000),
    });
  }

  /** Onboarding acknowledgement only; old daemons and non-test captures are normal. */
  public async verifySetup(sessionId: string): Promise<boolean> {
    try {
      const response = await this.request("/v1/setup/verify", {
        method: "POST",
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return false;
      const result: unknown = await response.json();
      return (
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        result.ok === true
      );
    } catch {
      return false;
    }
  }
}
