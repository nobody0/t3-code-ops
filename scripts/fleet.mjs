#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { atomicJson, readJson, run, digest } from "./lib/ko-release.mjs";
import { loadInventory } from "./lib/fleet-inventory.mjs";
import { freezePlan, loadPlan, verifyToolchain } from "./lib/fleet-plan.mjs";
import { remoteJob, stageBundles } from "./lib/fleet-transport.mjs";
import { runRollout, summarize } from "./lib/fleet-runner.mjs";
import { nativeOnce, cleanupNative } from "./lib/native-once.mjs";
import { enroll } from "./lib/fleet-enroll.mjs";
import { exportEncrypted, restoreTest } from "./lib/ko-backup.mjs";
import { pairMain } from "./pair-fleet.mjs";

const help = `Usage: node scripts/fleet.mjs COMMAND [options]
  plan --inventory FILE --artifact DIR --evidence DIR --output NEW_DIR --deadline ISO [--legacy-drain]
  stage --plan FILE
  launch --plan FILE                    install a finite native controller
  rollout|resume --plan FILE [--wait]    run from external SSH/native ownership
  status|doctor --plan FILE
  enroll --config FILE --artifact DIR --name NAME --url HTTPS [--ssh ALIAS]
  pair codes|sessions|revoke ...         same private inventory as plan/observer
  backup --snapshot DIR --destination PRIVATE_MOUNT --recipient age1... [--keep N]
  restore-test --snapshot DIR --destination NEW_DISPOSABLE_DIR
  promote --plan FILE --source CHECKOUT requires every target verified
Plans and receipts are private. Pairing codes print only for an explicit pair codes command.`;

const [operation, ...argv] = process.argv.slice(2);
try {
  if (operation === "pair") {
    process.exitCode = await pairMain(argv);
  } else if (!operation || operation === "--help") console.log(help);
  else {
    const { values: f } = parseArgs({
      args: argv,
      options: Object.fromEntries(
        [
          "inventory",
          "artifact",
          "output",
          "deadline",
          "plan",
          "config",
          "name",
          "url",
          "ssh",
          "snapshot",
          "destination",
          "recipient",
          "keep",
          "source",
          "native-job",
          "evidence",
        ]
          .map((x) => [x, { type: "string" }])
          .concat(["wait", "legacy-drain"].map((x) => [x, { type: "boolean" }])),
      ),
    });
    const required = (name) => {
      if (!f[name]) throw Error(`--${name} is required.`);
      return f[name];
    };
    let result;
    if (operation === "plan")
      result = freezePlan({
        inventory: loadInventory(required("inventory")),
        artifact: required("artifact"),
        tooling: path.resolve(import.meta.dirname, ".."),
        output: required("output"),
        deadline: required("deadline"),
        allowLegacyDrain: f["legacy-drain"] ?? false,
        nativeEvidence: fs
          .readdirSync(required("evidence"))
          .filter((n) => n.endsWith(".json"))
          .map((n) => readJson(path.join(f.evidence, n))),
      });
    else if (operation === "enroll")
      result = await enroll({
        configFile: required("config"),
        artifact: required("artifact"),
        name: required("name"),
        url: required("url"),
        ssh: f.ssh,
      });
    else if (operation === "backup")
      result = exportEncrypted(required("snapshot"), {
        destination: required("destination"),
        recipient: required("recipient"),
        keep: Number(f.keep ?? 5),
      });
    else if (operation === "restore-test")
      result = restoreTest(required("snapshot"), required("destination"));
    else {
      const planFile = path.resolve(required("plan")),
        directory = path.dirname(planFile),
        p = loadPlan(planFile);
      if (operation === "stage") {
        result = [];
        for (const t of p.targets) result.push(await stageBundles(t, p, directory));
      } else if (["status", "doctor"].includes(operation)) {
        result = [];
        for (const t of p.targets) {
          try {
            result.push({
              name: t.name,
              ...(await remoteJob(t, {
                action: operation,
                toolingCommit: p.toolingCommit,
                plan: p,
              })),
            });
          } catch (error) {
            result.push({ name: t.name, status: "unreachable", error: error.message });
          }
        }
      } else if (["rollout", "resume"].includes(operation)) {
        try {
          result = await runRollout(p, directory, { wait: f.wait ?? false });
        } finally {
          if (f["native-job"])
            try {
              cleanupNative(f["native-job"], process.platform, directory);
            } catch {}
        }
        if (result.status !== "completed") process.exitCode = 2;
      } else if (operation === "launch") {
        const chain = path.join(directory, "controller-toolchain");
        if (digest(path.join(directory, "tooling.tar")) !== p.bundles.tooling)
          throw Error("Controller tooling archive changed.");
        if (!fs.existsSync(chain)) {
          fs.mkdirSync(chain, { mode: 0o700 });
          run("tar", ["-xf", path.join(directory, "tooling.tar"), "-C", chain]);
        }
        verifyToolchain(chain, p);
        const name = "t3-fleet-" + p.id.slice(0, 16) + "-c";
        result = nativeOnce({
          name,
          node: process.execPath,
          args: [
            path.join(chain, "scripts/fleet.mjs"),
            "rollout",
            "--plan",
            planFile,
            "--wait",
            "--native-job",
            name,
          ],
          directory,
          userName: process.platform === "win32" ? run("whoami.exe", []) : undefined,
        });
      } else if (operation === "promote") {
        const receipts = readJson(path.join(directory, "controller.json"));
        if (
          receipts.planId !== p.id ||
          receipts.status !== "completed" ||
          summarize(p, receipts.results).status !== "completed"
        )
          throw Error("Every intended target must pass before promotion.");
        // Re-read device receipts before advancing the next preparation base.
        for (const t of p.targets) {
          const s = await remoteJob(t, {
            action: "status",
            toolingCommit: p.toolingCommit,
            plan: p,
          });
          if (s.receipt?.status !== "verified" || s.observed?.commit !== p.sourceCommit)
            throw Error("Fleet acceptance changed.");
        }
        const source = required("source");
        if (run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: source }))
          throw Error("Promotion source checkout is dirty.");
        run("git", ["fetch", "origin", "main"], { cwd: source });
        run("git", ["merge-base", "--is-ancestor", "refs/remotes/origin/main", p.sourceCommit], {
          cwd: source,
        });
        run("git", ["push", "origin", `${p.sourceCommit}:refs/heads/main`], { cwd: source });
        result = { promoted: p.sourceCommit, releaseId: p.release.releaseId };
        atomicJson(path.join(directory, "promotion.json"), result);
      } else throw Error(help);
    }
    if (result) console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
