import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  atomicJson,
  readJson,
  run,
  verifyArchive,
  verifyInstalled,
  installRelease,
  digest,
} from "./ko-release.mjs";
import { validatePlan, verifyToolchain } from "./fleet-plan.mjs";
import { loadConfig, manage } from "./ko-deployment.mjs";
import { probe, doctor, verifyDeployment } from "./fleet-verify.mjs";
import { installedCli, verifyMigrationSource } from "./ko-safety.mjs";
import { nativeOnce } from "./native-once.mjs";

const paths = (root, p) => ({
  chain: path.join(root, "toolchains", p.toolingCommit),
  directory: path.join(root, "rollouts", p.id),
  staged: path.join(root, "rollouts", p.id, "staged.json"),
  receipt: path.join(root, "rollouts", p.id, "receipt.json"),
});
export function verifyDevice(root, environmentId, platform, arch) {
  const c = loadConfig(path.join(root, "config.json"));
  if (
    path.resolve(c.root) !== path.resolve(root) ||
    (c.platform ?? "linux") !== platform ||
    process.platform !== platform ||
    process.arch !== arch
  )
    throw Error("Device configuration or platform mismatch.");
  if (
    fs.readFileSync(path.join(c.baseDir, "userdata/environment-id"), "utf8").trim() !==
    environmentId
  )
    throw Error("Device identity mismatch.");
  return c;
}
function extract(archive, directory, sha) {
  if (digest(archive) !== sha) throw Error("Bundle checksum mismatch.");
  const entries = run("tar", ["-tf", archive]).split(/\r?\n/);
  if (
    entries.some(
      (n) =>
        n.startsWith("/") || n.includes("\\") || n.split("/").includes("..") || /^[a-z]:/i.test(n),
    )
  )
    throw Error("Unsafe archive path.");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  run("tar", ["-xf", archive, "-C", directory], { timeout: 15 * 60_000 });
}
function prepareSource(c, p) {
  const source = path.join(c.root, "sources", p.sourceCommit);
  const fresh = !fs.existsSync(source);
  if (fresh)
    run("git", ["clone", "--no-checkout", p.release.repository, source], { timeout: 15 * 60_000 });
  if (!fresh && run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: source }))
    throw Error("Migration checkout is dirty.");
  if (fresh || run("git", ["rev-parse", "HEAD"], { cwd: source }) !== p.sourceCommit) {
    run("git", ["fetch", "origin", p.sourceCommit], { cwd: source, timeout: 15 * 60_000 });
    run("git", ["checkout", "--detach", p.sourceCommit], { cwd: source });
  }
  if (!fs.existsSync(path.join(source, "apps/server/node_modules/effect/dist/Effect.js"))) {
    if (
      !Array.isArray(c.packageManagerArgv) ||
      !c.packageManagerArgv.length ||
      c.packageManagerArgv.some((x) => typeof x !== "string" || !x)
    )
      throw Error("Configure packageManagerArgv for the pinned source dependency installation.");
    run(
      c.packageManagerArgv[0],
      [
        ...c.packageManagerArgv.slice(1),
        "--filter",
        "@t3tools/monorepo",
        "--filter",
        "@t3tools/web...",
        "--filter",
        "t3...",
        "--filter",
        "@t3tools/scripts...",
        "--filter",
        "@t3tools/oxlint-plugin-t3code...",
        "install",
        "--frozen-lockfile",
      ],
      { cwd: source, timeout: 30 * 60_000 },
    );
  }
  return source;
}
export async function dispatch(input) {
  const { root, environmentId, platform, arch, job } = input;
  const p = validatePlan(job.plan),
    t = p.targets.find((t) => t.environmentId === environmentId);
  if (
    !t ||
    path.resolve(t.root) !== path.resolve(root) ||
    t.platform !== platform ||
    t.arch !== arch ||
    job.toolingCommit !== p.toolingCommit
  )
    throw Error("Target differs from frozen plan.");
  const files = paths(root, p);
  verifyToolchain(files.chain, p);
  const c = verifyDevice(root, environmentId, platform, arch);
  fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 });
  if (job.action === "status") {
    const activation = fs.existsSync(path.join(root, "activation.json"))
      ? readJson(path.join(root, "activation.json"))
      : null;
    let observed = null;
    try {
      const m = verifyInstalled(path.resolve(path.dirname(installedCli(c)[1]), "../../.."));
      observed = { releaseId: m.releaseId, commit: m.commit, sha256: m.sha256 };
    } catch {}
    const heartbeat = path.join(files.directory, "heartbeat.json");
    return {
      observed,
      heartbeat: fs.existsSync(heartbeat) ? readJson(heartbeat) : null,
      staged: fs.existsSync(files.staged) ? readJson(files.staged) : null,
      receipt: fs.existsSync(files.receipt) ? readJson(files.receipt) : null,
      activation: activation
        ? {
            phase: activation.phase,
            stage: activation.stage,
            candidateStarted: activation.candidateStarted,
            updatedAt: activation.updatedAt,
          }
        : null,
    };
  }
  if (job.action === "start") {
    if (!fs.existsSync(files.staged)) throw Error("Stage the frozen plan first.");
    const heartbeat = path.join(files.directory, "heartbeat.json");
    if (fs.existsSync(heartbeat)) {
      const h = readJson(heartbeat);
      if (h.status === "running") {
        if (Date.now() - Date.parse(h.updatedAt) > 30_000)
          throw Error("Native worker heartbeat is stale. Inspect before resuming.");
        return { status: "running" };
      }
    }
    const nativeJob = "t3-fleet-" + p.id.slice(0, 16),
      file = path.join(files.directory, "input.json");
    atomicJson(file, { ...input, nativeJob, job: { ...job, action: "activate" } });
    return nativeOnce({
      name: nativeJob,
      node: c.node,
      args: [path.join(files.chain, "scripts/fleet-job.mjs"), file],
      directory: files.directory,
      userName: c.userName,
      platform,
    });
  }
  if (job.action === "doctor") return doctor(c, t);
  if (job.action === "stage") {
    const artifact = path.join(root, "artifacts", p.bundles.artifact);
    extract(path.join(root, "incoming", p.bundles.artifact + ".tar"), artifact, p.bundles.artifact);
    const manifest = verifyArchive(artifact);
    if (JSON.stringify(manifest) !== JSON.stringify(p.release))
      throw Error("Artifact manifest differs from frozen plan.");
    const target = path.join(root, "releases", manifest.releaseId);
    if (fs.existsSync(target)) verifyInstalled(target);
    else installRelease(artifact, path.join(root, "releases"));
    let source = c.migrationSource;
    try {
      verifyMigrationSource({ ...c, migrationSource: source }, target);
    } catch {
      source = prepareSource(c, p);
      verifyMigrationSource({ ...c, migrationSource: source }, target);
    }
    const receipt = {
      schemaVersion: 1,
      planId: p.id,
      environmentId,
      releaseId: p.release.releaseId,
      toolingCommit: p.toolingCommit,
      source,
      stagedAt: new Date().toISOString(),
    };
    atomicJson(files.staged, receipt);
    return receipt;
  }
  if (job.action !== "activate") throw Error("Unsupported worker operation.");
  const staged = readJson(files.staged);
  if (staged.planId !== p.id || staged.toolingCommit !== p.toolingCommit)
    throw Error("Staging receipt mismatch.");
  const save = (details) =>
    atomicJson(files.receipt, {
      schemaVersion: 1,
      planId: p.id,
      environmentId,
      toolingCommit: p.toolingCommit,
      updatedAt: new Date().toISOString(),
      ...details,
    });
  if (Date.now() >= Date.parse(p.deadline)) {
    save({ status: "deferred", reason: "deadline-expired" });
    return readJson(files.receipt);
  }
  if ((t.availability ?? "online") !== "online") {
    save({ status: "deferred", reason: "availability" });
    return readJson(files.receipt);
  }
  let target;
  try {
    target = path.resolve(path.dirname(installedCli(c)[1]), "../../..");
  } catch {
    target = null;
  }
  try {
    if (target !== path.join(root, "releases", p.release.releaseId)) {
      const idle = await probe(c, t, "idle");
      if (idle.status === "busy") {
        save({ status: "deferred", reason: "busy" });
        return readJson(files.receipt);
      }
      if (idle.status !== "idle") throw Error("Idle inspection failed.");
      const { allowLegacyDrain: _priorLegacy, ...permanent } = c;
      const next = {
        ...permanent,
        baselineVersion: p.release.version,
        migrationSource: staged.source,
      };
      const saved = path.join(files.directory, "config.before.json");
      if (!fs.existsSync(saved)) atomicJson(saved, c);
      atomicJson(path.join(root, "config.json"), next);
      await manage(
        { ...next, allowLegacyDrain: p.allowLegacyDrain },
        "activate",
        p.release.releaseId,
        {
          onPhase: (j) =>
            save({ status: j.stage, phase: j.phase, candidateStarted: j.candidateStarted }),
        },
      );
    }
    save({ status: "verifying" });
    const result = await verifyDeployment(loadConfig(path.join(root, "config.json")), t, p);
    save(result);
    return readJson(files.receipt);
  } catch (error) {
    const j = fs.existsSync(path.join(root, "activation.json"))
      ? readJson(path.join(root, "activation.json"))
      : {};
    save({
      status: j.phase === "recovery-required" ? "recovery-required" : "failed",
      stage: j.stage ?? "preflight",
      candidateStarted: j.candidateStarted ?? false,
      error: "Activation or verification failed; inspect private activation state.",
    });
    return readJson(files.receipt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw Error("Worker input file required.");
  try {
    const result = await dispatch(readJson(file));
    console.log(JSON.stringify(result));
    process.exitCode = ["failed", "recovery-required"].includes(result.status) ? 1 : 0;
  } catch {
    console.error(
      "Fleet worker failed before activation. Inspect its private input and staging state.",
    );
    process.exitCode = 1;
  }
}
