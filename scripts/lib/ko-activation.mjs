import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicJson } from "./ko-release.mjs";
import * as safety from "./ko-safety.mjs";

// Shared transaction policy. Platform adapters own service mechanics, never recovery policy.
export async function activateTransaction(c, journal, operations, overrides = {}) {
  const checks = { ...safety, ...overrides };
  const file = path.join(c.root, "activation.json");
  const save = (stage, details = {}) => {
    Object.assign(journal, { stage, updatedAt: new Date().toISOString() }, details);
    atomicJson(file, journal);
    operations.onPhase?.(journal);
  };
  const previousJournal = fs.existsSync(file) ? fs.readFileSync(file) : null;
  journal.ownerPid = process.pid;
  journal.priorJournal = previousJournal ? JSON.parse(previousJournal) : null;
  let stopped = false,
    candidateStarted = false;
  let maintenance;
  try {
    maintenance = await operations.acquireMaintenance?.();
    journal.maintenance = maintenance ? { owner: maintenance.owner, mode: maintenance.mode } : null;
    save("draining", { candidateStarted: false });
    // A late busy response must restore the prior journal without stopping T3.
    await checks.assertIdle(c);
    const before = checks.databaseState(c.baseDir);
    save("draining", { before });
    await checks.assertIdle(c);
    if (before) {
      save("stopping");
      stopped = true; // A failing stop can still have stopped part of the ownership chain.
      await operations.stop();
      await checks.assertStopped(c);
      save("backing-up");
      journal.safety = checks.snapshotStoppedHome(c, journal.previous);
      save("backed-up");
      await checks.rehearseMigrations(c, operations.target, journal.safety);
      save("rehearsed");
    }
    // Persist this fence BEFORE starting anything that can migrate live state.
    candidateStarted = true;
    save("starting-candidate", { candidateStarted: true });
    await operations.install();
    save("verifying");
    await operations.healthy();
    save("verified", { phase: "active", after: checks.databaseState(c.baseDir) });
    return journal;
  } catch (error) {
    if (!candidateStarted) {
      try {
        if (stopped) {
          save("resuming-previous", { candidateStarted: false });
          await operations.resumePrevious();
        }
        if (previousJournal) {
          const temporary = file + "." + crypto.randomUUID() + ".restore.tmp";
          fs.writeFileSync(temporary, previousJournal, { flag: "wx", mode: 0o600 });
          fs.renameSync(temporary, file);
        } else fs.rmSync(file, { force: true });
        atomicJson(path.join(c.root, "last-activation-failure.json"), {
          releaseId: journal.releaseId,
          at: new Date().toISOString(),
          stage: journal.stage ?? "preflight",
          candidateStarted: false,
          previousServicePreserved: true,
          error: error.message,
        });
      } catch (recovery) {
        save("recovery-required", {
          phase: "recovery-required",
          failure: error.message,
          recoveryFailure: recovery.message,
        });
        throw new AggregateError(
          [error, recovery],
          "Previous service could not be resumed; inspect recovery state.",
        );
      }
      throw error;
    }
    if (checks.liveDatabase(c.baseDir)) {
      let stopFailure;
      try {
        await operations.stop();
      } catch (e) {
        stopFailure = e.message;
      }
      save("recovery-required", {
        phase: "recovery-required",
        failure: error.message,
        stopFailure,
      });
      throw new Error(
        "Activation failed; automatic binary rollback disabled. Review the backup and database before agent recovery.",
        { cause: error },
      );
    }
    try {
      await operations.restoreEmpty();
      save("rolled-back", { phase: "rolled-back", failure: error.message });
    } catch (recovery) {
      throw new AggregateError(
        [error, recovery],
        "Activation and rollback failed; transaction retained for manual recovery.",
        { cause: recovery },
      );
    }
    throw new Error("Activation failed; previous service restored: " + error.message, {
      cause: error,
    });
  } finally {
    // A recovery-required candidate stays fenced. Its recovery operator releases it.
    if (journal.phase !== "recovery-required") await maintenance?.release();
  }
}
