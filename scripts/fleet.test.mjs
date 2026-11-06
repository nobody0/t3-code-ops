import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateInventory, selectTargets } from "./lib/fleet-inventory.mjs";
import { planHash, validatePlan } from "./lib/fleet-plan.mjs";
import { runRollout, windowsAncestryScript } from "./lib/fleet-runner.mjs";
import { pairingArgs, sessionSummary, runPair } from "./pair-fleet.mjs";
import { executeSource, shellQuote } from "./lib/fleet-transport.mjs";
import { atomicJson, run } from "./lib/ko-release.mjs";
import { DatabaseSync } from "node:sqlite";
import { preservedDatabase } from "./lib/fleet-verify.mjs";

const target = {
  name: "test",
  environmentId: "00000000-0000-4000-8000-000000000001",
  platform: process.platform,
  arch: process.arch,
  node: process.execPath,
  root: path.join(os.tmpdir(), "fleet-unused"),
  availability: "online",
};
function plan(targets = [target]) {
  const release = {
    version: "0.1.7",
    releaseId: "0.1.7-ko-aaaaaaaaaaaa-bbbbbbbb",
    commit: "a".repeat(40),
    opsCommit: "b".repeat(40),
    sha256: "c".repeat(64),
    platformLocks: Object.fromEntries(targets.map((t) => [`${t.platform}-${t.arch}`, {}])),
  };
  const body = {
    schemaVersion: 1,
    sourceCommit: release.commit,
    runtimeOpsCommit: release.opsCommit,
    toolingCommit: "d".repeat(40),
    release,
    targets,
    deadline: new Date(Date.now() + 120_000).toISOString(),
    activationTimeoutMs: 60_000,
    nativeEvidence: [...new Set(targets.map((t) => `${t.platform}-${t.arch}`))].map((platform) => ({
      platform,
      status: "passed",
      dirty: false,
      toolingCommit: "d".repeat(40),
      checkedAt: new Date().toISOString(),
      files: {},
    })),
  };
  return { ...body, id: planHash(body) };
}
const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
test("verification preserves original history and grants while allowing new events and columns", (t) => {
  const root = temporary(t),
    backup = path.join(root, "backup.sqlite"),
    live = path.join(root, "live.sqlite");
  const before = new DatabaseSync(backup);
  before.exec(
    "CREATE TABLE orchestration_events(sequence INTEGER,payload TEXT);INSERT INTO orchestration_events VALUES(1,'original');CREATE TABLE auth_sessions(session_id TEXT,subject TEXT,scopes TEXT,method TEXT,issued_at TEXT,expires_at TEXT,revoked_at TEXT);INSERT INTO auth_sessions VALUES('grant','browser','[]','pair','2026-01-01','2099-01-01',NULL);",
  );
  before.close();
  fs.copyFileSync(backup, live);
  const after = new DatabaseSync(live);
  after.exec(
    "ALTER TABLE orchestration_events ADD COLUMN added TEXT;INSERT INTO orchestration_events(sequence,payload) VALUES(2,'new');",
  );
  assert.deepEqual(preservedDatabase(backup, live), { events: 1, sessions: 1 });
  after.exec("UPDATE auth_sessions SET scopes='changed';");
  assert.throws(() => preservedDatabase(backup, live), /session grant changed/);
  after.exec(
    "UPDATE auth_sessions SET scopes='[]';UPDATE orchestration_events SET payload='changed' WHERE sequence=1;",
  );
  assert.throws(() => preservedDatabase(backup, live), /history changed/);
  after.close();
});
test("one inventory rejects duplicate identities, ambiguous selections and credentials", () => {
  const i = { schemaVersion: 1, targets: [target] };
  assert.equal(validateInventory(i).targets.length, 1);
  assert.throws(
    () => validateInventory({ ...i, targets: [target, { ...target, name: "second" }] }),
    /Duplicate/,
  );
  assert.throws(
    () => validateInventory({ ...i, targets: [{ ...target, token: "secret" }] }),
    /Credentials/,
  );
  assert.throws(() => selectTargets(i, "test,missing"), /Unknown/);
  assert.throws(() => selectTargets(i, "test,test"), /duplicate/);
  assert.throws(
    () => validateInventory({ ...i, targets: [{ ...target, ssh: "-oProxyCommand=bad" }] }),
    /SSH/,
  );
});
test("frozen plans detect target, release and deadline edits", () => {
  const p = plan();
  assert.equal(validatePlan(p).id, p.id);
  for (const change of [
    { deadline: "2099-01-01" },
    { sourceCommit: "e".repeat(40) },
    { targets: [] },
  ])
    assert.throws(() => validatePlan({ ...p, ...change }), /changed/);
});
test("a disconnected controller resumes the same native worker and does not reactivate", async (t) => {
  const directory = temporary(t),
    p = plan();
  let starts = 0,
    calls = 0;
  const observed = {
    releaseId: p.release.releaseId,
    commit: p.sourceCommit,
    sha256: p.release.sha256,
  };
  const verified = {
    status: "verified",
    planId: p.id,
    environmentId: target.environmentId,
    toolingCommit: p.toolingCommit,
  };
  let phase = "fresh";
  const call = async (_t, job) => {
    calls++;
    if (job.action === "start") {
      starts++;
      phase = "running";
      return { status: "started" };
    }
    if (phase === "fresh") return { staged: { planId: p.id } };
    if (phase === "running")
      return {
        staged: { planId: p.id },
        heartbeat: { status: "running", updatedAt: new Date().toISOString() },
      };
    return { observed, receipt: verified };
  };
  let r = await runRollout(p, directory, { call, externalCheck: () => {} });
  assert.equal(r.status, "partial");
  assert.equal(starts, 1);
  r = await runRollout(p, directory, { call, externalCheck: () => {} });
  assert.equal(r.status, "partial");
  assert.equal(starts, 1);
  phase = "verified";
  r = await runRollout(p, directory, { call, externalCheck: () => {} });
  assert.equal(r.status, "completed");
  assert.equal(starts, 1);
  assert.ok(calls >= 4);
});
test("an unavailable target, stale heartbeat or failed canary cannot report fleet completion", async (t) => {
  const second = {
    ...target,
    name: "second",
    root: target.root + "2",
    environmentId: "00000000-0000-4000-8000-000000000002",
  };
  for (const mode of ["offline", "stale", "failed"]) {
    const directory = temporary(t),
      p = plan([{ ...target, availability: mode === "offline" ? "offline" : "online" }, second]);
    let started = false,
      secondTouched = false;
    const r = await runRollout(p, directory, {
      externalCheck: () => {},
      call: async (t, job) => {
        if (t.name === "second") secondTouched = true;
        if (job.action === "start") started = true;
        return mode === "stale"
          ? { heartbeat: { status: "running", updatedAt: "2000-01-01" } }
          : mode === "failed"
            ? { receipt: { status: "failed" } }
            : { staged: { planId: p.id } };
      },
    });
    assert.notEqual(r.status, "completed");
    assert.equal(started, false);
    assert.equal(secondTouched, false);
  }
});
test("pairing delegates default scopes/lifetime to upstream and never turns expiry into a credential", () => {
  const args = pairingArgs("codes");
  assert.ok(!args.includes("--scope"));
  assert.ok(!args.includes("--session-ttl"));
  assert.equal(
    pairingArgs("codes", { scopes: "standard" }).filter((x) => x === "--scope").length,
    13,
  );
  assert.throws(() => pairingArgs("revoke", { ids: ["--all"] }));
  const summary = sessionSummary(
    { sessionId: "one", subject: "browser", scopes: [], expiresAt: "2026-11-08T00:00:00Z" },
    Date.parse("2026-11-06T00:00:00Z"),
  );
  assert.equal(summary.expiry, "renew-soon");
  assert.equal(summary.connectionsSettings, "missing-permission");
  assert.ok(!("token" in summary));
});
test("transport preserves literal paths and Unicode without shell interpolation", async () => {
  const value = "quote ' dollar $() backtick ` umlaut ü";
  const result = await executeSource(
    target,
    `console.log(JSON.stringify({value:${JSON.stringify(value)}}))`,
  );
  assert.equal(result.value, value);
  assert.equal(shellQuote("a'b", "linux"), "'a'\\''b'");
  await assert.rejects(
    executeSource(target, "console.error('SECRET-do-not-relay');process.exit(1)"),
    (e) => !e.message.includes("SECRET"),
  );
});
test("pairing verifies target identity before invoking its CLI", async (t) => {
  const root = temporary(t);
  atomicJson(path.join(root, "config.json"), {
    root,
    baseDir: path.join(root, "home"),
    node: process.execPath,
  });
  const t2 = { ...target, root };
  await assert.rejects(runPair(t2, pairingArgs("sessions")), /worker failure/);
});
test(
  "Windows rejects agent or app ancestors even above a native scheduler",
  { skip: process.platform !== "win32" },
  () => {
    const invoke = (name, command) => {
      const prefix =
        "function Get-CimInstance {param($ClassName,$Filter) if($ClassName -eq 'Win32_Service'){return @{Name='Schedule'}};$n=[int]($Filter -replace 'ProcessId=','');if($n -eq 101){return @{Name='svchost.exe';CommandLine='scheduler';ParentProcessId=102}};if($n -eq 102){return @{Name='" +
        name +
        "';CommandLine='" +
        command +
        "';ParentProcessId=0}}};";
      return run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(prefix + windowsAncestryScript(101), "utf16le").toString("base64"),
      ]);
    };
    invoke("services.exe", "native");
    for (const [name, command] of [
      ["codex.exe", "agent"],
      ["claude.exe", "agent"],
      ["node.exe", "node C:\\tools\\serve-t3.mjs"],
      ["node.exe", "node C:\\runtime\\node_modules\\t3\\dist\\bin.mjs"],
    ])
      assert.throws(() => invoke(name, command));
  },
);
