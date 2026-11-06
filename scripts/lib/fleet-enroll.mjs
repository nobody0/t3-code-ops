import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  atomicJson,
  readJson,
  run,
  verifyArchive,
  verifyInstalled,
  installRelease,
} from "./ko-release.mjs";
import { loadConfig, smoke } from "./ko-deployment.mjs";
import { nativeManage } from "./ko-deployment-native.mjs";
import { validateTarget, platforms } from "./fleet-inventory.mjs";
import { doctor, frontend } from "./fleet-verify.mjs";

export function preflightEnrollment(c, { minimumFreeBytes = 5 * 1024 ** 3 } = {}) {
  if (
    !platforms.has(`${process.platform}-${process.arch}`) ||
    (c.platform ?? "linux") !== process.platform
  )
    throw Error("Unsupported or mismatched device platform.");
  if (!run(c.node, ["--version"]).startsWith("v24.")) throw Error("Enrollment requires Node 24.");
  let parent = c.root;
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw Error("No deployment filesystem.");
    parent = next;
  }
  const disk = fs.statfsSync(parent);
  if (disk.bavail * disk.bsize < minimumFreeBytes)
    throw Error("Insufficient free disk for staging and recovery.");
  const tailscale = JSON.parse(run("tailscale", ["status", "--json"]));
  if (tailscale.BackendState !== "Running") throw Error("Log into Tailscale before enrollment.");
  if (process.platform === "darwin") run("launchctl", ["print", `gui/${process.getuid()}`]);
  else if (process.platform === "win32") {
    const sessions = run("quser", []);
    const user = c.userName?.split("\\").at(-1);
    if (!user || !sessions.toLowerCase().includes(user.toLowerCase()))
      throw Error("The native operator must be logged in.");
  } else if (
    run("loginctl", ["show-user", String(process.getuid()), "--property=Linger", "--value"]) !==
    "yes"
  )
    throw Error("Enable user service lingering before enrollment.");
  const userdata = path.join(c.baseDir, "userdata"),
    identity = path.join(userdata, "environment-id");
  if (fs.existsSync(userdata) && fs.readdirSync(userdata).length && !fs.existsSync(identity))
    throw Error("Existing data has no identity; inspect adoption before enrollment.");
  return {
    platform: process.platform,
    arch: process.arch,
    freeBytes: disk.bavail * disk.bsize,
    tailscale: "running",
  };
}
export function prepareEnrollment(c, { name, url, ssh }) {
  const canonical = path.join(c.root, "config.json");
  if (fs.existsSync(canonical)) {
    const prior = loadConfig(canonical);
    for (const key of [
      "root",
      "baseDir",
      "node",
      "platform",
      "service",
      "port",
      "unitDirectory",
      "userName",
    ])
      if (prior[key] !== c[key])
        throw Error("Existing deployment configuration differs; explicit adoption is required.");
  }
  const identityFile = path.join(c.baseDir, "userdata/environment-id");
  const adopted = fs.existsSync(identityFile);
  if (
    !adopted &&
    fs.existsSync(path.dirname(identityFile)) &&
    fs.readdirSync(path.dirname(identityFile)).length
  )
    throw Error("Existing data has no identity; inspect adoption before enrollment.");
  const environmentId = adopted
    ? fs.readFileSync(identityFile, "utf8").trim()
    : crypto.randomUUID();
  const target = validateTarget({
    name,
    url,
    ssh,
    environmentId,
    platform: process.platform,
    arch: process.arch,
    root: c.root,
    node: c.node,
    availability: "online",
    expectedProviders: [],
  });
  fs.mkdirSync(c.root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(canonical)) atomicJson(canonical, c);
  if (!adopted) {
    fs.mkdirSync(path.dirname(identityFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(identityFile, environmentId + "\n", { flag: "wx", mode: 0o600 });
  }
  return { target, adopted };
}
export async function enroll({
  configFile,
  artifact,
  name,
  url,
  ssh,
  preflight = preflightEnrollment,
}) {
  const c = loadConfig(configFile),
    manifest = verifyArchive(artifact);
  if (manifest.version !== c.baselineVersion)
    throw Error("Enrollment baseline differs from artifact.");
  const checks = preflight(c),
    { target, adopted } = prepareEnrollment(c, { name, url, ssh });
  const release = path.join(c.root, "releases", manifest.releaseId);
  if (fs.existsSync(release)) verifyInstalled(release);
  else installRelease(artifact, path.join(c.root, "releases"));
  const journal = fs.existsSync(path.join(c.root, "activation.json"))
    ? readJson(path.join(c.root, "activation.json"))
    : null;
  if (journal?.phase !== "active" || journal.releaseId !== manifest.releaseId)
    await nativeManage(c, "activate", manifest.releaseId, { smoke });
  const report = await doctor(c, target);
  if (
    ["nativeProcess", "localApi", "https", "authentication"].some(
      (name) => report.layers[name]?.status !== "passed",
    )
  )
    throw Error("Enrollment health checks failed; inspect this deployment before retrying.");
  await frontend(c, target, manifest, release);
  const result = {
    schemaVersion: 1,
    enrolledAt: new Date().toISOString(),
    adopted,
    target,
    preflight: checks,
    doctor: report,
    operatorSteps: [
      "Authenticate intended providers in T3 settings.",
      "Pair browser/mobile at the primary workspace origin.",
      "Enable linked environments in Labs only if agent links are intended.",
      "Add this target to the private inventory and document its KO deployment.",
    ],
  };
  atomicJson(path.join(c.root, "enrolled.json"), result);
  return result;
}
