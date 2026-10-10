import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { run, atomicJson } from "./lib/ko-release.mjs";
import { platformAdapter } from "./lib/ko-service-platforms.mjs";

test(
  "one native service owns one wrapper: hang/crash recovery, duplicate rejection and clean stop",
  {
    skip: process.env.KO_TEST_SUPERVISOR !== "1",
    timeout: 120000,
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-owner-fixture-"));
    const name = `ko-owner-fixture-${process.pid}`;
    const freePort = async () => {
      const s = net.createServer();
      await new Promise((r) => s.listen(0, "127.0.0.1", r));
      const p = s.address().port;
      await new Promise((r) => s.close(r));
      return p;
    };
    const c = {
      platform: process.platform,
      root,
      baseDir: path.join(root, "home"),
      node: process.execPath,
      port: await freePort(),
      supervisorPort: await freePort(),
      service: process.platform === "linux" ? name + ".service" : name,
      baselineVersion: "fixture",
      unitDirectory:
        process.platform === "linux"
          ? path.join(os.homedir(), ".config/systemd/user")
          : process.platform === "darwin"
            ? path.join(os.homedir(), "Library/LaunchAgents")
            : path.join(root, "tasks"),
      userName: `${process.env.USERDOMAIN}\\${process.env.USERNAME}`,
      supervision: { startupGraceMs: 0, intervalMs: 100, failureLimit: 2, failureSpanMs: 100 },
    };
    fs.mkdirSync(path.join(c.baseDir, "userdata"), { recursive: true });
    fs.mkdirSync(c.unitDirectory, { recursive: true });
    fs.writeFileSync(path.join(c.baseDir, "userdata/environment-id"), "fixture");
    atomicJson(path.join(root, "config.json"), c);
    const target = path.join(root, "release"),
      cli = path.join(target, "node_modules/t3/dist/bin.mjs");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(
      cli,
      `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';const arg=k=>process.argv[process.argv.indexOf(k)+1];const home=arg('--base-dir');http.createServer((req,res)=>{if(fs.existsSync(path.join(home,'hang')))return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({environmentId:'fixture'}));}).listen(Number(arg('--port')),'127.0.0.1');`,
    );
    const adapter = platformAdapter(c);
    t.after(() => {
      try {
        adapter.stop();
      } catch {
        /* absent */
      }
      if (process.platform === "linux") {
        fs.rmSync(path.join(c.unitDirectory, c.service), { force: true });
        fs.rmSync(path.join(c.unitDirectory, c.service + ".d"), { recursive: true, force: true });
        run("systemctl", ["--user", "daemon-reload"]);
      } else if (process.platform === "darwin") {
        fs.rmSync(path.join(c.unitDirectory, c.service + ".plist"), { force: true });
      } else {
        run("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Unregister-ScheduledTask -TaskName '${c.service}' -Confirm:$false -ErrorAction SilentlyContinue`,
        ]);
      }
      assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
      fs.rmSync(root, { recursive: true, force: true });
    });
    if (process.platform === "linux")
      fs.writeFileSync(
        path.join(c.unitDirectory, c.service),
        "[Service]\nRestart=always\nRestartSec=1\n",
      );
    if (process.platform === "linux") {
      const dropin = path.join(c.unitDirectory, c.service + ".d");
      fs.mkdirSync(dropin, { recursive: true });
      fs.writeFileSync(
        path.join(dropin, "91-service-intent.conf"),
        "[Unit]\nConditionPathExists=!" + path.join(root, "service-stopped") + "\n",
      );
    }
  c.initialCli=[c.node,cli];
  atomicJson(path.join(root,'config.json'),c);
  const installer=path.join(import.meta.dirname,'install-t3-supervisor.mjs');
  run(c.node,[installer,path.join(root,'config.json')]);
  // Re-running cleanup must succeed after the old watchdog is already absent.
  run(c.node,[installer,path.join(root,'config.json')]);
    const read = () => JSON.parse(fs.readFileSync(path.join(root, "service-runtime.json"), "utf8"));
    const ready = async () => {
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${c.port}/.well-known/t3/environment`, {
            signal: AbortSignal.timeout(200),
          });
          if ((await r.json()).environmentId === "fixture") return;
        } catch {}
        await delay(100);
      }
      throw Error("fixture not ready");
    };
    await ready();
    const first = read();
    assert.equal(String(first.pid), adapter.info().pid);
    assert.ok(first.childPid);
    // A second wrapper cannot acquire the control listener or replace the owner.
    assert.throws(
      () =>
        run(c.node, [
          path.join(root, "tools/scripts/serve-t3.mjs"),
          path.join(root, "config.json"),
          target,
        ]),
      /failed/,
    );
    assert.equal(read().pid, first.pid);
    fs.writeFileSync(path.join(c.baseDir, "hang"), "fixture");
    for (let i = 0; i < 100 && read().generation === first.generation; i++) await delay(100);
    const afterHang = read();
    assert.equal(afterHang.pid, first.pid);
    assert.ok(afterHang.generation > 1);
    fs.unlinkSync(path.join(c.baseDir, "hang"));
    await ready();
    const beforeCrash = read();
    process.kill(beforeCrash.childPid, "SIGKILL");
    for (let i = 0; i < 100 && read().generation === beforeCrash.generation; i++) await delay(100);
    await ready();
    assert.equal(read().pid, first.pid);
    assert.ok(read().generation > beforeCrash.generation);
    const control = path.join(import.meta.dirname, "control-t3-service.mjs");
    run(c.node, [control, "stop", path.join(root, "config.json")]);
    assert.notEqual(adapter.info().state, "active");
    assert.equal(fs.existsSync(path.join(root, "service-runtime.json")), false);
    assert.equal(fs.existsSync(path.join(root, "service-stopped")), true);
    await delay(1200);
    assert.notEqual(adapter.info().state, "active");
    run(c.node, [control, "start", path.join(root, "config.json")]);
    await ready();
    assert.equal(fs.existsSync(path.join(root, "service-stopped")), false);
    const resumed = read();
    assert.equal(String(resumed.pid), adapter.info().pid);
    adapter.stop();
    assert.equal(fs.existsSync(path.join(root, "service-runtime.json")), false);
  },
);
