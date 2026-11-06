#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadInventory, selectTargets } from "./lib/fleet-inventory.mjs";
import { executeSource } from "./lib/fleet-transport.mjs";

// Default scopes and the 30-day session lifetime belong to upstream T3.
// This reduced set preserves the original helper's --scopes standard option.
const reduced = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "environment:maintain",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
  "filesystem:write",
  "relay:read",
];
export function pairingArgs(
  operation,
  { scopes = "full", scope, ttl = "30m", label = "Fleet workspace", ids = [] } = {},
) {
  if (operation === "sessions") return ["auth", "session", "list", "--json"];
  if (operation === "revoke") {
    if (ids.length !== 1 || !/^[-a-zA-Z0-9_:]+$/.test(ids[0]) || ids[0].startsWith("-"))
      throw Error("One session id is required per revoke call.");
    return ["auth", "session", "revoke", ids[0]];
  }
  if (operation !== "codes" || !["full", "standard"].includes(scopes))
    throw Error("Choose codes, sessions or revoke; --scopes full|standard.");
  const selected = scope ?? (scopes === "standard" ? reduced : []);
  return [
    "auth",
    "pairing",
    "create",
    "--ttl",
    ttl,
    "--label",
    label,
    "--json",
    ...selected.flatMap((s) => ["--scope", s]),
  ];
}
export function sessionSummary(s, now = Date.now()) {
  const daysRemaining = Math.floor((Date.parse(s.expiresAt) - now) / 86400_000);
  return {
    sessionId: s.sessionId,
    label: s.client?.label ?? s.subject,
    connected: s.connected ?? false,
    expiresAt: s.expiresAt,
    daysRemaining,
    expiry: daysRemaining < 0 ? "expired" : daysRemaining < 7 ? "renew-soon" : "valid",
    scopeCount: s.scopes.length,
    connectionsSettings: s.scopes.includes("access:write") ? "allowed" : "missing-permission",
  };
}
export async function runPair(target, args, transport = executeSource) {
  const input = JSON.stringify({
    root: target.root,
    environmentId: target.environmentId,
    platform: target.platform,
    arch: target.arch,
    args,
  });
  const source = `try{const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),i=${input};if(process.platform!==i.platform||process.arch!==i.arch)throw Error();const c=JSON.parse(fs.readFileSync(path.join(i.root,'config.json'),'utf8'));if(path.resolve(c.root)!==path.resolve(i.root)||fs.readFileSync(path.join(c.baseDir,'userdata/environment-id'),'utf8').trim()!==i.environmentId)throw Error();const j=JSON.parse(fs.readFileSync(path.join(i.root,'activation.json'),'utf8'));if(j.phase!=='active')throw Error();const target=i.platform==='linux'?fs.realpathSync(path.join(i.root,'current')):JSON.parse(fs.readFileSync(path.join(i.root,'current.json'),'utf8')).target;const r=cp.spawnSync(c.node,[path.join(target,'node_modules/t3/dist/bin.mjs'),...i.args,'--base-dir',c.baseDir],{encoding:'utf8',timeout:30000,maxBuffer:1048576,windowsHide:true});if(r.status!==0)throw Error();console.log(JSON.stringify({stdout:r.stdout}));}catch{console.error('Pairing operation failed; inspect identity, active release and native auth CLI.');process.exitCode=1;}`;
  return (await transport(target, source)).stdout;
}
export async function pairMain(argv) {
  const {
    values: f,
    positionals: [operation, ...rest],
  } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      fleet: { type: "string" },
      only: { type: "string" },
      scopes: { type: "string", default: "full" },
      scope: { type: "string", multiple: true },
      ttl: { type: "string", default: "30m" },
      label: { type: "string", default: "Fleet workspace" },
      json: { type: "boolean" },
    },
  });
  const inventory = loadInventory(
    f.fleet ??
      process.env.T3_FLEET ??
      path.join(os.homedir(), ".config/t3-code-ko/fleet.local.json"),
  );
  const targets = selectTargets(inventory, operation === "revoke" ? rest[0] : f.only),
    results = [];
  if (operation === "revoke" && rest.length < 2) throw Error("Usage: revoke TARGET SESSION_ID...");
  for (const t of targets) {
    try {
      if (operation === "revoke") {
        for (const id of rest.slice(1)) await runPair(t, pairingArgs(operation, { ids: [id] }));
        results.push({ name: t.name, status: "revoked" });
      } else {
        const output = JSON.parse(await runPair(t, pairingArgs(operation, f)));
        results.push(
          operation === "sessions"
            ? { name: t.name, sessions: output.map((s) => sessionSummary(s)) }
            : { name: t.name, url: t.url, code: output.credential, expiresAt: output.expiresAt },
        );
      }
    } catch {
      results.push({ name: t.name, status: "failed" });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (operation === "codes" && !f.json)
    console.log(
      "Enter each single-use code at the primary workspace: + Add environment > Remote link. Agent links separately require Settings > Labs > Linked environments.",
    );
  return results.some((r) => r.status === "failed") ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await pairMain(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
