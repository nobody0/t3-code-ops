#!/usr/bin/env node
// A finite native worker owns its heartbeat outside the child doing blocking DB work.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicJson, readJson } from "./lib/ko-release.mjs";
import { cleanupNative } from "./lib/native-once.mjs";
import { assertExternalController } from "./lib/fleet-runner.mjs";
const file = process.argv[2],
  input = readJson(file),
  p = input.job.plan;
const directory = path.join(input.root, "rollouts", p.id),
  heartbeat = path.join(directory, "heartbeat.json");
const log = fs.openSync(path.join(directory, "worker.log"), "a", 0o600);
const save = (status) =>
  atomicJson(heartbeat, {
    schemaVersion: 1,
    planId: p.id,
    environmentId: input.environmentId,
    pid: process.pid,
    status,
    updatedAt: new Date().toISOString(),
  });
let child, timer;
try {
  assertExternalController();
  save("running");
  timer = setInterval(() => save("running"), 5000);
  child = spawn(
    process.execPath,
    [path.resolve(import.meta.dirname, "lib/fleet-worker.mjs"), file],
    { stdio: ["ignore", log, log], windowsHide: true },
  );
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  const budget = Math.min(p.activationTimeoutMs, Math.max(1, Date.parse(p.deadline) - Date.now()));
  const deadline = setTimeout(() => child.kill(), budget);
  const code = await exited;
  clearTimeout(deadline);
  save(code === 0 ? "completed" : "failed");
  process.exitCode = code === 0 ? 0 : 1;
} catch {
  save("failed");
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  fs.closeSync(log);
  try {
    cleanupNative(input.nativeJob, input.platform, directory);
  } catch {}
}
