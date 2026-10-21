#!/usr/bin/env node
// Standalone operational client; intentionally has no workspace dependencies.
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const required = (value, name) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a nonempty string.`);
  return value;
};

export const help = `KO release health checks for an installed T3 server (Node >=22 or Bun).

  node ko-session.mjs check|idle --home-dir PATH --origin URL
    --environment-id ID --t3-command '["/path/to/t3"]'

Run on the target device, locally or over SSH. --home-dir is the existing T3
base directory, not userdata. --t3-command is a JSON argv array, e.g.
["node","/opt/t3/dist/bin.mjs"]. It must be the installed release's CLI.
The helper calls its auth CLI with --base-dir; no shell command is evaluated.
check probes the runtime, descriptor, authenticated API and provider configuration.
idle refuses active turns, starting sessions and terminal subprocesses using the existing APIs.
It creates a short-lived session and revokes it; it never starts an agent.
Agent launches and delegation use T3 Code's native MCP tools.
`;

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [action, ...rest] = argv;
  if (!["check", "idle"].includes(action)) throw new Error("Choose check or idle; agent launches use T3 Code MCP tools.");
  const options = { action };
  const names = {
    "--home-dir": "homeDir",
    "--origin": "origin",
    "--environment-id": "environmentId",
    "--t3-command": "t3Command",
  };
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]];
    if (!key || rest[i + 1] === undefined)
      throw new Error(`Invalid option ${rest[i]}; see --help.`);
    options[key] = rest[i + 1];
  }
  for (const key of ["homeDir", "origin", "environmentId", "t3Command"])
    required(options[key], key);
  options.t3Command = JSON.parse(options.t3Command);
  if (
    !Array.isArray(options.t3Command) ||
    !options.t3Command.length ||
    options.t3Command.some((v) => typeof v !== "string" || !v)
  ) {
    throw new Error("--t3-command must be a nonempty JSON argv array.");
  }
  return options;
}

function origin(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Use an HTTP(S) origin without credentials, path, query or fragment.");
  }
  return url.origin;
}

// Current Effect RPC JSON framing, limited to one non-streaming RPC per connection.
export async function callRpc(
  http,
  base,
  tag,
  payload,
  {
    WebSocketClass = globalThis.WebSocket,
    timeoutMs = 10000,
    firstChunk = false,
    orchestrationProtocol,
  } = {},
) {
  if (!WebSocketClass) throw new Error("Native WebSocket is required; use Node >=22 or Bun.");
  const { ticket } = await http("/api/auth/websocket-ticket", { method: "POST" });
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  // Protocol 2 servers refuse WebSockets that do not negotiate it (HTTP 426).
  if (orchestrationProtocol)
    url.searchParams.set("orchestrationProtocol", String(orchestrationProtocol));
  return new Promise((resolveConfig, reject) => {
    let socket;
    let settled = false;
    const finish = (error, config) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      if (error) reject(error);
      else resolveConfig(config);
    };
    const timer = setTimeout(
      () => finish(new Error(`T3 ${tag} timed out; inspect the service and retry the check.`)),
      timeoutMs,
    );
    try {
      socket = new WebSocketClass(url);
    } catch {
      finish(new Error("Could not open T3 WebSocket."));
      return;
    }
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "ko-rpc", tag, payload, headers: [] })),
    );
    socket.addEventListener("error", () => finish(new Error("T3 WebSocket failed.")));
    socket.addEventListener("close", () =>
      finish(new Error("T3 WebSocket closed before its response.")),
    );
    socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data));
        for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
          if (firstChunk && frame._tag === 'Chunk' && frame.requestId === 'ko-rpc') {
            finish(null, frame.values?.[0]);
          }
          if (frame._tag === "Exit" && frame.requestId === "ko-rpc") {
            if (frame.exit?._tag === "Success") finish(null, frame.exit.value);
            else finish(new Error(`T3 rejected ${tag}; check auth scopes and server logs.`));
          } else if (["Defect", "ClientProtocolError"].includes(frame._tag)) {
            finish(new Error("T3 RPC protocol failed; check helper/server version compatibility."));
          }
        }
      } catch {
        finish(new Error("Invalid T3 RPC response; check helper/server version compatibility."));
      }
    });
  });
}

export function readServerConfig(
  http,
  base,
  WebSocketClass = globalThis.WebSocket,
  orchestrationProtocol,
) {
  return callRpc(http, base, "server.getConfig", {}, { WebSocketClass, orchestrationProtocol });
}

export function providerSummary(config) {
  return (config.providers ?? []).map((p) => ({
    instanceId: p.instanceId,
    driver: p.driver,
    ready:
      p.enabled &&
      p.installed &&
      ["ready", "warning"].includes(p.status) &&
      p.auth?.status !== "unauthenticated" &&
      p.availability !== "unavailable",
    status: p.status,
    auth: p.auth?.status,
    models: (p.models ?? []).map((m) => m.slug),
  }));
}

const V2_BUSY = ["preparing", "queued", "starting", "running", "waiting"];
export function busyThreads(shell, protocol) {
  if (protocol < 2)
    return shell.threads.filter(
      (t) => t.session?.activeTurnId || ["starting", "running"].includes(t.session?.status),
    );
  const threads = [...shell.threads, ...(shell.archivedThreads ?? [])];
  if (threads.some((t) => typeof t.status !== "string"))
    throw new Error("Unsupported idle snapshot; activation is blocked.");
  // The server reports queues held for the user after a restart as idle; they never start alone.
  return threads.filter(
    (t) =>
      t.activeRunId ||
      t.activityRunStatus ||
      V2_BUSY.includes(t.status) ||
      t.pendingRuntimeRequest ||
      t.pendingBackgroundTasks?.length,
  );
}

export async function run(options, dependencies = {}) {
  if (!["check", "idle"].includes(options.action))
    return { status: "error", error: "Choose check or idle; agent launches use T3 Code MCP tools." };
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const execute = dependencies.exec ?? exec;
  const getConfig = dependencies.getConfig ?? readServerConfig;
  const alive =
    dependencies.alive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const base = origin(options.origin);
  const homeDir = await realpath(options.homeDir);
  let bearer;
  let sessionId;
  let output;
  let cleanupWarning;
  let protocol = 1;
  const http = async (path, init = {}) => {
    let response;
    try {
      response = await fetcher(new URL(path, base), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(protocol >= 2 ? { "x-t3-orchestration-protocol": String(protocol) } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new Error(
        `T3 ${path.split("?")[0]} transport failed; inspect the service and retry the check.`,
      );
    }
    if (!response.ok)
      throw new Error(
        `T3 ${path.split("?")[0]} returned HTTP ${response.status}; inspect server logs.`,
      );
    try {
      return await response.json();
    } catch {
      throw new Error(`T3 ${path} returned invalid JSON.`);
    }
  };
  const auth = async (args) => {
    const [command, ...prefix] = options.t3Command;
    try {
      return await execute(
        command,
        [...prefix, "auth", "session", ...args, "--base-dir", homeDir],
        { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
    } catch {
      throw new Error("T3 auth CLI failed; check the installed CLI and explicit home directory.");
    }
  };
  try {
    // Do not trust a stale state file or an unrelated listener on a reused port.
    const runtime = JSON.parse(
      await readFile(join(homeDir, "userdata", "server-runtime.json"), "utf8"),
    );
    if (!Number.isInteger(runtime.pid) || runtime.pid <= 0 || !alive(runtime.pid))
      throw new Error("T3 runtime PID is not alive; recover its documented service first.");
    if (origin(runtime.origin) !== base)
      throw new Error(
        "Explicit origin differs from this home's runtime origin; use its verified local origin.",
      );
    const descriptor = await http("/.well-known/t3/environment");
    if (descriptor.environmentId !== options.environmentId)
      throw new Error("T3 environment identity mismatch; check the target device and deployment.");
    // Servers before 0.1.0 do not advertise an orchestration protocol.
    protocol = descriptor.orchestrationProtocolVersion ?? 1;
    if (![1, 2].includes(protocol))
      throw new Error(`Unsupported T3 orchestration protocol ${protocol}; update ko-session.mjs.`);
    const rpc = (tag, payload, rpcOptions = {}) =>
      callRpc(http, base, tag, payload, { WebSocketClass: dependencies.WebSocketClass, ...rpcOptions, orchestrationProtocol: protocol });
    const readConfig = () => getConfig(http, base, dependencies.WebSocketClass, protocol);
    let issued;
    try {
      issued = JSON.parse(
        (await auth(["issue", "--ttl", "5m", "--label", "ko-session", "--json"])).stdout,
      );
    } catch {
      throw new Error(
        "T3 auth CLI did not return a valid session; inspect the installed CLI version.",
      );
    }
    sessionId = required(issued.sessionId, "issued sessionId");
    bearer = required(issued.token, "issued token");
    const shell = await http("/api/orchestration/shell");
    if (!Array.isArray(shell.projects)) throw new Error("Unsupported T3 shell response.");
    if (options.action === "idle") {
      const metadata = await rpc("subscribeTerminalMetadata", {}, { firstChunk: true });
      if (metadata?.type !== "snapshot" || !Array.isArray(metadata.terminals) || !Array.isArray(shell.threads))
        throw new Error("Unsupported idle snapshot; activation is blocked.");
      const threads = busyThreads(shell, protocol);
      const busyTerminals = metadata.terminals.filter(t => t.hasRunningSubprocess || t.status === "starting");
      output = {
        status: threads.length || busyTerminals.length ? "busy" : "idle",
        environmentId: descriptor.environmentId,
        busyThreads: threads.map(t => t.id),
        busyTerminals: busyTerminals.map(t => t.terminalId),
      };
    } else {
      const providers = providerSummary(await readConfig());
      output = {
        status: "healthy",
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        providers,
      };
    }
  } catch (e) {
    // Never propagate CLI stdout/stderr or the WebSocket URL (both may contain credentials).
    const message = e instanceof Error ? e.message : "Unknown helper error.";
    const safeMessage = bearer ? message.split(bearer).join("[redacted]") : message;
    output = {
      status: "error",
      error: safeMessage,
    };
  } finally {
    if (sessionId) {
      try {
        await auth(["revoke", sessionId]);
      } catch {
        cleanupWarning = "Temporary session revocation failed; it expires within five minutes.";
      }
    }
    if (bearer && output)
      output = JSON.parse(JSON.stringify(output).split(bearer).join("[redacted]"));
    bearer = undefined;
  }
  return cleanupWarning ? { ...output, warnings: [cleanupWarning] } : output;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(help);
      return;
    }
    const result = await run(options);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "error") process.exitCode = 1;
  } catch {
    process.stderr.write("Invalid invocation; use --help.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
