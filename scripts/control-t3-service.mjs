#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig, readRecovery } from "./lib/ko-deployment.mjs";
import { platformAdapter } from "./lib/ko-service-platforms.mjs";

const [operation, configPath, extra] = process.argv.slice(2);
if (!configPath || extra || !["status", "start", "stop"].includes(operation))
  throw Error("Usage: node control-t3-service.mjs status|start|stop CONFIG.json");
const c = loadConfig(configPath),
  adapter = platformAdapter(c);
const marker = path.join(c.root, "service-stopped");
let lockFd;
const lock = path.join(c.root, "activation.lock");
if (operation !== "status") {
  const recovery = readRecovery(c);
  if (
    recovery.configMismatch.length ||
    (recovery.transaction && !["active", "rolled-back"].includes(recovery.transaction.phase))
  )
    throw Error("Resolve deployment recovery before changing service intent.");
  lockFd = fs.openSync(lock, "wx", 0o600);
  fs.writeFileSync(lockFd, String(process.pid));
}
try {
  if (operation === "stop") {
    fs.writeFileSync(marker, "Intentional stop; use control-t3-service start to resume.\n", {
      mode: 0o600,
    });
    adapter.suspend();
    adapter.stop();
  } else if (operation === "start") {
    fs.rmSync(marker, { force: true });
    adapter.resume();
    adapter.start();
  }
} finally {
  if (lockFd !== undefined) {
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}
const native = adapter.info();
const runtimeFile = path.join(c.root, "service-runtime.json");
let wrapper = null;
if (fs.existsSync(runtimeFile)) {
  const r = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  const running = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  };
  // A replacement native wrapper adopts a supervisor that outlived its predecessor.
  const ownership =
    native.state !== "active"
      ? null
      : String(r.pid) === String(native.pid)
        ? "native"
        : running(r.pid)
          ? "adopted"
          : null;
  if (ownership)
    wrapper = {
      ownership,
      pid: r.pid,
      childPid: r.childPid,
      phase: r.phase,
      lastProbe: r.lastProbe,
      generation: r.generation,
      target: r.target,
    };
}
console.log(
  JSON.stringify(
    { service: c.service, native, wrapper, intentionallyStopped: fs.existsSync(marker) },
    null,
    2,
  ),
);
