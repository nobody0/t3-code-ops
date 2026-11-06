import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { run as command, readJson, verifyInstalled, digest } from "./ko-release.mjs";
import { installedCli, databaseState } from "./ko-safety.mjs";
import { run as session } from "../ko-session.mjs";

export async function probe(c, t, action = "check") {
  return session({
    action,
    homeDir: c.baseDir,
    origin: `http://127.0.0.1:${c.port}`,
    environmentId: t.environmentId,
    t3Command: installedCli(c),
  });
}
export function preservedDatabase(backup, live) {
  const before = new DatabaseSync(backup, { readOnly: true }),
    after = new DatabaseSync(live, { readOnly: true });
  try {
    before.exec("BEGIN");
    after.exec("BEGIN");
    const tables = new Set(
      before
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    let events = 0,
      sessions = 0;
    if (tables.has("orchestration_events")) {
      const last = before
        .prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM orchestration_events")
        .get().n;
      const columns = before
        .prepare("PRAGMA table_info(orchestration_events)")
        .all()
        .map(({ name }) => '"' + name.replaceAll('"', '""') + '"')
        .join(",");
      const hash = (db) => {
        const h = crypto.createHash("sha256");
        let count = 0;
        for (const row of db
          .prepare(
            "SELECT " + columns + " FROM orchestration_events WHERE sequence<=? ORDER BY sequence",
          )
          .iterate(last)) {
          h.update(JSON.stringify(row) + "\n");
          count++;
        }
        return { sha256: h.digest("hex"), count };
      };
      const a = hash(before),
        b = hash(after);
      if (a.sha256 !== b.sha256 || a.count !== b.count)
        throw Error("Original orchestration history changed.");
      events = a.count;
    }
    if (tables.has("auth_sessions")) {
      const columns = "session_id,subject,scopes,method,issued_at,expires_at,revoked_at";
      for (const row of before
        .prepare(`SELECT ${columns} FROM auth_sessions WHERE revoked_at IS NULL AND expires_at>?`)
        .iterate(new Date().toISOString())) {
        const other = after
          .prepare(`SELECT ${columns} FROM auth_sessions WHERE session_id=?`)
          .get(row.session_id);
        if (JSON.stringify(row) !== JSON.stringify(other))
          throw Error("An existing client session grant changed.");
        sessions++;
      }
    }
    return { events, sessions };
  } finally {
    before.close();
    after.close();
  }
}
export async function frontend(c, t, manifest, target, fetcher = fetch) {
  const results = [],
    client = path.join(target, "node_modules/t3/dist/client");
  for (const origin of [`http://127.0.0.1:${c.port}`, ...(t.url ? [t.url] : [])]) {
    const request = async (url) => {
      const r = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw Error("Frontend/descriptor HTTP failure.");
      return r;
    };
    const d = await (await request(new URL("/.well-known/t3/environment", origin))).json();
    if (d.environmentId !== t.environmentId || d.serverVersion !== manifest.version)
      throw Error("Descriptor identity/version differs.");
    const html = Buffer.from(await (await request(origin)).arrayBuffer());
    const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
    if (hash(html) !== digest(path.join(client, "index.html")))
      throw Error("Frontend differs from selected runtime.");
    const src = html.toString().match(/<script\b[^>]*src=["']([^"']+)/i)?.[1];
    if (!src) throw Error("Missing frontend entry.");
    const url = new URL(src, origin),
      asset = path.resolve(client, "." + decodeURIComponent(url.pathname));
    const relative = path.relative(client, asset);
    if (
      url.origin !== new URL(origin).origin ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    )
      throw Error("Unsafe frontend entry.");
    if (hash(Buffer.from(await (await request(url)).arrayBuffer())) !== digest(asset))
      throw Error("Frontend entry asset differs.");
    results.push({ origin, status: "passed", protocol: d.orchestrationProtocolVersion ?? 1 });
  }
  return results;
}
export function serviceState(c) {
  return JSON.parse(
    command(c.node, [
      path.resolve(import.meta.dirname, "../control-t3-service.mjs"),
      "status",
      path.join(c.root, "config.json"),
    ]),
  );
}
export async function verifyDeployment(c, t, p, { skipDatabase = false } = {}) {
  const target = path.resolve(path.dirname(installedCli(c)[1]), "../../.."),
    manifest = verifyInstalled(target);
  if (
    manifest.commit !== p.sourceCommit ||
    manifest.releaseId !== p.release.releaseId ||
    manifest.opsCommit !== p.runtimeOpsCommit ||
    manifest.sha256 !== p.release.sha256
  )
    throw Error("Runtime provenance mismatch.");
  const journal = readJson(path.join(c.root, "activation.json"));
  if (journal.phase !== "active" || journal.releaseId !== manifest.releaseId)
    throw Error("Activation incomplete.");
  const checks = await probe(c, t);
  if (checks.status !== "healthy" || checks.cleanupWarning)
    throw Error("Authenticated API check failed.");
  for (const wanted of t.expectedProviders ?? [])
    if (!checks.providers.some((x) => x.instanceId === wanted && x.ready))
      throw Error("Configured provider unavailable.");
  const services = [];
  for (let i = 0; i < 3; i++) {
    const s = serviceState(c);
    if (
      s.native.state !== "active" ||
      s.wrapper?.ownership !== "native" ||
      s.wrapper.phase !== "ready" ||
      s.wrapper.lastProbe !== "healthy" ||
      path.resolve(s.wrapper.target) !== path.resolve(target)
    )
      throw Error("Native ownership/health failure.");
    services.push([s.native.pid, s.wrapper.pid, s.wrapper.childPid]);
    if (i < 2) await new Promise((r) => setTimeout(r, 1000));
  }
  if (services.some((s) => JSON.stringify(s) !== JSON.stringify(services[0])))
    throw Error("Service is unstable.");
  let preserved = null,
    database = null;
  if (!skipDatabase) {
    database = databaseState(c.baseDir);
    const before = journal.safety?.before?.database;
    if (before)
      preserved = preservedDatabase(
        path.join(journal.safety.backup, before),
        path.join(c.baseDir, "userdata", before),
      );
  }
  return {
    status: "verified",
    verifiedAt: new Date().toISOString(),
    environmentId: t.environmentId,
    releaseId: manifest.releaseId,
    runtime: {
      sourceCommit: manifest.commit,
      opsCommit: manifest.opsCommit,
      sha256: manifest.sha256,
    },
    toolingCommit: p.toolingCommit,
    frontend: await frontend(c, t, manifest, target),
    database,
    preserved,
    service: { ownership: "native", stable: true },
    providers: checks.providers.map(({ instanceId, ready, auth }) => ({ instanceId, ready, auth })),
    inference: "not-run",
    agentLinks: "not-tested",
  };
}
export async function doctor(c, t) {
  const report = {
    environmentId: t.environmentId,
    checkedAt: new Date().toISOString(),
    layers: {},
  };
  const check = async (name, fn) => {
    try {
      report.layers[name] = { status: "passed", result: await fn() };
    } catch {
      report.layers[name] = { status: "failed" };
    }
  };
  await check("nativeProcess", () => {
    const state = serviceState(c);
    if (
      state.native?.state !== "active" ||
      state.wrapper?.ownership !== "native" ||
      state.wrapper?.phase !== "ready" ||
      state.wrapper?.lastProbe !== "healthy"
    )
      throw Error("Native owner is unhealthy.");
    return state;
  });
  for (const [name, origin] of [
    ["localApi", `http://127.0.0.1:${c.port}`],
    ["https", t.url],
  ]) {
    if (!origin) {
      report.layers[name] = { status: "not-configured" };
      continue;
    }
    await check(name, async () => {
      const r = await fetch(new URL("/.well-known/t3/environment", origin), {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok || (await r.json()).environmentId !== t.environmentId)
        throw Error("Descriptor failed");
      return { reachable: true };
    });
  }
  await check("authentication", async () => {
    const r = await probe(c, t);
    if (r.status !== "healthy" || r.cleanupWarning) throw Error("Auth failed");
    return { status: r.status };
  });
  await check("providerDiscovery", async () => {
    const r = await probe(c, t);
    if (r.status !== "healthy") throw Error("Discovery failed");
    return r.providers.map(({ instanceId, ready, auth }) => ({ instanceId, ready, auth }));
  });
  report.layers.providerInference = { status: "not-run" };
  report.layers.agentLinks = {
    status: "inspect-native-links",
    prerequisite: "Settings > Labs > Linked environments",
  };
  await check("clientSessions", () => {
    const [node, ...cli] = installedCli(c),
      sessions = JSON.parse(
        command(node, [...cli, "auth", "session", "list", "--base-dir", c.baseDir, "--json"]),
      );
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      expiresAt: s.expiresAt,
      daysRemaining: Math.floor((Date.parse(s.expiresAt) - Date.now()) / 86400_000),
      scopeCount: s.scopes.length,
    }));
  });
  return report;
}
