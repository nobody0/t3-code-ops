import fs from "node:fs";
import path from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const platforms = new Set(["linux-x64", "win32-x64", "darwin-arm64", "darwin-x64"]);
export function validateTarget(t) {
  if (!t || !uuid.test(t.environmentId) || typeof t.name !== "string" || !t.name.trim())
    throw Error("Target requires a name and environment UUID.");
  if (!platforms.has(`${t.platform}-${t.arch}`)) throw Error("Unsupported target OS/architecture.");
  const p = t.platform === "win32" ? path.win32 : path.posix;
  for (const key of ["root", "node"])
    if (typeof t[key] !== "string" || !p.isAbsolute(t[key]) || /[\r\n\0]/.test(t[key]))
      throw Error(`Target requires an absolute ${key}.`);
  if (
    t.ssh !== undefined &&
    (typeof t.ssh !== "string" || !/^[a-zA-Z0-9_@.:[\]-]+$/.test(t.ssh) || t.ssh.startsWith("-"))
  )
    throw Error("Invalid SSH destination.");
  if (t.url !== undefined) {
    const u = new URL(t.url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw Error("Target URL must be a permanent HTTPS origin.");
  }
  if (!["online", "asleep", "offline", "retired"].includes(t.availability ?? "online"))
    throw Error("Invalid device availability.");
  if (
    t.expectedProviders !== undefined &&
    (!Array.isArray(t.expectedProviders) ||
      t.expectedProviders.some((x) => typeof x !== "string" || !x))
  )
    throw Error("Invalid expected provider instances.");
  for (const key of Object.keys(t))
    if (/token|password|credential|secret|pairing/i.test(key))
      throw Error("Credentials do not belong in inventory.");
  return structuredClone(t);
}
export function validateInventory(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.targets) || !value.targets.length)
    throw Error("Expected inventory schemaVersion 1 and targets.");
  const targets = value.targets.map(validateTarget),
    ids = new Set(),
    names = new Set(),
    roots = new Set();
  for (const t of targets) {
    const root = `${t.ssh ?? "local"}:${t.root.toLowerCase()}`;
    if (ids.has(t.environmentId) || names.has(t.name.toLowerCase()) || roots.has(root))
      throw Error("Duplicate target identity, name or deployment root.");
    ids.add(t.environmentId);
    names.add(t.name.toLowerCase());
    roots.add(root);
  }
  return { ...value, targets };
}
export const loadInventory = (file) => validateInventory(JSON.parse(fs.readFileSync(file, "utf8")));
export function selectTargets(inventory, only) {
  if (!only) return inventory.targets;
  const names = only.split(",").map((x) => x.trim().toLowerCase());
  const selected = names.map((n) =>
    inventory.targets.find((t) => t.name.toLowerCase() === n || t.environmentId === n),
  );
  if (selected.some((x) => !x) || new Set(selected).size !== selected.length)
    throw Error("Unknown or duplicate target selection.");
  return selected;
}
