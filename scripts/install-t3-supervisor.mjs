#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfig, readRecovery } from "./lib/ko-deployment.mjs";
import { platformAdapter, writeFile } from "./lib/ko-service-platforms.mjs";
import { assertIdle, installedCli } from "./lib/ko-safety.mjs";
import { atomicJson, run } from "./lib/ko-release.mjs";

const [configPath, extra] = process.argv.slice(2);
if (!configPath || extra) throw Error("Usage: node install-t3-supervisor.mjs CONFIG.json");
const c = loadConfig(configPath);
const recovery = readRecovery(c);
if (
  recovery.configMismatch.length ||
  (recovery.transaction && !["active", "rolled-back"].includes(recovery.transaction.phase))
)
  throw Error("Resolve deployment recovery before changing supervision.");
await assertIdle(c);
const cli = installedCli(c),
  target = path.resolve(cli[1], "../../../..");
const lock = path.join(c.root, "activation.lock"),
  fd = fs.openSync(lock, "wx", 0o600);
fs.writeFileSync(fd, String(process.pid));
const psQuote = (v) => "'" + v.replaceAll("'", "''") + "'";
const ps = (script) =>
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script + ';exit 0', "utf16le").toString("base64"),
  ]);
try {
  await assertIdle(c);
  if ((c.platform ?? "linux") === "linux") {
    const old = c.service.replace(/\.service$/, "") + "-watchdog";
    try {
      run("systemctl", ["--user", "disable", "--now", old + ".timer"]);
    } catch {
      /* absent */
    }
    try {
      run("systemctl", ["--user", "stop", old + ".service"]);
    } catch {
      /* absent */
    }
    for (const unit of [old + ".timer", old + ".service"]) {
      const result = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" });
      if (
        result.error ||
        result.stdout.trim() === "active" ||
        result.stdout.trim() === "activating"
      )
        throw Error("Legacy watchdog is still active: " + unit);
    }
    for (const name of [old + ".timer", old + ".service", `${c.service}.d/91-watchdog-intent.conf`])
      fs.rmSync(path.join(c.unitDirectory, name), { force: true });
    writeFile(
      path.join(c.unitDirectory, `${c.service}.d/91-service-intent.conf`),
      `[Unit]\nConditionPathExists=!${path.join(c.root, "service-stopped")}\n`,
    );
  } else if (c.platform === "darwin") {
    const old = c.service + ".watchdog";
    try {
      run("launchctl", ["bootout", `gui/${process.getuid()}/${old}`]);
    } catch {
      /* absent */
    }
    if (spawnSync("launchctl", ["print", `gui/${process.getuid()}/${old}`]).status === 0)
      throw Error("Legacy launchd watchdog is still loaded.");
    fs.rmSync(path.join(c.unitDirectory, old + ".plist"), { force: true });
  } else {
    const old = c.service + "-watchdog";
    ps(
      `$t=Get-ScheduledTask -TaskName ${psQuote(old)} -ErrorAction SilentlyContinue;if($t){Stop-ScheduledTask -TaskName ${psQuote(old)};Unregister-ScheduledTask -TaskName ${psQuote(old)} -Confirm:$false}`,
    );
    ps(
      `if(Get-ScheduledTask -TaskName ${psQuote(old)} -ErrorAction SilentlyContinue){throw 'Legacy watchdog task remains registered'}`,
    );
  }
  const legacy = path.resolve(c.root, "watchdog");
  if (fs.existsSync(legacy)) {
    if (path.dirname(legacy) !== path.resolve(c.root))
      throw Error("Legacy archive is outside deployment root.");
    fs.renameSync(legacy, path.join(c.root, "retired-watchdog-" + Date.now()));
  }
  if (!c.supervisorPort) {
    const socket = net.createServer();
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", resolve);
    });
    c.supervisorPort = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    atomicJson(configPath, c);
  }
  const source = import.meta.dirname;
  const files = fs
    .readdirSync(source, { recursive: true })
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .sort();
  const hash = crypto.createHash("sha256");
  for (const name of files) {
    const text = fs.readFileSync(path.join(source, name));
    hash.update(name.replaceAll("\\", "/") + "\0").update(text);
    const destination = path.join(c.root, "tools/scripts", name);
    if (path.resolve(destination) !== path.resolve(source, name))
      writeFile(destination, text.toString("utf8"));
  }
  const adapter = platformAdapter(c);
  atomicJson(path.join(c.root, "supervisor-installing.json"), { ownerPid: process.pid, target });
  adapter.install(target);
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${c.port}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(3000),
      });
      const d = await res.json(),
        id = fs.readFileSync(path.join(c.baseDir, "userdata/environment-id"), "utf8").trim();
      if (res.ok && d.environmentId === id) {
        healthy = true;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!healthy)
    throw Error(
      "Wrapper cutover failed health verification; inspect the primary service and supervisor log.",
    );
  const info = adapter.info(),
    r = JSON.parse(fs.readFileSync(path.join(c.root, "service-runtime.json"), "utf8"));
  if (String(info.pid) !== String(r.pid) || !r.childPid)
    throw Error("Native service is not the sole wrapper owner.");
  const receipt = {
    installedAt: new Date().toISOString(),
    toolingSha256: hash.digest("hex"),
    target,
    service: c.service,
    architecture: "native-service -> app-wrapper -> T3",
  };
  atomicJson(path.join(c.root, "supervisor-installed.json"), receipt);
  console.log(JSON.stringify({ ...receipt, wrapperPid: r.pid, childPid: r.childPid }, null, 2));
} finally {
  fs.rmSync(path.join(c.root, "supervisor-installing.json"), { force: true });
  fs.closeSync(fd);
  fs.unlinkSync(lock);
}
