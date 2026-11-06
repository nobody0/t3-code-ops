import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { snapshotStoppedHome } from "./lib/ko-safety.mjs";
import {
  restoreTest,
  verifySnapshot,
  sealSnapshot,
  exportEncrypted,
  fileHash,
} from "./lib/ko-backup.mjs";
import { run } from "./lib/ko-release.mjs";
test("a disposable offline restore preserves identities, grants, events and durable attachments", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = { root, baseDir: path.join(root, "home") },
    userdata = path.join(c.baseDir, "userdata");
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(path.join(userdata, "environment-id"), "00000000-0000-4000-8000-000000000001\n");
  for (const name of ["attachments", "browser-artifacts", "secrets"]) {
    fs.mkdirSync(path.join(userdata, name));
    fs.writeFileSync(path.join(userdata, name, "durable"), "preserve-" + name);
  }
  const db = new DatabaseSync(path.join(userdata, "statev2.sqlite"));
  db.exec(
    "CREATE TABLE orchestration_events (sequence INTEGER,payload TEXT);INSERT INTO orchestration_events VALUES(1,'history');CREATE TABLE auth_sessions(session_id TEXT);INSERT INTO auth_sessions VALUES('grant');",
  );
  db.close();
  const { backup } = snapshotStoppedHome(c, {}),
    destination = path.join(root, "restore");
  fs.writeFileSync(path.join(backup, "migration-rehearsal.json"), "{}\n");
  sealSnapshot(backup);
  verifySnapshot(backup);
  const result = restoreTest(backup, destination);
  assert.equal(result.status, "passed");
  assert.equal(result.network, "not-started");
  assert.equal(result.databases[0].sessionGrants, 1);
  assert.equal(result.databases[0].events, 1);
  for (const name of ["attachments", "browser-artifacts", "secrets"])
    assert.equal(
      fs.readFileSync(path.join(destination, "userdata", name, "durable"), "utf8"),
      "preserve-" + name,
    );
  assert.throws(() => restoreTest(backup, destination), /new and disposable/);
  fs.writeFileSync(path.join(backup, "attachments/durable"), "corrupted");
  assert.throws(() => verifySnapshot(backup), /integrity/);
});
test(
  "age export decrypts into an offline restore and retains only completed exports",
  { skip: !process.env.KO_TEST_AGE || !process.env.KO_TEST_AGE_KEYGEN },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-age-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const c = { root, baseDir: path.join(root, "home") },
      userdata = path.join(c.baseDir, "userdata");
    fs.mkdirSync(userdata, { recursive: true });
    fs.writeFileSync(
      path.join(userdata, "environment-id"),
      "00000000-0000-4000-8000-000000000001\n",
    );
    fs.mkdirSync(path.join(userdata, "attachments"));
    fs.writeFileSync(path.join(userdata, "attachments", "fixture.txt"), "durable fixture");
    const { backup } = snapshotStoppedHome(c, {});
    const key = path.join(root, "fixture-key.txt");
    run(process.env.KO_TEST_AGE_KEYGEN, ["-o", key]);
    const recipient = run(process.env.KO_TEST_AGE_KEYGEN, ["-y", key]);
    const destination = path.join(root, "encrypted");
    const options = { destination, recipient, age: process.env.KO_TEST_AGE, keep: 1 };
    const first = exportEncrypted(backup, options),
      second = exportEncrypted(backup, options);
    assert.equal(fs.existsSync(first.file), false);
    assert.equal(fileHash(second.file), JSON.parse(fs.readFileSync(second.file + ".json")).sha256);
    const archive = path.join(root, "decrypted.tar"),
      extracted = path.join(root, "decrypted");
    run(process.env.KO_TEST_AGE, [
      "--decrypt",
      "--identity",
      key,
      "--output",
      archive,
      second.file,
    ]);
    fs.mkdirSync(extracted);
    run("tar", ["-xf", archive, "-C", extracted]);
    const restored = path.join(root, "restored");
    assert.equal(restoreTest(extracted, restored).status, "passed");
    assert.equal(
      fs.readFileSync(path.join(restored, "userdata/attachments/fixture.txt"), "utf8"),
      "durable fixture",
    );
  },
);
