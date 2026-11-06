import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { atomicJson, readJson, run } from "./ko-release.mjs";

export function fileHash(file) {
  const hash = crypto.createHash("sha256"),
    fd = fs.openSync(file, "r"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
export function hashTree(root) {
  const result = {};
  function visit(dir) {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw Error("Recovery data must contain regular files and directories only.");
      if (entry.isDirectory()) visit(file);
      else result[path.relative(root, file).replaceAll("\\", "/")] = fileHash(file);
    }
  }
  visit(root);
  return result;
}
export function sealSnapshot(backup) {
  const files = hashTree(backup);
  delete files["integrity.json"];
  atomicJson(path.join(backup, "integrity.json"), { schemaVersion: 1, files });
}
export function verifySnapshot(backup) {
  const expected = readJson(path.join(backup, "integrity.json"));
  if (expected.schemaVersion !== 1 || !expected.files || !Object.keys(expected.files).length)
    throw Error("Invalid recovery manifest.");
  for (const [name, sha] of Object.entries(expected.files)) {
    const file = path.resolve(backup, name),
      relative = path.relative(backup, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) || fileHash(file) !== sha)
      throw Error("Recovery snapshot integrity mismatch.");
  }
  const actual = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw Error("Recovery snapshot contains a symlink.");
      if (e.isDirectory()) visit(file);
      else actual.push(path.relative(backup, file).replaceAll("\\", "/"));
    }
  };
  visit(backup);
  if (actual.filter((n) => n !== "integrity.json").some((n) => !(n in expected.files)))
    throw Error("Recovery snapshot contains unsealed files.");
  return expected;
}
export function restoreTest(backup, destination) {
  const manifest = verifySnapshot(backup);
  if (fs.existsSync(destination)) throw Error("Restore destination must be new and disposable.");
  const recovery = readJson(path.join(backup, "recovery.json"));
  fs.mkdirSync(path.join(destination, "userdata"), { recursive: true, mode: 0o700 });
  const names = recovery.durableFiles;
  if (!Array.isArray(names) || !names.includes("environment-id"))
    throw Error("Snapshot has no complete recovery contract.");
  for (const name of names) {
    if (name !== path.basename(name)) throw Error("Unsafe recovery entry.");
    const source = path.join(backup, name);
    if (fs.existsSync(source))
      fs.cpSync(source, path.join(destination, "userdata", name), {
        recursive: true,
        dereference: false,
      });
  }
  for (const [name, sha] of Object.entries(manifest.files)) {
    if (
      names.includes(name.split("/")[0]) &&
      fileHash(path.join(destination, "userdata", name)) !== sha
    )
      throw Error("Restored durable file differs.");
  }
  const databases = [];
  for (const name of ["statev2.sqlite", "state.sqlite"]) {
    const file = path.join(destination, "userdata", name);
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const integrity = db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
        throw Error("Restored database corrupt.");
      const tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((x) => x.name),
      );
      databases.push({
        name,
        integrity: "ok",
        events: tables.has("orchestration_events")
          ? db.prepare("SELECT COUNT(*) AS n FROM orchestration_events").get().n
          : null,
        sessionGrants: tables.has("auth_sessions")
          ? db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n
          : null,
      });
    } finally {
      db.close();
    }
  }
  // Deliberately no app/provider launch, service registration, network or auth issuance.
  return {
    status: "passed",
    network: "not-started",
    identity: fs.readFileSync(path.join(destination, "userdata/environment-id"), "utf8").trim(),
    databases,
    filesVerified: Object.keys(manifest.files).length,
    destination,
  };
}
export function exportEncrypted(backup, { destination, recipient, keep = 5, age = "age" }) {
  verifySnapshot(backup);
  if (
    !path.isAbsolute(destination) ||
    !Number.isInteger(keep) ||
    keep < 1 ||
    !/^age1[a-z0-9]+$/.test(recipient)
  )
    throw Error(
      "Configure an absolute private backup destination, age recipient and positive retention.",
    );
  const relative = path.relative(path.dirname(backup), destination);
  if (!relative.startsWith("..") && !path.isAbsolute(relative))
    throw Error("Off-device destination must be outside local backups.");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const name = `snapshot-${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}`;
  const plain = path.join(backup, `.export-${crypto.randomUUID()}.tar`),
    output = path.join(destination, name + ".tar.age");
  const partial = output + ".part";
  try {
    const names = fs.readdirSync(backup).filter((n) => !n.startsWith(".export-"));
    // The plaintext temporary remains inside the owner-only local snapshot.
    run("tar", ["-cf", plain, "-C", backup, ...names], { timeout: 2 * 3600_000 });
    fs.chmodSync(plain, 0o600);
    run(age, ["--encrypt", "--recipient", recipient, "--output", partial, plain], {
      timeout: 2 * 3600_000,
    });
    fs.renameSync(partial, output);
    atomicJson(output + ".json", {
      schemaVersion: 1,
      sha256: fileHash(output),
      createdAt: new Date().toISOString(),
    });
    // Only our completed, integrity-verified exports are retention candidates.
    const old = fs
      .readdirSync(destination)
      .filter(
        (n) =>
          /^snapshot-.*\.tar\.age$/.test(n) && fs.existsSync(path.join(destination, n + ".json")),
      )
      .sort()
      .reverse();
    for (const n of old.slice(keep)) {
      const file = path.join(destination, n);
      if (fileHash(file) !== readJson(file + ".json").sha256)
        throw Error("Retained backup is corrupt; pruning stopped.");
      fs.unlinkSync(file);
      fs.unlinkSync(file + ".json");
    }
    return { file: output, sha256: fileHash(output) };
  } finally {
    fs.rmSync(plain, { force: true });
    fs.rmSync(partial, { force: true });
  }
}
