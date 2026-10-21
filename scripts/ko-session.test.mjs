import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, readServerConfig, parseArgs } from "./ko-session.mjs";

const config = {
  providers: [{
    instanceId: "codex", driver: "codex", enabled: true, installed: true,
    status: "ready", auth: { status: "authenticated" }, models: [{ slug: "test-model" }],
  }],
};
const json = (value) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json" },
});

async function fixture(t, protocol = 2) {
  const home = await mkdtemp(join(tmpdir(), "ko-session-test-"));
  t.after(async () => {
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    assert.ok(home.includes("ko-session-test-"));
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, "userdata"));
  await writeFile(join(home, "userdata", "server-runtime.json"), JSON.stringify({
    pid: 123, origin: "http://127.0.0.1:3773",
  }));
  const state = {
    auth: [], reads: [], config, alive: true, environmentId: "test-env",
    shell: { projects: [], threads: [], archivedThreads: [] },
    metadata: { type: "snapshot", terminals: [] }, sockets: [], revokeFails: false,
  };
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      state.sockets.push(this);
      this.url = new URL(url);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) {
      const request = JSON.parse(text);
      assert.equal(request._tag, "Request");
      assert.equal(request.tag, "subscribeTerminalMetadata");
      assert.deepEqual(request.payload, {});
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ _tag: "Chunk", requestId: request.id, values: [state.metadata] }),
      })));
    }
    close() { this.closed = true; }
  }
  const options = {
    action: "check", homeDir: home, origin: "http://127.0.0.1:3773",
    environmentId: "test-env", t3Command: ["test-t3"],
  };
  const deps = {
    alive: () => state.alive,
    WebSocketClass: FakeSocket,
    getConfig: async (_http, _base, _socket, actualProtocol) => {
      assert.equal(actualProtocol, protocol);
      return state.config;
    },
    exec: async (command, args) => {
      assert.equal(command, "test-t3");
      state.auth.push(args);
      if (args.includes("revoke") && state.revokeFails) throw Error("secret-token");
      return args.includes("issue")
        ? { stdout: JSON.stringify({ sessionId: "test-session", token: "secret-token" }) }
        : { stdout: "" };
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      state.reads.push(path);
      if (path === "/.well-known/t3/environment") return json({
        environmentId: state.environmentId, label: "Test device", serverVersion: protocol === 2 ? "0.1.0" : "0.0.45",
        ...(protocol === 2 ? { orchestrationProtocolVersion: 2 } : {}),
      });
      assert.equal(init.headers.Authorization, "Bearer secret-token");
      assert.equal(init.headers["x-t3-orchestration-protocol"], protocol === 2 ? "2" : undefined);
      if (path === "/api/orchestration/shell") {
        assert.equal(init.method, undefined);
        return json(state.shell);
      }
      if (path === "/api/auth/websocket-ticket") {
        assert.equal(init.method, "POST");
        return json({ ticket: "secret-ticket" });
      }
      throw Error(`Unexpected operation ${path}`);
    },
  };
  return { home, options, state, deps };
}

for (const protocol of [1, 2]) {
  test(`protocol ${protocol} check validates providers without creating work or receipts`, async (t) => {
    const f = await fixture(t, protocol);
    const result = await run(f.options, f.deps);
    assert.equal(result.status, "healthy");
    assert.equal(result.providers[0].ready, true);
    assert.deepEqual(result.providers[0].models, ["test-model"]);
    assert.deepEqual(f.state.reads, ["/.well-known/t3/environment", "/api/orchestration/shell"]);
    assert.ok(f.state.auth[0].includes("--base-dir"));
    assert.ok(f.state.auth.at(-1).includes("revoke"));
    assert.deepEqual(await readdir(f.home), ["userdata"]);
    assert.ok(!JSON.stringify(result).includes("secret-token"));
  });

  test(`protocol ${protocol} idle preserves terminal and active-turn release gates`, async (t) => {
    const f = await fixture(t, protocol);
    const checkIdle = () => run({ ...f.options, action: "idle" }, f.deps);
    assert.equal((await checkIdle()).status, "idle");
    f.state.shell.threads = protocol === 2
      ? [{ id: "busy", status: "running", activeRunId: "run" }]
      : [{ id: "busy", session: { status: "running", activeTurnId: "turn" } }];
    assert.deepEqual((await checkIdle()).busyThreads, ["busy"]);
    f.state.shell.threads = [];
    for (const terminal of [
      { terminalId: "terminal", hasRunningSubprocess: true, status: "running" },
      { terminalId: "terminal", hasRunningSubprocess: false, status: "starting" },
    ]) {
      f.state.metadata.terminals = [terminal];
      const result = await checkIdle();
      assert.equal(result.status, "busy");
      assert.deepEqual(result.busyTerminals, ["terminal"]);
    }
    assert.ok(f.state.sockets.every(socket => socket.closed));
    assert.equal(f.state.sockets[0].url.searchParams.get("orchestrationProtocol"), String(protocol));
    assert.ok(f.state.auth.at(-1).includes("revoke"));
  });
}

test("protocol 2 idle blocks queued, waiting, archived and background work but permits held queues", async (t) => {
  const f = await fixture(t);
  const idle = { id: "held", status: "idle", activeRunId: null, pendingRuntimeRequest: null };
  const checkIdle = () => run({ ...f.options, action: "idle" }, f.deps);
  f.state.shell.threads = [idle];
  assert.equal((await checkIdle()).status, "idle");
  for (const busy of [
    { status: "preparing" }, { status: "starting" }, { status: "queued" }, { status: "waiting" },
    { activityRunStatus: "waiting" }, { pendingRuntimeRequest: { id: "approval" } },
    { pendingBackgroundTasks: [{ id: "subagent" }] },
  ]) {
    f.state.shell.threads = [idle, { ...idle, ...busy, id: "busy" }];
    const result = await checkIdle();
    assert.equal(result.status, "busy", JSON.stringify(busy));
    assert.deepEqual(result.busyThreads, ["busy"]);
  }
  f.state.shell.threads = [idle];
  f.state.shell.archivedThreads = [{ id: "archived", status: "running" }];
  assert.deepEqual((await checkIdle()).busyThreads, ["archived"]);
  f.state.shell.archivedThreads = [];
  f.state.shell.threads = [{ id: "unknown-shape", session: { status: "running" } }];
  assert.match((await checkIdle()).error, /Unsupported idle snapshot/);
  f.state.shell.threads = [];
  f.state.metadata = { type: "update", terminals: [] };
  assert.match((await checkIdle()).error, /Unsupported idle snapshot/);
});

test("dead runtime and wrong environment fail before credentials are minted", async (t) => {
  const f = await fixture(t);
  f.state.alive = false;
  assert.match((await run(f.options, f.deps)).error, /PID is not alive/);
  f.state.alive = true;
  f.state.environmentId = "another-env";
  assert.match((await run(f.options, f.deps)).error, /identity mismatch/);
  assert.equal(f.state.auth.length, 0);
});

test("failed checks redact credentials and revoke temporary auth", async (t) => {
  const f = await fixture(t);
  f.deps.getConfig = async () => { throw Error("Provider check failed with secret-token"); };
  const result = await run(f.options, f.deps);
  assert.equal(result.status, "error");
  assert.match(result.error, /Provider check failed/);
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.ok(f.state.auth.at(-1).includes("revoke"));
  f.state.revokeFails = true;
  const cleanup = await run(f.options, f.deps);
  assert.match(cleanup.warnings[0], /revocation failed/);
  assert.ok(!JSON.stringify(cleanup).includes("secret-token"));
});

test("removed launch action cannot issue credentials, read the server or create receipts", async (t) => {
  const f = await fixture(t);
  const result = await run({ ...f.options, action: "start" }, f.deps);
  assert.equal(result.status, "error");
  assert.match(result.error, /MCP/);
  assert.equal(f.state.auth.length, 0);
  assert.equal(f.state.reads.length, 0);
  assert.deepEqual(await readdir(f.home), ["userdata"]);
});

test("RPC reads config using the Effect JSON envelope and closes its socket", async () => {
  let socket;
  class FakeSocket extends EventTarget {
    constructor(url) {
      super(); socket = this; this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) {
      const request = JSON.parse(text);
      assert.equal(request.tag, "server.getConfig");
      assert.equal(request._tag, "Request");
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify([{ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: config } }]),
      })));
    }
    close() { this.closed = true; }
  }
  const result = await readServerConfig(async path => {
    assert.equal(path, "/api/auth/websocket-ticket");
    return { ticket: "secret-ticket" };
  }, "http://127.0.0.1:3773", FakeSocket, 2);
  assert.deepEqual(result, config);
  assert.equal(socket.closed, true);
  assert.equal(new URL(socket.url).searchParams.get("orchestrationProtocol"), "2");
});

test("CLI requires explicit home, origin, identity and argv, and rejects launch options", () => {
  assert.throws(() => parseArgs(["check"]), /homeDir/);
  const args = ["check", "--home-dir", "x", "--origin", "http://x", "--environment-id", "env", "--t3-command", '["t3"]'];
  assert.equal(parseArgs(args).action, "check");
  assert.equal(parseArgs(["idle", ...args.slice(1)]).action, "idle");
  assert.throws(() => parseArgs(["start", ...args.slice(1)]), /MCP/);
  assert.throws(() => parseArgs([...args.slice(0, -1), '"shell string"']), /argv/);
  for (const option of ["--request", "--watch-origin", "--wait-ms"]) {
    assert.throws(() => parseArgs([...args, option, "ignored"]), /Invalid option/);
  }
});
