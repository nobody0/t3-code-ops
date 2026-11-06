import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, digest, readJson, run, verifyArchive } from "./ko-release.mjs";
import { validateInventory } from "./fleet-inventory.mjs";

export const planHash = (p) => crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex");
export function assertNativeEvidence(p) {
  for (const platform of new Set(p.targets.map((t) => `${t.platform}-${t.arch}`))) {
    const e = p.nativeEvidence?.find((e) => e.platform === platform);
    if (
      !e ||
      e.status !== "passed" ||
      e.dirty !== false ||
      e.toolingCommit !== p.toolingCommit ||
      Date.now() - Date.parse(e.checkedAt) > 30 * 86400_000 ||
      Date.parse(e.checkedAt) > Date.now() + 60_000 ||
      !Number.isFinite(Date.parse(e.checkedAt))
    )
      throw Error(`Missing current, clean native lifecycle evidence for ${platform}.`);
    for (const [name, sha] of Object.entries(p.toolingFiles ?? {}).filter(
      ([n]) => n.endsWith(".mjs") || n === "package.json",
    ))
      if (e.files?.[name] !== sha) throw Error("Native evidence tested different tooling bytes.");
  }
}
export function validatePlan(p) {
  if (p?.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(p.id ?? "")) throw Error("Invalid plan.");
  const { id, ...body } = p;
  if (planHash(body) !== id) throw Error("Frozen plan changed. Create and review a new plan.");
  validateInventory({ schemaVersion: 1, targets: p.targets });
  for (const key of ["sourceCommit", "runtimeOpsCommit", "toolingCommit"])
    if (!/^[0-9a-f]{40}$/.test(p[key])) throw Error("Plan commits must be exact.");
  if (
    !Number.isFinite(Date.parse(p.deadline)) ||
    !Number.isInteger(p.activationTimeoutMs) ||
    p.activationTimeoutMs < 60_000 ||
    p.activationTimeoutMs > 2 * 3600_000
  )
    throw Error("Invalid finite phase budget.");
  if (
    p.release?.commit !== p.sourceCommit ||
    p.release?.opsCommit !== p.runtimeOpsCommit ||
    !/^[0-9a-f]{64}$/.test(p.release?.sha256 ?? "") ||
    !p.release?.releaseId?.startsWith(`${p.release.version}-ko-${p.sourceCommit.slice(0, 12)}`)
  )
    throw Error("Plan runtime provenance differs.");
  if (!p.targets.every((t) => p.release.platformLocks?.[`${t.platform}-${t.arch}`]))
    throw Error("Missing target platform lock.");
  return p;
}
export function freezePlan({
  inventory,
  artifact,
  tooling,
  output,
  deadline,
  nativeEvidence = [],
  allowLegacyDrain = false,
  activationTimeoutMs = 3600_000,
}) {
  const { targets } = validateInventory(inventory),
    release = verifyArchive(artifact);
  if (fs.existsSync(output)) throw Error("Plan output already exists.");
  if (Date.parse(deadline) <= Date.now() || Date.parse(deadline) > Date.now() + 7 * 86400_000)
    throw Error("Plan needs a deadline within seven days.");
  const toolingCommit = run("git", ["rev-parse", "HEAD"], { cwd: tooling });
  if (run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: tooling }))
    throw Error("Commit and review operations tooling before freezing.");
  const files = run("git", ["ls-tree", "-r", "--name-only", toolingCommit], { cwd: tooling }).split(
    /\r?\n/,
  );
  const toolingFiles = Object.fromEntries(files.map((f) => [f, digest(path.join(tooling, f))]));
  assertNativeEvidence({ targets, toolingCommit, toolingFiles, nativeEvidence });
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  run(
    "git",
    ["archive", "--format=tar", `--output=${path.resolve(output, "tooling.tar")}`, toolingCommit],
    { cwd: tooling },
  );
  const contents = ["release.json", "t3-code.tgz", "locks"];
  run("tar", [
    "-cf",
    path.resolve(output, "artifact.tar"),
    "-C",
    path.resolve(artifact),
    ...contents,
  ]);
  const body = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    deadline,
    activationTimeoutMs,
    allowLegacyDrain,
    sourceCommit: release.commit,
    runtimeOpsCommit: release.opsCommit,
    toolingCommit,
    toolingFiles,
    release,
    nativeEvidence,
    bundles: {
      tooling: digest(path.join(output, "tooling.tar")),
      artifact: digest(path.join(output, "artifact.tar")),
    },
    targets,
  };
  const p = validatePlan({ ...body, id: planHash(body) });
  assertNativeEvidence(p);
  atomicJson(path.join(output, "plan.json"), p);
  return p;
}
export const loadPlan = (file) => validatePlan(readJson(file));
export function verifyToolchain(directory, p) {
  for (const [name, sha] of Object.entries(p.toolingFiles)) {
    const relative = path.relative(directory, path.resolve(directory, name));
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      digest(path.join(directory, name)) !== sha
    )
      throw Error("Toolchain bytes differ from frozen plan.");
  }
}
