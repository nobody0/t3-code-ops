import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { nativeOnce, cleanupNative } from "./lib/native-once.mjs";
import { run } from "./lib/ko-release.mjs";
import { pathToFileURL } from "node:url";
test(
  "an independent native one-time worker writes a receipt and retires its registration",
  {
    skip: process.env.KO_TEST_NATIVE !== "1" && process.env.KO_TEST_SYSTEMD !== "1",
    timeout: 60_000,
  },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-once-")),
      name = "t3-fleet-" + crypto.randomUUID();
    t.after(() => {
      try {
        cleanupNative(name, process.platform, directory);
      } catch {}
      assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const marker = path.join(directory, "receipt.json"),
      script = path.join(directory, "worker.mjs");
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';import {assertExternalController} from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "lib/fleet-runner.mjs")).href)};assertExternalController();fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));`,
    );
    nativeOnce({
      name,
      node: process.execPath,
      args: [script],
      directory,
      userName: process.platform === "win32" ? run("whoami.exe", []) : undefined,
    });
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(marker)) {
      if (Date.now() > deadline) throw Error("Native one-time worker did not run.");
      await new Promise((r) => setTimeout(r, 100));
    }
    const receipt = JSON.parse(fs.readFileSync(marker));
    assert.notEqual(receipt.ppid, process.pid);
    assert.ok(receipt.pid > 0);
  },
);
