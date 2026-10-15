#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { monitorLiveness, backoffDelay, sleepUnlessAborted } from "./lib/service-monitor.mjs";

const [configPath, target, extra] = process.argv.slice(2);
if (!configPath || !target || extra)
  throw Error("Usage: node serve-t3.mjs CONFIG.json RELEASE_DIRECTORY");
const c = JSON.parse(fs.readFileSync(configPath, "utf8"));
const runtime = path.join(c.root, "service-runtime.json");
const logFile = path.join(c.root, "service-supervisor.log");
const instanceId = crypto.randomUUID(),
  token = crypto.randomBytes(32).toString("base64url");
const stop = new AbortController();
let child = null,
  generation = 0,
  phase = "starting",
  lastProbe = null;
function rotate(file, limit) {
  if (fs.existsSync(file) && fs.statSync(file).size >= limit) {
    fs.rmSync(file + ".1", { force: true });
    fs.renameSync(file, file + ".1");
  }
}
function log(message) {
  rotate(logFile, 1024 * 1024);
  fs.appendFileSync(logFile, `${new Date().toISOString()} [supervisor] ${message}\n`, {
    mode: 0o600,
  });
}
// The native wrapper can vanish while this process runs on. Its broken console
// pipes must not crash the supervisor, and fatal errors belong in its own log.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
process.on("uncaughtException", (error) => {
  try {
    log(`fatal ${error?.stack ?? error}`);
  } finally {
    process.exit(1);
  }
});
// Windows wrappers relay console output through pipes that die with them, so the
// app child writes to its log files directly. Other managers own durable streams.
const ownLogs = c.platform === "win32";
function openAppLog(name) {
  const file = path.join(c.root, name);
  try {
    rotate(file, 64 * 1024 * 1024);
  } catch {
    /* a lingering reader keeps the file; rotate at the next start */
  }
  return fs.openSync(file, "a", 0o600);
}
function state() {
  return {
    service: "t3-supervisor",
    instanceId,
    pid: process.pid,
    childPid: child?.pid ?? null,
    generation,
    phase,
    lastProbe,
    target,
  };
}
function save() {
  const temporary = runtime + `.${instanceId}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...state(), controlOrigin, token }) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temporary, runtime);
}
async function probe() {
  try {
    const res = await fetch(`http://127.0.0.1:${c.port}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    const body = await res.json();
    const expected = fs
      .readFileSync(path.join(c.baseDir, "userdata/environment-id"), "utf8")
      .trim();
    return { kind: res.ok && body.environmentId === expected ? "healthy" : "other" };
  } catch {
    return { kind: "down" };
  }
}
async function occupied() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: c.port });
    socket.setTimeout(1000);
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (e) => finish(e.code !== "ECONNREFUSED"));
  });
}
function inhibited(initial = false) {
  const installation = path.join(c.root, "supervisor-installing.json");
  if (initial && fs.existsSync(installation)) {
    const claim = JSON.parse(fs.readFileSync(installation, "utf8"));
    const lock = path.join(c.root, "activation.lock");
    if (
      claim.target === target &&
      fs.existsSync(lock) &&
      fs.readFileSync(lock, "utf8").trim() === String(claim.ownerPid)
    ) {
      try {
        process.kill(claim.ownerPid, 0);
        return false;
      } catch {
        /* stale installer */
      }
    }
  }
  const journalFile = path.join(c.root, "activation.json");
  if (fs.existsSync(journalFile)) {
    const j = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    if (j.phase === "pending" && initial && j.releaseId === path.basename(target)) return false;
    if (!["active", "rolled-back"].includes(j.phase)) return true;
  }
  return fs.existsSync(path.join(c.root, "activation.lock"));
}
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  if (req.url === "/status" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(state()));
  } else if (req.url === "/stop" && req.method === "POST") {
    res.writeHead(202).end();
    stop.abort();
  } else res.writeHead(404).end();
});
// The control listener is also the ownership lock. The OS releases it on crashes
// and reboot, and a second wrapper cannot claim it or start a second app child.
const controlPort = c.supervisorPort ?? c.port + 1;
async function claim() {
  try {
    server.listen(controlPort, "127.0.0.1");
    await once(server, "listening");
    return true;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    return false;
  }
}
async function currentOwner() {
  try {
    const r = JSON.parse(fs.readFileSync(runtime, "utf8"));
    if (r.controlOrigin !== `http://127.0.0.1:${controlPort}`) return null;
    const res = await fetch(r.controlOrigin + "/status", {
      headers: { authorization: `Bearer ${r.token}` },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    const s = await res.json();
    return res.ok && s.service === "t3-supervisor" && s.instanceId === r.instanceId ? s : null;
  } catch {
    return null;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
// A replacement native wrapper adopts a verified supervisor that outlived its
// predecessor instead of failing beside it: it keeps the native service occupied
// while that owner runs, then exits so the service starts a fresh supervisor.
let waiting = false;
while (!(await claim())) {
  const owner = await currentOwner();
  if (owner) {
    log(`adopting supervisor pid=${owner.pid} instance=${owner.instanceId}`);
    while (alive(owner.pid)) await sleep(1000);
    log(`adopted supervisor pid=${owner.pid} ended; exiting for native restart`);
    process.exit(1);
  }
  if (!waiting) log(`control port ${controlPort} is busy without a verifiable owner; waiting`);
  waiting = true;
  await sleep(5000);
}
const controlOrigin = `http://127.0.0.1:${server.address().port}`;
if (fs.existsSync(runtime)) {
  fs.rmSync(runtime + ".previous", { force: true });
  fs.renameSync(runtime, runtime + ".previous");
}
fs.writeFileSync(runtime, JSON.stringify({ ...state(), controlOrigin, token }), {
  flag: "wx",
  mode: 0o600,
});
const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
  const fn = () => stop.abort();
  process.on(signal, fn);
  return [signal, fn];
});
async function terminate(owned) {
  if (!owned.pid || owned.exitCode !== null || owned.signalCode !== null) return;
  // Only the ChildProcess created by this wrapper is eligible for termination.
  owned.kill("SIGTERM");
  const exited = once(owned, "exit").then(() => true);
  const abort = new AbortController();
  if (!(await Promise.race([exited, sleepUnlessAborted(5000, abort.signal).then(() => false)]))) {
    owned.kill("SIGKILL");
    await exited;
  }
  abort.abort();
}
let failures = 0;
try {
  while (!stop.signal.aborted) {
    if (inhibited(generation === 0) || (await occupied())) {
      phase = "blocked";
      save();
      await sleepUnlessAborted(5000, stop.signal);
      continue;
    }
    generation++;
    phase = "starting";
    const env = { ...process.env, T3_KO_MANAGED: "1", T3CODE_HOME: c.baseDir };
    delete env.T3_BOOT_SERVICE_UNIT;
    delete env.T3_SERVICE_LAUNCHER_CONTEXT;
    const output = ownLogs ? ["service.stdout.log", "service.stderr.log"].map(openAppLog) : null;
    try {
      child = spawn(
        c.node,
        [
          path.join(target, "node_modules/t3/dist/bin.mjs"),
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          String(c.port),
          "--base-dir",
          c.baseDir,
        ],
        {
          cwd: c.baseDir,
          env,
          stdio: output ? ["ignore", ...output] : "inherit",
          windowsHide: true,
        },
      );
      await once(child, "spawn");
    } finally {
      for (const fd of output ?? []) fs.closeSync(fd);
    }
    const owned = child,
      started = Date.now();
    save();
    log(`generation=${generation} child=${owned.pid} started`);
    const monitorAbort = new AbortController();
    const exit = once(owned, "exit").then(([code, signal]) => ({ reason: "exit", code, signal }));
    const stopped = () => monitorAbort.abort();
    stop.signal.addEventListener("abort", stopped, { once: true });
    const policy = {
      startupGraceMs: 90_000,
      intervalMs: 10_000,
      failureLimit: 2,
      failureSpanMs: 60_000,
      ...c.supervision,
    };
    const outcome = await Promise.race([
      exit,
      monitorLiveness({
        signal: monitorAbort.signal,
        probe,
        ...policy,
        onProbe: (result) => {
          lastProbe = result.kind;
          phase = result.kind === "healthy" ? "ready" : "degraded";
          save();
        },
      }).then((reason) => ({ reason })),
    ]);
    monitorAbort.abort();
    stop.signal.removeEventListener("abort", stopped);
    if (outcome.reason !== "exit" && !stop.signal.aborted) {
      while (inhibited() && !stop.signal.aborted) {
        phase = "blocked";
        save();
        await sleepUnlessAborted(1000, stop.signal);
      }
    }
    await terminate(owned);
    await exit;
    child = null;
    save();
    if (stop.signal.aborted) break;
    if (Date.now() - started >= 60_000) failures = 0;
    const delay = backoffDelay(failures++, 1000, 300_000);
    phase = "restarting";
    save();
    const ended = outcome.reason === "exit" ? ` code=${outcome.code} signal=${outcome.signal}` : "";
    log(`generation=${generation} ended reason=${outcome.reason}${ended}; retry=${delay}ms`);
    await sleepUnlessAborted(delay, stop.signal);
  }
} finally {
  phase = "stopping";
  if (child) await terminate(child);
  for (const [signal, fn] of handlers) process.off(signal, fn);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (JSON.parse(fs.readFileSync(runtime, "utf8")).instanceId === instanceId) fs.rmSync(runtime);
  log("wrapper stopped");
}
