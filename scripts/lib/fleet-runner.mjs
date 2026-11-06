import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, readJson, run } from "./ko-release.mjs";
import { validatePlan, assertNativeEvidence } from "./fleet-plan.mjs";
import { remoteJob } from "./fleet-transport.mjs";

export function summarize(p, results) {
  const verified = p.targets
    .filter((t) => results[t.environmentId]?.status === "verified")
    .map((t) => t.environmentId);
  return {
    status: verified.length === p.targets.length ? "completed" : "partial",
    verified,
    pending: p.targets
      .filter((t) => !verified.includes(t.environmentId))
      .map((t) => t.environmentId),
  };
}
export function windowsAncestryScript(pid) {
  return String.raw`$id=${pid};$ok=$false;for($i=0;$i -lt 24 -and $id -gt 0;$i++){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id);if(!$p){break};if($p.Name -match '^(codex|claude)(\.exe)?$' -or $p.CommandLine -match 'serve-t3\.mjs|t3[\\/]dist[\\/]bin\.mjs') {exit 1};if($p.Name -match '^sshd(-session)?\.exe$'){$ok=$true};if($p.Name -eq 'svchost.exe'){$s=Get-CimInstance Win32_Service -Filter ('ProcessId='+$id);if(@($s.Name) -contains 'Schedule'){$ok=$true}};$id=[int]$p.ParentProcessId};if(!$ok){exit 1}`;
}
export function assertExternalController() {
  if (process.platform === "win32") {
    const script = windowsAncestryScript(process.pid);
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ]);
  } else {
    let pid = process.pid,
      external = false;
    for (let i = 0; i < 24 && pid >= 1; i++) {
      const line = run("ps", ["-o", "ppid=,comm=,args=", "-p", String(pid)]),
        m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) break;
      if (/sshd|systemd|launchd/.test(m[2])) external = true;
      if (/codex|claude|serve-t3\.mjs|t3\/dist\/bin\.mjs/i.test(m[2]))
        throw Error("Controller is inside an agent/app process tree.");
      pid = Number(m[1]);
    }
    if (!external) throw Error("Launch through SSH or the native one-time controller.");
  }
}
export async function runRollout(
  p,
  directory,
  {
    wait = false,
    call = remoteJob,
    externalCheck = assertExternalController,
    sleep = delay,
    now = Date.now,
    pollMs = 15_000,
  } = {},
) {
  validatePlan(p);
  assertNativeEvidence(p);
  externalCheck();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "controller.lock"),
    file = path.join(directory, "controller.json");
  const previous = fs.existsSync(file) ? readJson(file) : null;
  if (previous && previous.planId !== p.id)
    throw Error("Controller receipt belongs to a different plan.");
  if (fs.existsSync(lock)) {
    const old = readJson(lock);
    let alive = true;
    try {
      process.kill(old.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
    }
    if (alive) throw Error("Another controller may own this plan.");
    fs.unlinkSync(lock); // Proven dead owner; remote native workers are inspected before any restart.
  }
  const fd = fs.openSync(lock, "wx", 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let state = {
    schemaVersion: 1,
    planId: p.id,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    deadline: p.deadline,
    status: "running",
    results: {},
  };
  if (previous) state.results = previous.results ?? {};
  const save = () => atomicJson(file, { ...state, updatedAt: new Date(now()).toISOString() });
  const heartbeat = setInterval(save, 5000);
  save();
  try {
    do {
      let deferred = false;
      for (const t of p.targets) {
        if (now() >= Date.parse(p.deadline)) {
          deferred = true;
          break;
        }
        state.current = t.environmentId;
        save();
        const job = { toolingCommit: p.toolingCommit, plan: p };
        const observation = await call(t, { ...job, action: "status" });
        const r = observation.receipt;
        const current = observation.observed;
        if (
          r?.status === "verified" &&
          r.planId === p.id &&
          r.environmentId === t.environmentId &&
          r.toolingCommit === p.toolingCommit &&
          current?.releaseId === p.release.releaseId &&
          current?.commit === p.sourceCommit &&
          current?.sha256 === p.release.sha256
        ) {
          state.results[t.environmentId] = r;
          save();
          continue;
        }
        if (
          ["pending", "recovery-required"].includes(observation.activation?.phase) &&
          observation.heartbeat?.status !== "running"
        )
          throw Error("An interrupted target requires reviewed recovery before resuming.");
        if (observation.heartbeat?.status === "running") {
          if (now() - Date.parse(observation.heartbeat.updatedAt) > 30_000)
            throw Error("Target worker heartbeat is stale.");
          state.results[t.environmentId] = {
            status: "running",
            stage: r?.status ?? "starting",
            heartbeat: observation.heartbeat.updatedAt,
          };
          deferred = true;
          break;
        }
        if (r && ["failed", "recovery-required"].includes(r.status))
          throw Error("A target failed. Resolve its receipt, then create a new reviewed plan.");
        if ((t.availability ?? "online") !== "online") {
          state.results[t.environmentId] = { status: "deferred", reason: "availability" };
          deferred = true;
          break;
        }
        if (!observation.staged || observation.staged.planId !== p.id)
          throw Error("Stage every target before rollout.");
        await call(t, { ...job, action: "start" });
        state.results[t.environmentId] = { status: "running" };
        deferred = true;
        break;
      }
      const summary = summarize(p, state.results);
      if (summary.status === "completed") {
        state.status = "completed";
        break;
      }
      state.status = "waiting";
      save();
      if (!wait || !deferred || now() >= Date.parse(p.deadline)) break;
      await sleep(Math.min(pollMs, Math.max(0, Date.parse(p.deadline) - now())));
    } while (now() < Date.parse(p.deadline));
    if (state.status !== "completed")
      state.status = now() >= Date.parse(p.deadline) ? "deadline-expired" : "partial";
  } catch (error) {
    state.status = "failed";
    state.error = error.message;
  } finally {
    clearInterval(heartbeat);
    delete state.current;
    save();
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
  return {
    ...state,
    ...(state.status === "completed" ? {} : { completion: summarize(p, state.results) }),
  };
}
