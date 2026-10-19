import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, readServerConfig, callRpc, parseArgs } from "./ko-session.mjs";

// Optional source-contract pass, in addition to the dependency-free packaged tests:
// KO_SESSION_TEST_CONTRACTS=1 bun test scripts/ko-session.test.mjs
let decodeCommand;
if (process.env.KO_SESSION_TEST_CONTRACTS === "1") {
  const [{ ClientOrchestrationCommand }, Schema] = await Promise.all([
    import("../packages/contracts/src/orchestration.ts"),
    import("../apps/server/node_modules/effect/dist/Schema.js"),
  ]);
  decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
}

const selected = { instanceId: "codex", model: "test-model" };
const config = {
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "test-model" }],
    },
  ],
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "ko-session-test-"));
  t.after(async () => {
    assert.ok(
      resolve(home).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")),
    );
    assert.ok(home.includes("ko-session-test-"));
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, "userdata"));
  await mkdir(join(home, "checkout"));
  await writeFile(
    join(home, "userdata", "server-runtime.json"),
    JSON.stringify({ pid: 123, origin: "http://127.0.0.1:3773" }),
  );
  const state = {
    calls: [],
    auth: [],
    threads: new Map(),
    timeout: false,
    pending: false,
    project: true,
    config,
    alive: true,
  };
  const options = {
    action: "start",
    homeDir: home,
    origin: "http://127.0.0.1:3773",
    environmentId: "test-env",
    t3Command: ["test-t3"],
    waitMs: 0,
    watchOrigin: "https://caps.example",
  };
  const request = {
    requestId: "task-1-attempt-1",
    cwd: join(home, "checkout"),
    ref: "main",
    title: "Do task 1",
    prompt: "Implement the task.",
  };
  const deps = {
    alive: () => state.alive,
    getConfig: async () => state.config,
    exec: async (command, args) => {
      if (command === "git") return { stdout: "0123456789\n" };
      state.auth.push(args);
      return args.includes("issue")
        ? { stdout: JSON.stringify({ sessionId: "test-session", token: "secret-token" }) }
        : { stdout: "" };
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/.well-known/t3/environment")
        return json({ environmentId: "test-env", label: "Test device", serverVersion: "0.0.42" });
      assert.equal(init.headers.Authorization, "Bearer secret-token");
      if (path === "/api/orchestration/shell")
        return json({
          projects: state.project
            ? [{ id: "saved-project", workspaceRoot: request.cwd, defaultModelSelection: selected }]
            : [],
        });
      if (path === "/api/orchestration/dispatch") {
        const command = JSON.parse(init.body);
        if (decodeCommand) decodeCommand(command);
        state.calls.push(command);
        if (command.type === "thread.turn.start") {
          state.threads.set(command.threadId, {
            id: command.threadId,
            worktreePath: join(home, "isolated"),
            branch: "ko/test-branch",
            messages: [{ id: command.message.messageId }],
            session: {
              status: state.pending ? "starting" : "running",
              activeTurnId: state.pending ? null : "turn-1",
              lastError: null,
            },
          });
          if (state.timeout) throw new Error("Request timed out with secret-token");
        }
        return json({ sequence: state.calls.length });
      }
      if (path.startsWith("/api/orchestration/threads/"))
        return json(
          { thread: state.threads.get(path.split("/").at(-1)) },
          state.threads.has(path.split("/").at(-1)) ? 200 : 404,
        );
      throw new Error(`Unexpected route ${path}`);
    },
  };
  deps.dispatchTurn = async (command) => {
    assert.equal(command.type, "thread.turn.start");
    return (
      await deps.fetch(new URL("/api/orchestration/dispatch", options.origin), {
        body: JSON.stringify(command),
        headers: { Authorization: "Bearer secret-token" },
      })
    ).json();
  };
  return { home, options, request, state, deps };
}

test("check validates providers and revokes temporary auth without dispatch", async (t) => {
  const f = await fixture(t);
  const result = await run({ ...f.options, action: "check" }, undefined, f.deps);
  assert.equal(result.status, "healthy");
  assert.equal(result.providers[0].ready, true);
  assert.equal(f.state.calls.length, 0);
  assert.ok(f.state.auth[0].includes("--base-dir"));
  assert.ok(f.state.auth.at(-1).includes("revoke"));
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});

test("default launch uses saved project model and a pinned isolated worktree", async (t) => {
  const f = await fixture(t);
  const result = await run(f.options, f.request, f.deps);
  assert.equal(result.status, "started");
  assert.equal(result.projectId, "saved-project");
  assert.match(result.url, /^https:\/\/caps\.example\/test-env\/ko-thread-/);
  assert.equal(f.state.calls.length, 1);
  const command = f.state.calls[0];
  assert.equal(command.bootstrap.prepareWorktree.baseBranch, "0123456789");
  assert.equal(command.bootstrap.prepareWorktree.startFromOrigin, false);
  assert.equal(command.bootstrap.runSetupScript, false);
  assert.deepEqual(command.modelSelection, selected);
  assert.equal(command.runtimeMode, "approval-required");
  assert.ok(f.state.auth.at(-1).includes("revoke"));
});

test("timeout after server persistence is recoverable without a second dispatch", async (t) => {
  const f = await fixture(t);
  f.state.timeout = true;
  const first = await run(f.options, f.request, f.deps);
  assert.equal(first.status, "error");
  assert.ok(first.threadId);
  assert.ok(!JSON.stringify(first).includes("secret-token"));
  const retry = await run(f.options, f.request, f.deps);
  assert.equal(retry.status, "started");
  assert.equal(retry.threadId, first.threadId);
  assert.equal(f.state.calls.length, 1);
});

test("retry before persistence reuses exact command, timestamp, and thread identity", async (t) => {
  const f = await fixture(t);
  f.state.timeout = true;
  await run(f.options, f.request, f.deps);
  const original = f.state.calls[0];
  f.state.threads.clear();
  f.state.timeout = false;
  await run(f.options, f.request, f.deps);
  assert.deepEqual(f.state.calls[1], original);
});

test("request ID cannot silently change task content", async (t) => {
  const f = await fixture(t);
  await run(f.options, f.request, f.deps);
  const result = await run(f.options, { ...f.request, prompt: "Different instructions" }, f.deps);
  assert.equal(result.status, "error");
  assert.match(result.error, /different input/);
  assert.equal(f.state.calls.length, 1);
});

test("dead runtime and wrong environment fail before credentials are minted", async (t) => {
  const f = await fixture(t);
  f.state.alive = false;
  assert.match((await run(f.options, f.request, f.deps)).error, /PID is not alive/);
  f.state.alive = true;
  assert.match(
    (await run({ ...f.options, environmentId: "another-env" }, f.request, f.deps)).error,
    /identity mismatch/,
  );
  assert.equal(f.state.auth.length, 0);
});

test("missing project model and unready provider fail before registration or dispatch", async (t) => {
  const f = await fixture(t);
  f.state.project = false;
  assert.match((await run(f.options, f.request, f.deps)).error, /Choose modelSelection/);
  f.state.config = { providers: [{ ...config.providers[0], auth: { status: "unauthenticated" } }] };
  assert.match(
    (await run(f.options, { ...f.request, modelSelection: selected }, f.deps)).error,
    /not ready/,
  );
  assert.equal(f.state.calls.length, 0);
});

test("canonical saved project model wins over the stale aggregate model after migration", async (t) => {
  const f = await fixture(t);
  f.state.config = {
    providers: [{ ...config.providers[0], models: [{ slug: "new-model" }] }],
    settings: {
      projectSettingsFolded: true,
      projectSettingsOverrides: {
        "saved-project": { defaultModelSelection: { ...selected, model: "new-model" } },
      },
    },
  };
  assert.equal((await run(f.options, f.request, f.deps)).status, "started");
  assert.equal(f.state.calls[0].modelSelection.model, "new-model");
});

test("reset canonical project selection does not revive stale aggregate or guess environment default", async (t) => {
  const f = await fixture(t);
  f.state.config = {
    ...config,
    settings: {
      projectSettingsFolded: true,
      projectSettingsOverrides: {},
      defaultModelSelection: selected,
    },
  };
  assert.match((await run(f.options, f.request, f.deps)).error, /Choose modelSelection/);
  assert.equal(f.state.calls.length, 0);
  assert.equal(
    (await run(f.options, { ...f.request, modelSelection: selected }, f.deps)).status,
    "started",
  );
});

test("explicit null canonical override resets model even before legacy fold completes", async (t) => {
  const f = await fixture(t);
  f.state.config = {
    ...config,
    settings: {
      projectSettingsFolded: false,
      projectSettingsOverrides: { "saved-project": { defaultModelSelection: null } },
    },
  };
  assert.match((await run(f.options, f.request, f.deps)).error, /Choose modelSelection/);
  assert.equal(f.state.calls.length, 0);
});

test("local checkout is explicit and missing project is registered once", async (t) => {
  const f = await fixture(t);
  f.state.project = false;
  const request = { ...f.request, workspace: "local", modelSelection: selected };
  assert.equal((await run(f.options, request, f.deps)).status, "started");
  assert.equal(f.state.calls[0].type, "project.create");
  assert.equal(f.state.calls[1].bootstrap.prepareWorktree, undefined);
  await run(f.options, request, f.deps);
  assert.equal(f.state.calls.length, 2);
});

test("starting session is accepted rather than falsely reported running", async (t) => {
  const f = await fixture(t);
  f.state.pending = true;
  assert.equal((await run(f.options, f.request, f.deps)).status, "accepted");
});

test("provider failure returns failed and revokes authentication", async (t) => {
  const f = await fixture(t);
  await run(f.options, f.request, f.deps);
  for (const thread of f.state.threads.values())
    thread.session = { status: "error", lastError: "Provider failed" };
  const result = await run(f.options, f.request, f.deps);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Provider failed");
  assert.ok(f.state.auth.at(-1).includes("revoke"));
});

test("RPC uses current Effect JSON envelope and closes after configuration response", async () => {
  let socket;
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      socket = this;
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) {
      const request = JSON.parse(text);
      assert.equal(request.tag, "server.getConfig");
      assert.equal(request._tag, "Request");
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify([
              { _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: config } },
            ]),
          }),
        ),
      );
    }
    close() {
      this.closed = true;
    }
  }
  const result = await readServerConfig(
    async (path) => {
      assert.equal(path, "/api/auth/websocket-ticket");
      return { ticket: "secret-ticket" };
    },
    "http://127.0.0.1:3773",
    FakeSocket,
  );
  assert.deepEqual(result, config);
  assert.equal(socket.closed, true);
});

test("CLI requires explicit home, origin, identity and argv command", () => {
  assert.throws(() => parseArgs(["start"]), /homeDir/);
  assert.throws(
    () =>
      parseArgs([
        "check",
        "--home-dir",
        "x",
        "--origin",
        "http://x",
        "--environment-id",
        "env",
        "--t3-command",
        '"shell string"',
      ]),
    /argv/,
  );
});

test("launch bootstrap uses the normal WebSocket orchestration RPC", async () => {
  const payload = {
    type: "thread.turn.start",
    bootstrap: { createThread: { projectId: "project" } },
  };
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) {
      const request = JSON.parse(text);
      assert.equal(request.tag, "orchestration.dispatchCommand");
      assert.deepEqual(request.payload, payload);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              _tag: "Exit",
              requestId: request.id,
              exit: { _tag: "Success", value: { sequence: 17 } },
            }),
          }),
        ),
      );
    }
    close() {}
  }
  assert.deepEqual(
    await callRpc(
      async () => ({ ticket: "ticket" }),
      "http://127.0.0.1:3773",
      "orchestration.dispatchCommand",
      payload,
      { WebSocketClass: FakeSocket },
    ),
    { sequence: 17 },
  );
});

// Orchestration protocol 2 (T3 0.1.0+): shell/thread reads need the protocol header,
// launches go through orchestration.launchThread and project creation through /api/projects/mutate.
async function fixtureV2(t) {
  const f = await fixture(t);
  Object.assign(f.state, { shellThreads: [], runStatus: "running" });
  const v1Fetch = f.deps.fetch;
  f.deps.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/.well-known/t3/environment")
      return json({
        environmentId: "test-env",
        label: "Test device",
        serverVersion: "0.1.0",
        orchestrationProtocolVersion: 2,
      });
    if (path === "/api/orchestration/dispatch") throw new Error("Removed in protocol 2");
    if (path.startsWith("/api/orchestration/"))
      assert.equal(init.headers["x-t3-orchestration-protocol"], "2");
    if (path === "/api/orchestration/shell")
      return json({
        schemaVersion: 1,
        snapshotSequence: 1,
        threads: f.state.shellThreads,
        archivedThreads: [],
        projects: f.state.project
          ? [
              {
                id: f.state.createdProject ?? "saved-project",
                workspaceRoot: f.request.cwd,
                defaultModelSelection: selected,
              },
            ]
          : [],
      });
    if (path === "/api/projects/mutate") {
      const command = JSON.parse(init.body);
      assert.equal(command.createdAt, undefined);
      f.state.calls.push(command);
      f.state.project = true;
      f.state.createdProject = command.projectId;
      return json({ id: command.projectId });
    }
    if (path.startsWith("/api/orchestration/threads/")) {
      const thread = f.state.threads.get(path.split("/").at(-1));
      return thread ? json({ snapshotSequence: 2, projection: thread }) : json({}, 404);
    }
    return v1Fetch(url, init);
  };
  f.deps.dispatchTurn = async (input) => {
    assert.equal(input.type, undefined);
    f.state.calls.push(input);
    f.state.threads.set(input.threadId, {
      thread: { id: input.threadId, worktreePath: join(f.home, "isolated"), branch: "ko/test-branch" },
      runs: [
        { ordinal: 1, status: "completed" },
        { ordinal: 2, status: f.state.runStatus },
      ],
      messages: [{ id: input.initialMessage.messageId }],
      providerSessions: [{ lastError: f.state.runStatus === "failed" ? "Provider failed" : null }],
    });
    if (f.state.timeout) throw new Error("Request timed out with secret-token");
    return { threadId: input.threadId, resumed: false };
  };
  return f;
}

test("protocol 2 launch pins the worktree strategy and reports the latest run", async (t) => {
  const f = await fixtureV2(t);
  const result = await run(f.options, f.request, f.deps);
  assert.equal(result.status, "started");
  assert.equal(result.cwd, join(f.home, "isolated"));
  const [launch] = f.state.calls;
  assert.deepEqual(launch.workspaceStrategy, {
    type: "worktree",
    baseRef: "0123456789",
    branch: launch.workspaceStrategy.branch,
    startFromOrigin: false,
  });
  assert.match(launch.workspaceStrategy.branch, /^ko\//);
  assert.equal(launch.projectId, "saved-project");
  assert.deepEqual(launch.modelSelection, selected);
  assert.equal(launch.initialMessage.text, f.request.prompt);
  assert.ok(f.state.auth.at(-1).includes("revoke"));
});

test("protocol 2 retry after a timeout reports the stored launch without relaunching", async (t) => {
  const f = await fixtureV2(t);
  f.state.timeout = true;
  const first = await run(f.options, f.request, f.deps);
  assert.equal(first.status, "error");
  assert.ok(!JSON.stringify(first).includes("secret-token"));
  f.state.timeout = false;
  const retry = await run(f.options, f.request, f.deps);
  assert.equal(retry.status, "started");
  assert.equal(retry.threadId, first.threadId);
  assert.equal(f.state.calls.length, 1);
});

test("protocol 2 registers a missing project once and keeps a local checkout in place", async (t) => {
  const f = await fixtureV2(t);
  f.state.project = false;
  f.state.timeout = true;
  const request = { ...f.request, workspace: "local", modelSelection: selected };
  await run(f.options, request, f.deps);
  f.state.threads.clear();
  f.state.timeout = false;
  assert.equal((await run(f.options, request, f.deps)).status, "started");
  assert.deepEqual(
    f.state.calls.map((c) => c.type ?? "launch"),
    ["project.create", "launch", "launch"],
  );
  assert.deepEqual(f.state.calls[1].workspaceStrategy, { type: "root", branch: "main" });
  assert.deepEqual(f.state.calls[2], f.state.calls[1]);
});

test("protocol 2 failed runs return the provider error", async (t) => {
  const f = await fixtureV2(t);
  f.state.runStatus = "failed";
  const result = await run(f.options, f.request, f.deps);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Provider failed");
});

test("a protocol 1 receipt is not replayed against a protocol 2 server", async (t) => {
  const f = await fixture(t);
  f.state.timeout = true;
  await run(f.options, f.request, f.deps);
  const v2 = await fixtureV2(t);
  v2.options.homeDir = f.home;
  v2.request.cwd = f.request.cwd;
  const result = await run(v2.options, v2.request, v2.deps);
  assert.match(result.error, /another T3 orchestration protocol/);
  assert.equal(v2.state.calls.length, 0);
});

test("protocol 2 idle refuses running, queued, waiting and background work but not held queues", async (t) => {
  const f = await fixtureV2(t);
  const idle = { status: "idle", activeRunId: null, pendingRuntimeRequest: null };
  f.deps.dispatchTurn = undefined;
  const terminals = { type: "snapshot", terminals: [] };
  const rpcFetch = f.deps.fetch;
  f.deps.fetch = async (url, init) =>
    new URL(url).pathname === "/api/auth/websocket-ticket"
      ? json({ ticket: "ticket" })
      : rpcFetch(url, init);
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      assert.equal(new URL(url).searchParams.get("orchestrationProtocol"), "2");
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) {
      const request = JSON.parse(text);
      assert.equal(request.tag, "subscribeTerminalMetadata");
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ _tag: "Chunk", requestId: request.id, values: [terminals] }),
          }),
        ),
      );
    }
    close() {}
  }
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  t.after(() => {
    globalThis.WebSocket = previous;
  });
  const idleCheck = () => run({ ...f.options, action: "idle" }, undefined, f.deps);
  f.state.shellThreads = [{ ...idle, id: "held" }];
  assert.equal((await idleCheck()).status, "idle");
  for (const busy of [
    { status: "running", activeRunId: "run" },
    { status: "queued" },
    { status: "waiting" },
    { activityRunStatus: "waiting" },
    { pendingRuntimeRequest: { id: "approval" } },
    { pendingBackgroundTasks: [{ id: "subagent" }] },
  ]) {
    f.state.shellThreads = [{ ...idle, id: "held" }, { ...idle, ...busy, id: "busy" }];
    const result = await idleCheck();
    assert.equal(result.status, "busy", JSON.stringify(busy));
    assert.deepEqual(result.busyThreads, ["busy"]);
  }
  f.state.shellThreads = [{ id: "unknown-shape", session: { status: "running" } }];
  assert.match((await idleCheck()).error, /Unsupported idle snapshot/);
});
