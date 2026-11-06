import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activateTransaction } from "./lib/ko-activation.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ko-activation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "activation.json"),
    previous = '{"phase":"active","releaseId":"old"}\n';
  fs.writeFileSync(file, previous);
  const calls = [],
    journal = { phase: "pending", releaseId: "new", previous: { target: "old" } };
  const operations = {
    target: "new",
    acquireMaintenance: async () => ({ release: async () => calls.push("release") }),
    stop: async () => calls.push("stop"),
    resumePrevious: async () => calls.push("resume"),
    install: async () => {
      assert.equal(JSON.parse(fs.readFileSync(file)).candidateStarted, true);
      calls.push("install");
    },
    healthy: async () => calls.push("healthy"),
    restoreEmpty: async () => calls.push("rollback"),
  };
  const safety = {
    assertIdle: async () => {},
    databaseState: () => ({ integrity: "ok" }),
    assertStopped: async () => {},
    snapshotStoppedHome: () => ({ backup: "backup", before: {} }),
    rehearseMigrations: async () => {},
    liveDatabase: () => true,
  };
  return {
    c: { root, baseDir: path.join(root, "home") },
    file,
    previous,
    calls,
    journal,
    operations,
    safety,
  };
}
test("late busy and integrity errors leave the old owner and journal untouched", async (t) => {
  for (const failure of ["late-busy", "integrity"]) {
    const f = fixture(t);
    let idle = 0;
    if (failure === "late-busy")
      f.safety.assertIdle = async () => {
        if (++idle === 2) throw Error("busy");
      };
    else
      f.safety.databaseState = () => {
        throw Error("integrity");
      };
    await assert.rejects(activateTransaction(f.c, f.journal, f.operations, f.safety));
    assert.deepEqual(f.calls, ["release"]);
    assert.equal(fs.readFileSync(f.file, "utf8"), f.previous);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.c.root, "last-activation-failure.json")))
        .candidateStarted,
      false,
    );
  }
});
test("failed backup or rehearsal resumes the unchanged previous service", async (t) => {
  for (const check of ["snapshotStoppedHome", "rehearseMigrations"]) {
    const f = fixture(t);
    f.safety[check] = () => {
      throw Error("failed rehearsal");
    };
    await assert.rejects(
      activateTransaction(f.c, f.journal, f.operations, f.safety),
      /failed rehearsal/,
    );
    assert.deepEqual(f.calls, ["stop", "resume", "release"]);
    assert.equal(fs.readFileSync(f.file, "utf8"), f.previous);
  }
});
test("the durable candidate fence precedes install and prevents post-migration binary rollback", async (t) => {
  const f = fixture(t);
  f.operations.healthy = () => {
    throw Error("candidate failed");
  };
  await assert.rejects(
    activateTransaction(f.c, f.journal, f.operations, f.safety),
    /automatic binary rollback disabled/,
  );
  assert.deepEqual(f.calls, ["stop", "install", "stop"]);
  const saved = JSON.parse(fs.readFileSync(f.file));
  assert.equal(saved.candidateStarted, true);
  assert.equal(saved.phase, "recovery-required");
});
test("a failed attempt to resume the previous service stays fenced for recovery", async (t) => {
  const f = fixture(t);
  f.operations.stop = () => {
    throw Error("partially stopped");
  };
  f.operations.resumePrevious = () => {
    throw Error("cannot resume");
  };
  await assert.rejects(
    activateTransaction(f.c, f.journal, f.operations, f.safety),
    /could not be resumed/,
  );
  assert.equal(JSON.parse(fs.readFileSync(f.file)).phase, "recovery-required");
  assert.deepEqual(f.calls, []);
});
