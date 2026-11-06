import fs from "node:fs";
import path from "node:path";
import { atomicJson, readJson } from "./ko-release.mjs";
import { platformAdapter, optionalFile } from "./ko-service-platforms.mjs";
import { databaseState, assertStopped } from "./ko-safety.mjs";

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw Error("Invalid recorded process owner.");
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
}
// This command recovers only a persisted proof that candidate launch was never attempted.
// Migrated/unknown journals always require matched, incident-specific data recovery.
export async function recoverPrestart(c, dependencies = {}) {
  const file = path.join(c.root, "activation.json"),
    j = readJson(file);
  if (j.phase !== "pending" || j.candidateStarted !== false || !Object.hasOwn(j, "priorJournal"))
    throw Error("No proven pre-candidate interruption. Use the matched recovery runbook.");
  for (const key of ["root", "baseDir", "service", "port", "platform", "unitDirectory", "userName"])
    if (j.config?.[key] !== c[key]) throw Error("Recovery configuration differs.");
  const alive = dependencies.processAlive ?? processAlive;
  if (alive(j.ownerPid)) throw Error("Activation owner may still be alive.");
  const lock = path.join(c.root, "activation.lock");
  if (fs.existsSync(lock)) {
    if (Number(fs.readFileSync(lock, "utf8").trim()) !== j.ownerPid)
      throw Error("Activation lock owner differs from the journal.");
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, "wx", 0o600);
  fs.writeFileSync(fd, String(process.pid));
  try {
    const linux = (c.platform ?? "linux") === "linux",
      expected = j.previous.target ?? j.previous.link ?? null;
    let selected = null;
    try {
      selected = linux
        ? fs.realpathSync(path.join(c.root, "current"))
        : readJson(path.join(c.root, "current.json")).target;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      (selected === null) !== (expected === null) ||
      (selected !== null && path.resolve(selected) !== path.resolve(expected))
    )
      throw Error("Previous selection changed.");
    const adapter = dependencies.adapter ?? platformAdapter(c);
    const fence = path.join(c.root, "maintenance/fence");
    if (
      j.maintenance?.mode === "barrier" &&
      readJson(path.join(fence, "owner.json")).owner !== j.maintenance.owner
    )
      throw Error("Maintenance owner differs.");
    if (linux) {
      if (
        optionalFile(path.join(c.unitDirectory, c.service + ".d/90-ko-fork.conf")) !==
        j.previous.override
      )
        throw Error("Previous service definition changed.");
    } else if (JSON.stringify(adapter.capture()) !== JSON.stringify(j.previous.service))
      throw Error("Previous service definition changed.");
    const database = (dependencies.databaseState ?? databaseState)(c.baseDir);
    if (Object.hasOwn(j, "before") && JSON.stringify(database) !== JSON.stringify(j.before))
      throw Error("Previous database migration state changed.");
    atomicJson(file, { ...j, ownerPid: process.pid, stage: "resuming-previous" });
    if (adapter.info().state !== "active") {
      await (dependencies.assertStopped ?? assertStopped)(c);
      // The service ownership chain and its API are stopped. Empty stale admission directories
      // are safe to retire; no arbitrary recursive paths or live permits are removed.
      const admissions = path.join(c.root, "maintenance/admissions");
      if (fs.existsSync(admissions))
        for (const name of fs.readdirSync(admissions)) {
          if (!/^permit-[a-zA-Z0-9]+$/.test(name)) throw Error("Unknown admission state.");
          fs.rmdirSync(path.join(admissions, name));
        }
      adapter.start();
    }
    // Client hash + native owner must agree before reopening intake.
    const { createHash } = await import("node:crypto");
    const deadline = Date.now() + 60_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const response = await (dependencies.fetch ?? fetch)(`http://127.0.0.1:${c.port}/`, {
          signal: AbortSignal.timeout(2000),
        });
        healthy =
          response.ok &&
          adapter.info().state === "active" &&
          createHash("sha256")
            .update(Buffer.from(await response.arrayBuffer()))
            .digest("hex") === j.previous.indexHash;
      } catch {}
      if (healthy) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) throw Error("Previous service health differs.");
    if (j.priorJournal) atomicJson(file, j.priorJournal);
    else fs.unlinkSync(file);
    if (j.maintenance?.mode === "barrier") {
      if (readJson(path.join(fence, "owner.json")).owner !== j.maintenance.owner)
        throw Error("Maintenance owner differs.");
      fs.unlinkSync(path.join(fence, "owner.json"));
      fs.rmdirSync(fence);
    }
    atomicJson(path.join(c.root, "prestart-recovered.json"), {
      at: new Date().toISOString(),
      releaseId: j.releaseId,
      previousServiceResumed: true,
    });
    return { status: "previous-service-resumed" };
  } catch (error) {
    atomicJson(file, {
      ...j,
      phase: "recovery-required",
      stage: "recovery-required",
      recoveryFailure: "Prestart recovery could not prove unchanged ownership and health.",
    });
    throw error;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
