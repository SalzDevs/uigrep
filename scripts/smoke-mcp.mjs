import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately dependency-free: the server SDK is installed, not the client SDK.
// MCP stdio uses one JSON-RPC message per line, not HTTP Content-Length framing.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const originalCwd = process.cwd();
const runtime = join(root, "apps/desktop/src-tauri/runtime");
const native = process.env.UIGREP_SMOKE_EXECUTABLE;
const executable = native
  ? resolve(originalCwd, native)
  : join(runtime, process.platform === "win32" ? "node.exe" : "node");
const args = native ? ["--mcp"] : [join(runtime, "mcp.cjs")];
const fakeToken = "uigrep-smoke-fake-token-not-a-credential";
const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const annotationId = "550e8400-e29b-41d4-a716-446655440001";
const rect = { x: 10, y: 20, width: 120, height: 40 };
const capture = {
  schemaVersion: "1.0.0",
  id: sessionId,
  capturedAt: "2026-09-09T12:00:00.000Z",
  status: "pending",
  page: {
    url: "http://localhost:3000/smoke",
    title: "Smoke fixture",
    viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0 },
    colorScheme: "light",
  },
  annotations: [
    {
      id: annotationId,
      order: 1,
      comment: "Align the save button.",
      selectionMethod: "click",
      viewportRect: rect,
      pageRect: rect,
      scroll: { x: 0, y: 0 },
      status: "pending",
      hasMoreTargets: false,
      screenshot: {
        resourceUri: `uigrep://captures/${sessionId}/${annotationId}.png`,
        mimeType: "image/png",
        byteLength: 128,
        width: 120,
        height: 40,
      },
      targets: Array.from({ length: 6 }, (_, index) => ({
        id: `550e8400-e29b-41d4-a716-${String(index + 10).padStart(12, "0")}`,
        rank: index + 1,
        tag: "button",
        text: "Save",
        rect,
        selectors: { testId: `smoke-save-${index + 1}` },
        attributes: { type: "button" },
        domSnippet: '<button type="button">Save</button>',
        styleFacts: { display: "inline-flex" },
        score: 0.9,
      })),
    },
  ],
  relationships: [],
};
const annotation = capture.annotations[0];
const manifest = {
  schemaVersion: capture.schemaVersion,
  id: sessionId,
  capturedAt: capture.capturedAt,
  status: capture.status,
  page: capture.page,
  annotations: [
    {
      id: annotationId,
      order: 1,
      comment: annotation.comment,
      status: "pending",
      targetSummary: "button · smoke-save-1",
    },
  ],
  relationshipCount: 0,
};

let directory;
let child;
let childClosed;
let stopping = false;
let stopped = false;
let failed = false;
let stage = "setup";
let nextId = 0;
let output = "";
let stderr = "";
let outputBytes = 0;
const pending = new Map();
const recorded = [];
let rejectFailure;
const failure = new Promise((_, reject) => {
  rejectFailure = reject;
});
// A failure can arrive between requests; retain it without an unhandled rejection.
void failure.catch(() => {});
const fail = () => {
  failed = true;
  rejectFailure(new Error("MCP smoke contract failed"));
};
const deadline = setTimeout(fail, 60_000);

const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.headers["x-uigrep-token"], fakeToken);
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      assert.ok(body.length <= 16_384);
    }
    const entry = {
      method: request.method,
      path: request.url,
      body: body ? JSON.parse(body) : undefined,
    };
    recorded.push(entry);
    let result;
    if (entry.method === "GET" && entry.path === "/v1/captures") {
      assert.equal(entry.body, undefined);
      result = [manifest];
    } else if (
      entry.method === "GET" &&
      entry.path === `/v1/captures/${sessionId}`
    ) {
      assert.equal(entry.body, undefined);
      result = capture;
    } else if (entry.method === "POST" && entry.path === "/v1/setup/verify") {
      assert.equal(request.headers["content-type"], "application/json");
      assert.deepEqual(entry.body, { sessionId });
      // This is the real backend contract. There is intentionally no `valid`.
      result = { ok: true };
    } else {
      throw new Error("Unexpected mock daemon endpoint");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  })().catch(() => {
    fail();
    response.writeHead(500);
    response.end();
  });
});
server.requestTimeout = 5_000;
server.headersTimeout = 5_000;
server.on("error", fail);

function send(message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function request(method, params) {
  const id = ++nextId;
  let timer;
  const response = new Promise((resolveResponse, reject) => {
    timer = setTimeout(
      () => reject(new Error("MCP request timed out")),
      10_000,
    );
    pending.set(id, resolveResponse);
  });
  try {
    send({ id, method, params });
    return await Promise.race([failure, response]);
  } finally {
    clearTimeout(timer);
    pending.delete(id);
  }
}

async function callTool(name, argumentsValue = {}) {
  const result = await request("tools/call", {
    name,
    arguments: argumentsValue,
  });
  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent);
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text);
  return { data: result.structuredContent, text: JSON.parse(text.text) };
}

function receive(chunk) {
  try {
    outputBytes += Buffer.byteLength(chunk);
    assert.ok(outputBytes <= 1024 * 1024);
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      assert.ok(!line.includes(fakeToken));
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0");
      if ("id" in message) {
        assert.ok(pending.has(message.id));
        assert.ok(!("error" in message));
        assert.ok("result" in message);
        pending.get(message.id)(message.result);
        pending.delete(message.id);
      } else {
        assert.equal(typeof message.method, "string");
      }
    }
  } catch {
    fail();
  }
}

async function waitForClose(milliseconds) {
  let timer;
  try {
    return await Promise.race([
      childClosed.then(() => true),
      new Promise((resolveWait) => {
        timer = setTimeout(() => resolveWait(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild() {
  if (!child || stopped) return;
  stopping = true;
  child.stdin.end();
  if (await waitForClose(2_000)) {
    stopped = true;
    return;
  }
  // Kill the entire native-wrapper/private-Node tree, not just the wrapper.
  if (process.platform === "win32" && child.pid) {
    await new Promise((resolveKill) => {
      const killer = spawn(
        join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true, timeout: 3_000 },
      );
      killer.once("error", resolveKill);
      killer.once("close", resolveKill);
    });
  } else if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group may already have exited after stdin closed.
    }
  }
  if (!(await waitForClose(2_000))) {
    child.kill("SIGKILL");
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    throw new Error("Child cleanup did not complete");
  }
  stopped = true;
}

const interrupt = () => fail();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  await access(executable);
  if (!native) await access(args[0]);
  directory = await mkdtemp(join(tmpdir(), "uigrep-mcp-smoke-"));
  await writeFile(
    join(directory, "cwd-sentinel.txt"),
    "agent-owned workspace\n",
  );
  // Inherit an unrelated agent cwd. Never launch via PATH or process.execPath.
  process.chdir(directory);
  const inheritedCwd = process.cwd();
  await Promise.race([
    new Promise((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    ),
    failure,
  ]);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["PATH", "NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())) {
      delete env[key];
    }
  }
  Object.assign(env, {
    PATH: directory,
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory,
    UIGREP_TOKEN: fakeToken,
    UIGREP_TOKEN_PATH: join(directory, "must-not-read-token"),
    UIGREP_DAEMON_ORIGIN: `http://127.0.0.1:${address.port}`,
  });
  child = spawn(executable, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    // No cwd option: the native wrapper and private Node must inherit it.
  });
  childClosed = new Promise((resolveClose) => {
    child.once("close", (code) => {
      resolveClose(code);
      if (!stopping) fail();
    });
  });
  child.on("error", fail);
  child.stdin.on("error", () => {
    if (!stopping) fail();
  });
  child.stdout.setEncoding("utf8").on("data", receive);
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    if (stderr.length + chunk.length > 65_536) fail();
    stderr = (stderr + chunk).slice(0, 65_536);
    if (stderr.includes(fakeToken)) fail();
  });

  stage = "initialize";
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "uigrep-private-runtime-smoke", version: "1.0.0" },
  });
  assert.ok(["2025-11-25", "2025-03-26"].includes(initialized.protocolVersion));
  assert.equal(initialized.serverInfo.name, "uigrep");
  assert.ok(initialized.capabilities.tools);
  send({ method: "notifications/initialized" });

  stage = "tools/list";
  const { tools } = await request("tools/list", {});
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "uigrep_get_annotation_context",
    "uigrep_get_capture",
    "uigrep_list_captures",
  ]);

  stage = "list captures";
  const listed = await callTool("uigrep_list_captures");
  assert.deepEqual(listed.data, { captures: [manifest] });
  assert.deepEqual(listed.text, [manifest]);

  stage = "get capture";
  const fetched = await callTool("uigrep_get_capture", { sessionId });
  assert.deepEqual(fetched.data, manifest);
  assert.deepEqual(fetched.text, manifest);

  stage = "annotation defaults";
  const efficient = await callTool("uigrep_get_annotation_context", {
    sessionId,
    annotationId,
  });
  assert.equal(efficient.data.id, annotationId);
  assert.equal(efficient.data.comment, annotation.comment);
  assert.equal(efficient.data.targets.length, 5);
  assert.equal(efficient.data.hasMore, true);
  assert.ok(!("screenshot" in efficient.data));
  for (const target of efficient.data.targets) {
    assert.ok(!("domSnippet" in target));
    assert.ok(!("styleFacts" in target));
  }
  assert.deepEqual(efficient.text, efficient.data);

  stage = "annotation evidence";
  const deep = await callTool("uigrep_get_annotation_context", {
    sessionId,
    annotationId,
    mode: "deep",
    include: ["targets", "dom", "styles", "screenshot"],
  });
  assert.deepEqual(deep.data.targets, annotation.targets);
  assert.deepEqual(deep.data.screenshot, annotation.screenshot);
  assert.equal(deep.data.hasMore, false);
  assert.deepEqual(deep.text, deep.data);

  stage = "endpoint and cwd assertions";
  assert.deepEqual(
    recorded.map(({ method, path }) => `${method} ${path}`),
    [
      "GET /v1/captures",
      `GET /v1/captures/${sessionId}`,
      "POST /v1/setup/verify",
      `GET /v1/captures/${sessionId}`,
      "POST /v1/setup/verify",
      `GET /v1/captures/${sessionId}`,
      "POST /v1/setup/verify",
    ],
  );
  await stopChild();
  assert.equal(await childClosed, 0);
  assert.equal(output, "");
  assert.equal(stderr, "");
  assert.equal(failed, false);
  assert.equal(process.cwd(), inheritedCwd);
  assert.deepEqual(await readdir(directory), ["cwd-sentinel.txt"]);
  assert.equal(
    await readFile(join(directory, "cwd-sentinel.txt"), "utf8"),
    "agent-owned workspace\n",
  );
} catch {
  // Never echo child stdout/stderr, HTTP bodies, environment values or tokens.
  console.error(`MCP smoke failed during ${stage}.`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try {
    await stopChild();
  } catch {
    console.error("MCP smoke child cleanup failed.");
    process.exitCode = 1;
  }
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  process.chdir(originalCwd);
  if (directory) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(
      () => {
        console.error("MCP smoke temporary-directory cleanup failed.");
        process.exitCode = 1;
      },
    );
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (failed) process.exitCode = 1;
}

if (!process.exitCode) {
  console.log(
    "MCP smoke passed (private runtime, loopback daemon, stdio tools).",
  );
}
