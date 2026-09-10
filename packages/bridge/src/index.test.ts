import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSessionSchema, toCaptureManifest } from "@uigrep/schema";
import {
  AUTH_HEADER,
  DEFAULT_DAEMON_ORIGIN,
  UigrepDaemonClient,
} from "./index.js";

const capture = captureSessionSchema.parse({
  schemaVersion: "1.0.0",
  id: "550e8400-e29b-41d4-a716-446655440000",
  capturedAt: "2026-09-09T12:00:00.000Z",
  status: "pending",
  page: {
    url: "http://localhost:3000/pricing",
    title: "Pricing",
    viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0 },
    colorScheme: "light",
  },
  annotations: [
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      order: 1,
      comment: "Align the cards.",
      selectionMethod: "drag",
      viewportRect: { x: 10, y: 20, width: 300, height: 100 },
      pageRect: { x: 10, y: 20, width: 300, height: 100 },
      scroll: { x: 0, y: 0 },
      targets: [],
    },
  ],
});
const manifest = toCaptureManifest(capture);
const origin = "http://127.0.0.1:49152";
const fakeToken = "bridge-test-token-not-a-secret";
const fetchMock = vi.fn<typeof fetch>();
let client: UigrepDaemonClient;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  client = new UigrepDaemonClient(fakeToken, origin);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectRequest(path: string, method = "GET"): RequestInit {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const call = fetchMock.mock.calls[0];
  expect(call?.[0]).toBe(`${origin}${path}`);
  const init = call?.[1];
  expect(init).toBeDefined();
  expect(init?.method ?? "GET").toBe(method);
  expect(new Headers(init?.headers).get(AUTH_HEADER)).toBe(fakeToken);
  return init ?? {};
}

describe("UigrepDaemonClient", () => {
  it("uses the default loopback origin and authenticates health requests", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(new UigrepDaemonClient(fakeToken).health()).resolves.toBe(
      true,
    );
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(`${DEFAULT_DAEMON_ORIGIN}/v1/health`);
    expect(new Headers(call?.[1]?.headers).get(AUTH_HEADER)).toBe(fakeToken);
  });

  it("returns false for an unhealthy HTTP status", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(client.health()).resolves.toBe(false);
    expectRequest("/v1/health");
  });

  it("lists schema-validated manifests using the overridden origin", async () => {
    fetchMock.mockResolvedValue(Response.json([manifest]));
    await expect(client.listCaptures()).resolves.toEqual([manifest]);
    const init = expectRequest("/v1/captures");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("accepts an empty capture list", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    await expect(client.listCaptures()).resolves.toEqual([]);
  });

  it("reads a schema-validated capture", async () => {
    fetchMock.mockResolvedValue(Response.json(capture));
    await expect(client.getCapture(capture.id)).resolves.toEqual(capture);
    expectRequest(`/v1/captures/${capture.id}`);
  });

  it("encodes the complete capture ID as a single path segment", async () => {
    fetchMock.mockResolvedValue(Response.json(capture));
    await client.getCapture("a/b?c=d#e %");
    expectRequest("/v1/captures/a%2Fb%3Fc%3Dd%23e%20%25");
  });

  it("validates and posts captures with JSON and authentication headers", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await expect(client.createCapture(capture)).resolves.toBeUndefined();
    const init = expectRequest("/v1/captures", "POST");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init.body).toBe(JSON.stringify(capture));
  });

  it("rejects invalid captures before making a network request", async () => {
    await expect(
      client.createCapture({ ...capture, annotations: [] }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["list", "read", "store"] as const)(
    "reports non-success HTTP status when attempting to %s captures",
    async (operation) => {
      fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
      const request =
        operation === "list"
          ? client.listCaptures()
          : operation === "read"
            ? client.getCapture(capture.id)
            : client.createCapture(capture);
      await expect(request).rejects.toThrow(
        `Unable to ${operation} capture${operation === "list" ? "s" : ""}: 401`,
      );
    },
  );

  it.each([
    { name: "non-array", body: {} },
    { name: "full capture instead of manifest", body: [capture] },
    {
      name: "invalid manifest UUID",
      body: [{ ...manifest, id: "not-a-uuid" }],
    },
  ])("rejects invalid manifest responses: $name", async ({ body }) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(client.listCaptures()).rejects.toThrow();
  });

  it.each([
    {},
    manifest,
    { ...capture, annotations: [] },
    { ...capture, schemaVersion: "unsupported" },
  ])("rejects invalid capture responses: %j", async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(client.getCapture(capture.id)).rejects.toThrow();
  });

  it("propagates malformed JSON for capture reads", async () => {
    fetchMock.mockResolvedValue(new Response("not JSON"));
    await expect(client.getCapture(capture.id)).rejects.toThrow();
  });

  it("propagates network failures outside optional setup verification", async () => {
    fetchMock.mockRejectedValue(new TypeError("test network failure"));
    await expect(client.listCaptures()).rejects.toThrow("test network failure");
  });
});

describe("setup verification", () => {
  it("accepts the backend's { ok: true } acknowledgement without a valid field", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    await expect(client.verifySetup(capture.id)).resolves.toBe(true);
    const init = expectRequest("/v1/setup/verify", "POST");
    expect(init.body).toBe(JSON.stringify({ sessionId: capture.id }));
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 401, 404, 409, 500, 503])(
    "treats HTTP %i as a normal negative acknowledgement",
    async (status) => {
      fetchMock.mockResolvedValue(Response.json({ ok: true }, { status }));
      await expect(client.verifySetup(capture.id)).resolves.toBe(false);
    },
  );

  it.each([
    { name: "null", body: null },
    { name: "array", body: [] },
    { name: "empty object", body: {} },
    { name: "boolean", body: true },
    { name: "negative acknowledgement", body: { ok: false } },
    { name: "string acknowledgement", body: { ok: "true" } },
    { name: "legacy valid field alone", body: { valid: true } },
  ])("returns false for a non-acknowledgement: $name", async ({ body }) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(client.verifySetup(capture.id)).resolves.toBe(false);
  });

  it("treats invalid JSON as a normal negative acknowledgement", async () => {
    fetchMock.mockResolvedValue(new Response("not JSON"));
    await expect(client.verifySetup(capture.id)).resolves.toBe(false);
  });

  it("treats a disconnected daemon as a normal negative acknowledgement", async () => {
    fetchMock.mockRejectedValue(new TypeError("test connection refused"));
    await expect(client.verifySetup(capture.id)).resolves.toBe(false);
  });

  it("passes a 1500ms abort signal to fetch and returns false on timeout", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Test timeout", "TimeoutError")),
            { once: true },
          );
        }),
    );

    const verification = client.verifySetup(capture.id);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(1_500);
    expect(expectRequest("/v1/setup/verify", "POST").signal).toBe(
      controller.signal,
    );
    controller.abort();
    await expect(verification).resolves.toBe(false);
  });
});
