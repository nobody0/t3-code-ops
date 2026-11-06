#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { atomicJson, digest, run } from "./lib/ko-release.mjs";
const output = process.argv[2];
if (!output) throw Error("Usage: native-evidence.mjs PRIVATE_OUTPUT.json");
const root = path.resolve(import.meta.dirname, "..");
const files = [
  "scripts/ko-native-service.test.mjs",
  "scripts/ko-release.test.mjs",
  "scripts/service-supervisor-native.test.mjs",
  "scripts/native-once.test.mjs",
];
const startedAt = new Date().toISOString();
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  env: { ...process.env, KO_TEST_NATIVE: "1", KO_TEST_SYSTEMD: "1", KO_TEST_SUPERVISOR: "1" },
  stdio: "inherit",
  windowsHide: true,
  timeout: 10 * 60_000,
});
const tracked = run("git", ["ls-files"], { cwd: root })
  .split(/\r?\n/)
  .filter((f) => f.endsWith(".mjs") || f === "package.json");
const evidence = {
  schemaVersion: 1,
  platform: `${process.platform}-${process.arch}`,
  startedAt,
  checkedAt: new Date().toISOString(),
  status: result.status === 0 ? "passed" : "failed",
  toolingCommit: run("git", ["rev-parse", "HEAD"], { cwd: root }),
  dirty: Boolean(run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root })),
  files: Object.fromEntries(tracked.map((f) => [f, digest(path.join(root, f))])),
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
atomicJson(output, evidence);
process.exitCode = result.status === 0 ? 0 : 1;
