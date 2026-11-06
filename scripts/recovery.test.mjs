import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { atomicJson } from "./lib/ko-release.mjs";
import { recoverPrestart } from "./lib/ko-recovery.mjs";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-prestart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = {
    root,
    baseDir: path.join(root, "home"),
    platform: "win32",
    service: "fixture",
    port: 3773,
  };
  const file = path.join(root, "activation.json"),
    html = "previous runtime",
    owner = 1234567;
  const service = { definition: "previous service" };
  const priorJournal = { phase: "active", releaseId: "previous" };
  const j = {
    phase: "pending",
    candidateStarted: false,
    ownerPid: owner,
    priorJournal,
    config: c,
    previous: {
      target: null,
      service,
      indexHash: crypto.createHash("sha256").update(html).digest("hex"),
    },
    maintenance: { mode: "barrier", owner: "test" },
    before: null,
  };
  fs.mkdirSync(path.join(root, "maintenance/fence"), { recursive: true });
  atomicJson(path.join(root, "maintenance/fence/owner.json"), { owner: "test" });
  atomicJson(file, j);
  fs.writeFileSync(path.join(root, "activation.lock"), String(owner));
  let starts = 0;
  const dependencies = {
    processAlive: () => false,
    databaseState: () => null,
    assertStopped: async () => {},
    adapter: {
      info: () => ({ state: starts ? "active" : "inactive" }),
      capture: () => service,
      start: () => starts++,
    },
    fetch: async () => new Response(html),
  };
  return { root, c, file, j, dependencies, priorJournal, starts: () => starts };
}
test("prestart recovery resumes an unselected initial service only for its dead recorded owner", async (t) => {
  const f = fixture(t);
  f.dependencies.processAlive = () => true;
  await assert.rejects(recoverPrestart(f.c, f.dependencies), /still be alive/);
  assert.equal(f.starts(), 0);
  f.dependencies.processAlive = () => false;
  fs.writeFileSync(path.join(f.root, "activation.lock"), "7654321");
  await assert.rejects(recoverPrestart(f.c, f.dependencies), /owner differs/);
  fs.writeFileSync(path.join(f.root, "activation.lock"), String(f.j.ownerPid));
  assert.equal((await recoverPrestart(f.c, f.dependencies)).status, "previous-service-resumed");
  assert.equal(f.starts(), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), f.priorJournal);
  assert.equal(fs.existsSync(path.join(f.root, "maintenance/fence")), false);
});
test("unknown launch, changed migration state and a different maintenance owner never resume", async (t) => {
  for (const change of ["launch", "database", "fence"]) {
    const f = fixture(t);
    if (change === "launch") atomicJson(f.file, { ...f.j, candidateStarted: true });
    if (change === "database") f.dependencies.databaseState = () => ({ migration: 80 });
    if (change === "fence")
      atomicJson(path.join(f.root, "maintenance/fence/owner.json"), { owner: "other" });
    await assert.rejects(recoverPrestart(f.c, f.dependencies));
    assert.equal(f.starts(), 0);
    assert.equal(fs.existsSync(path.join(f.root, "maintenance/fence")), true);
  }
});
