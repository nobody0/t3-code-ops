import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, readJson } from "./ko-release.mjs";
import { liveDatabase, installedCli } from "./ko-safety.mjs";

export async function acquireMaintenance(c, { timeoutMs = 30_000 } = {}) {
  if (!liveDatabase(c.baseDir)) return { mode: "fresh", release: async () => {} };
  const cli = installedCli(c);
  const manifest = readJson(path.resolve(path.dirname(cli[1]), "../../../release.json"));
  if (manifest.maintenanceProtocol !== 1) {
    if (c.allowLegacyDrain !== true)
      throw Error(
        "Current app has no maintenance barrier. An explicitly reviewed legacy-drain transition is required.",
      );
    return { mode: "legacy-drain", release: async () => {} };
  }
  const directory = path.join(c.root, "maintenance"),
    admissions = path.join(directory, "admissions");
  if (
    readJson(path.join(directory, "protocol.json")).protocol !== 1 ||
    !fs.statSync(admissions).isDirectory()
  )
    throw Error("The running app has not acknowledged the maintenance protocol.");
  const fence = path.join(directory, "fence"),
    owner = crypto.randomUUID();
  fs.mkdirSync(fence, { mode: 0o700 }); // Exclusive; an interrupted owner's fence is never stolen.
  atomicJson(path.join(fence, "owner.json"), {
    owner,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  const release = async () => {
    if (readJson(path.join(fence, "owner.json")).owner !== owner)
      throw Error("Maintenance owner changed.");
    fs.unlinkSync(path.join(fence, "owner.json"));
    fs.rmdirSync(fence);
  };
  try {
    const deadline = Date.now() + timeoutMs;
    while (fs.readdirSync(admissions).length) {
      if (Date.now() >= deadline)
        throw Error(
          "Admissions did not drain; old service retained. Inspect stale permits after a crash.",
        );
      await delay(100);
    }
    return { owner, mode: "barrier", release };
  } catch (error) {
    await release();
    throw error;
  }
}
