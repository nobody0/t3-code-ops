#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [koRoot, mode, extra] = process.argv.slice(2);
if (!koRoot || extra || (mode && mode !== "--check"))
  throw Error("Usage: node scripts/sync-service-monitor.mjs KO_ROOT [--check]");
const root = path.resolve(koRoot);
if (!fs.existsSync(path.join(root, "server/service.ts"))) throw Error("Verify the KO checkout.");
const source = fs.readFileSync(path.join(import.meta.dirname, "lib/service-monitor.mjs"));
const destination = path.join(root, "tools/service-monitor.mjs");
if (mode === "--check") {
  if (!source.equals(fs.readFileSync(destination)))
    throw Error("KO monitor copy differs; run sync-service-monitor.mjs without --check.");
  console.log("KO and T3 use the same monitor source.");
} else {
  fs.writeFileSync(destination, source);
  console.log("Updated the KO monitor copy; review both repository changes.");
}
