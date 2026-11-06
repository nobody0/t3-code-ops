import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { prepareEnrollment } from "./lib/fleet-enroll.mjs";
test("repeated enrollment preserves identity, settings and service configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-enrollment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = {
    root,
    baseDir: path.join(root, "home"),
    node: process.execPath,
    platform: process.platform,
    port: 3773,
    service: process.platform === "linux" ? "fixture.service" : "fixture",
    unitDirectory: path.join(root, "units"),
    baselineVersion: "0.1.7",
    userName: process.platform === "win32" ? "MACHINE\\Operator" : undefined,
  };
  const metadata = { name: "fixture", url: "https://fixture.example/" };
  const first = prepareEnrollment(c, metadata);
  const settings = path.join(c.baseDir, "userdata/settings.json");
  fs.writeFileSync(settings, '{"preserved":true}\n');
  const second = prepareEnrollment(c, metadata);
  assert.equal(first.adopted, false);
  assert.equal(second.adopted, true);
  assert.equal(first.target.environmentId, second.target.environmentId);
  assert.equal(fs.readFileSync(settings, "utf8"), '{"preserved":true}\n');
  assert.throws(() => prepareEnrollment({ ...c, port: 9999 }, metadata), /configuration differs/);
  fs.unlinkSync(path.join(c.baseDir, "userdata/environment-id"));
  assert.throws(() => prepareEnrollment(c, metadata), /no identity/);
  assert.equal(fs.existsSync(path.join(c.baseDir, "userdata/environment-id")), false);
});
