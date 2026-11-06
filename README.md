# T3 fleet maintenance

Operations for `nobody0/t3code`. Stable candidates are prepared every four hours; an agent performs deployments only after the owner approves the exact candidate. Browser reminders never dispatch commands. Authentication remains upstream's 30-day policy.

## Preparation

The `Prepare stable T3 candidate` workflow merges the newest stable upstream release into a candidate branch descended from the fork's main branch. Conflicts require agent review. It tests the ownership guards, packages the browser/server once, then tests locked installs, native terminals and isolated startup on Linux x64, Windows x64 and both Mac architectures. GitHub-hosted validation does not replace target-specific NixOS/Mac checks.

Candidate IDs contain both source and operations commits. Unchanged successful candidates are not rebuilt. Four-hour checks refresh `maintenance-status/latest.json`. Schedule delays and outages are represented by timestamps. Workflows never connect to production machines. `T3_FORK_DEPLOY_KEY` is a dedicated write deploy key for the fork only; the build jobs never receive it.

GitHub can disable public-repository schedules after 60 days without repository activity. The observer marks preparation stale after eight hours instead of showing a false all-clear. If disabled, an agent re-enables `prepare.yml` and starts a check. See [GitHub's scheduling rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

`scripts/build-ko-release.mjs SOURCE OUTPUT` requires a clean published source; `T3_SOURCE_REF` selects an explicit candidate ref. `tools/scripts/ko-session.mjs` under each deployment root is an operations-only helper with `check` and `idle` release gates. It does not launch agents or maintain launch receipts, and new runtime archives do not bundle it. Agent launches and delegation use T3's native MCP tools through the target environment's authorized connection; see KO's `t3-work` skill.

## Agent rollout

1. Read KO `/api/fleet`, verify documented paths/refs and device-local identities, and review the exact prepared artifact. Maintain one private inventory using [the example schema](templates/fleet.example.json). Environment UUIDs are stable keys. Array order is rollout order: put a canary before the control machine and account for provider/shutdown dependencies. Keep desired, observed, verified, tooling and availability fields separate.
2. Review and commit operations tooling. Collect clean native evidence for each target platform with `node scripts/native-evidence.mjs PRIVATE_OUTPUT.json` (or download the prepare workflow's native evidence). Review the source customization inventory in the fork's `docs/operations/ko-fork.md`. No build, inference, OS/provider upgrade or deployment happens merely by checking status.
3. Freeze a private plan with the command below. It pins the exact source, runtime artifact, runtime packaging operations commit, installed tooling commit, platform locks, target identities, availability, order, phase budget and deadline. Review `plan.json` before continuing. Do not edit it; create a new plan when scope changes.
4. Run `stage`, then `launch`. Staging verifies identities and digests, installs side-by-side, and prepares a clean matching migration checkout. Configure device-local `packageManagerArgv` (argv for the pinned pnpm/Corepack JavaScript entry, including Node on Windows) if source dependencies must be installed. The finite native controller and per-device workers run outside the app/agent they replace. Heartbeats remain live during long DB work.
5. Use `status`, `doctor` and `resume` to inspect or continue. Receipts survive lost SSH/controllers. A stale worker, failed canary, unknown activation, mismatched identity or recovery-required state halts advancement. Busy/offline targets remain deferred and the rollout stays partial. Before candidate launch, failures preserve/resume the unchanged old owner; after possible migration, binary-only rollback is blocked. The first transition from an app without the barrier requires an explicitly reviewed `--legacy-drain` plan and a quiet user window. That flag is not persisted as device policy.
6. Require every intended device's verified receipt, then `promote` the exact source commit to fork main. Promotion rechecks device receipts and permits only a fast-forward push. Update KO deployment facts via revision-protected API. Never rebuild the approved artifact or force-push a divergent main.

```sh
node scripts/fleet.mjs plan --inventory /private/fleet.local.json --artifact /private/release --evidence /private/native-evidence --output /private/rollout --deadline 2026-11-07T12:00:00Z
node scripts/fleet.mjs stage --plan /private/rollout/plan.json
node scripts/fleet.mjs launch --plan /private/rollout/plan.json
node scripts/fleet.mjs status --plan /private/rollout/plan.json
node scripts/fleet.mjs doctor --plan /private/rollout/plan.json
# From external SSH, or launch the native controller again after a proved dead controller:
node scripts/fleet.mjs resume --plan /private/rollout/plan.json --wait
node scripts/fleet.mjs promote --plan /private/rollout/plan.json --source /verified/fork-checkout
```

`doctor` separates native process, local API, HTTPS, temporary authenticated API access, provider discovery and session expiry. Discovery is not inference: receipts explicitly report inference and agent links as untested. Request and run a separate narrowly scoped provider/UI fixture when required; ordinary smoke checks never create agent threads. Browser connections and per-thread agent links are different; Labs may disable only the latter. The read-only observer accepts `inventoryFile` and optional `controllerReceipt`, consuming this same inventory instead of duplicating targets in `machines`.

## New devices

Provision the OS, key-only SSH, Node 24, logged-in Tailscale and the intended HTTPS mapping first. Windows/macOS require an awake device and logged-in native operator; Linux requires a working lingering user manager. Review an explicit local deployment config, including absolute root/home/Node/service paths and baseline version. Then run locally or over the documented SSH entry point:

```sh
node scripts/fleet.mjs enroll --config /private/device-config.json --artifact /private/release --name device --url https://device.example/ --ssh operator@device.example
```

Enrollment checks OS/architecture, Node, disk, Tailscale and native session prerequisites. A fresh home gets a new identity; reruns preserve identity/data and refuse changed configuration, occupied ports or duplicate ownership. Existing data without an identity requires adoption diagnosis. The command installs one native ownership chain, checks local/HTTPS access and writes `enrolled.json` with the inventory target. Provider login, browser pairing and intended agent-link Labs access remain explicit operator steps. Add the verified target to private inventory and author its KO machine/deployment through the API. A failed prerequisite is incomplete enrollment, never success.

For a first Mac installation, verify architecture, launchd and the existing installation while the device is awake and the operator is logged in. Configure `initialCli` with the verified existing CLI argv and retain its original launchd definition. No startup checker installs software.

## Recovery

Activation journals record explicit stages, the pre-launch fence, previous journal/service and before/after migration state. Backups include both databases, identity, settings, secrets, themes, attachments and browser artifacts, plus matching runtime archives/locks, tooling and service/config metadata. Integrity manifests seal the files. Backups live under the owner-only deployment root and contain credentials; never upload them to GitHub. Logs/caches are rebuildable. Worktrees/unsynced edits and external provider/gateway homes require separate private backup policies.

If an activation with a real database fails, the manager attempts to stop the candidate and records `recovery-required`. It never automatically restarts an older binary against a migrated DB. Inspect the journal and service logs. Keep both failed data and the pre-upgrade snapshot. Only restore data after proving no newer work will be lost or obtaining explicit incident-specific approval. Restore a matched database/settings/secrets/identity snapshot and its corresponding previous service, then revalidate. Binary-only rollback is reserved for disposable installations without databases. An interrupted transaction blocks a second activation.

For an interrupted journal explicitly proving `candidateStarted: false`, `node scripts/manage-ko-release.mjs recover-prestart CONFIG` verifies the dead activation owner, unchanged selection/service, database integrity and old client before resuming. Unknown or migrated state is refused. A maintenance fence never expires or gets stolen automatically. Keep recovery-required candidates fenced until an operator reviews matched recovery; never clear lock files just to retry.

Configure an encrypted backup destination on a verified off-device private mount and an `age` public recipient. Encryption keys remain outside snapshots/source; the command has no default destination or key. Retention deletes only its own completed verified exports. Test restoration in a new disposable directory without launching T3, providers, native services or network access:

```sh
node scripts/fleet.mjs backup --snapshot /private/stopped-snapshot --destination /off-device/encrypted --recipient age1... --keep 5
node scripts/fleet.mjs restore-test --snapshot /private/stopped-snapshot --destination /private/new-offline-restore
```

An encrypted export has a SHA-256 sidecar. Verify it before decrypting with `age` in a private recovery directory, inspect archive paths, then run the same offline restore proof. Never bring a copied production identity online alongside its original. Full integrity/rehearsal is retained for large homes; the default activation budget is one hour and the migration worker budget is 30 minutes. Use a newly reviewed plan to change budgets, and inspect heartbeat plus stage rather than mistaking a long scan for an idle wait.

## Read-only reminder

`node scripts/observe.mjs CONFIG.local.json` refreshes preparation status and public fleet descriptors. It never mints T3 credentials, starts jobs or installs anything. Run at operator login and every five minutes. Its cache is `<KO checkout>/.cache/t3-maintenance/status.json`; author the ordinary KO note from `templates/maintenance.html` through the content API. `ko.readText` stays same-origin. Opening the note checks the cache, which can be up to five minutes old. A machine is pending only when the candidate's source commit differs from its verified commit; operations-only candidates reuse the deployed source, and their tooling is installed separately. Reports older than eight hours or observations older than ten minutes are explicitly stale.

The note is opened on demand; nothing changes the browser homepage or opens tabs at login. Instead the observer raises a desktop notification (a Windows toast that opens the note when clicked, or a macOS notification) once when something changes: a candidate whose source is not yet verified on a recorded machine, failed or stale preparation, a preparation report unavailable for over an hour, the observer failing, or a machine unreachable longer than its `offlineAlertMinutes` (default 60; `null` disables it, as for a Mac that sleeps). Announced conditions are remembered in the cache's `announced` list, so a persisting or returning condition is not repeated; `alerts` lists the current ones, and a failed delivery is logged and retried. `noteUrl` overrides the clicked link. Verify delivery on each machine with `node scripts/observe.mjs --test-notification`; on macOS run it from the observer's LaunchAgent context, because notifications from SSH sessions are not shown. Each run records preparation, machine and observer failures in the cache's `log`, which the note shows as its observer log, so failures are visible the same way on Windows and macOS. `templates/install-observer.ps1` installs the Windows login and five-minute task through a headless console host, so runs never flash a window; the Mac launch-agent equivalent is `templates/install-observer-macos.mjs`. The note offers only permanent links and a copyable agent request. KO remains documentation, not a job dispatcher.

For the Mac, first install KO's native service using `node KO_ROOT/tools/install-ko-service.mjs KO_ROOT BUN_PATH`. Then run `node templates/install-observer-macos.mjs CONFIG.local.json`. Keep the KO observer cache machine-local and publish the note through that machine's running KO API.

## Checks

Run `node --test scripts/*.test.mjs`. For actual native supervision fixtures set `KO_TEST_NATIVE=1` on Windows/macOS or `KO_TEST_SYSTEMD=1` on Linux; these use disposable service names and homes. Never point tests at production data. Review Node, provider CLIs, Tailscale and NixOS upgrades separately.

## Service supervision

Each app has one ownership chain: **native service → app wrapper → app child**. T3 uses `serve-t3.mjs` on Windows, macOS and both Linux roots. KO uses its canonical `server/service.ts` wrapper on Windows and macOS. Native managers recover wrapper exits; wrappers recover child exits and HTTP hangs. There are no separate T3 watchdog jobs. The observer remains a read-only client.

Install T3 supervision with `node scripts/install-t3-supervisor.mjs DEPLOYMENT_ROOT/config.json`. The installer checks idle state and recovery records, retires legacy watchdog tasks/timers, archives their local tooling, and replaces the configured primary service. It preserves the selected release, home, environment identity, credentials and Tailscale routes. The installed tooling receipt is `supervisor-installed.json`.

Control T3 with `node DEPLOYMENT_ROOT/tools/scripts/control-t3-service.mjs status|start|stop DEPLOYMENT_ROOT/config.json`. Intentional stop persists a `service-stopped` marker and disables Windows/macOS startup; Linux's unit condition prevents startup until the marker is cleared. Start resumes the same primary service. Mutating controls use the deployment lock and reject unresolved recovery. Status is read-only. Do not add another direct T3 launcher or an external recovery job.

The primary Windows task is hidden, runs at login and retries once a minute with `IgnoreNew`, so an existing task never overlaps a second instance. macOS uses one `RunAtLoad`/`KeepAlive` LaunchAgent; Linux uses a lingering user service with `Restart=always`. Windows and macOS still require an awake device and logged-in operator. No sleep or wake policy is changed.

The T3 wrapper waits 90 seconds after startup/wake, confirms failed loopback descriptor probes spanning at least 60 seconds, and backs repeated restarts off up to five minutes. It owns only the child it spawned, holds an exclusive loopback control listener, and pauses recovery during deployment locks or unresolved migration records. Provider login, quota and Tailscale failures do not trigger app restarts. Its private `service-runtime.json` contains controller credentials and must never be edited, committed or shared.

If a native wrapper dies while its app wrapper runs on, the replacement does not fail beside it or start a second app: it verifies the running owner through its control token, adopts it and holds the native service until that owner exits, then exits so the native service starts a fresh wrapper. `status` reports `ownership: native|adopted`; `stop` also stops an adopted owner. On Windows the app wrapper writes `service.stdout.log`/`service.stderr.log` itself (rotating near 64 MiB), so losing the PowerShell wrapper cannot break the app's output. It ignores broken console pipes, records fatal errors and child exit codes in `service-supervisor.log` (rotating near 1 MiB), and the PowerShell wrapper adds the supervisor's exit code there. macOS and Linux app output follows the native service's log paths.

`scripts/lib/service-monitor.mjs` is the common liveness/backoff implementation. KO vendors the same file under `tools/service-monitor.mjs` so either repository runs independently. Update it here, then run `node scripts/sync-service-monitor.mjs KO_ROOT`; verify parity with `--check` and review both repository changes together.

Run `KO_TEST_SUPERVISOR=1 node --test scripts/service-supervisor*.test.mjs` on each target OS (PowerShell: `$env:KO_TEST_SUPERVISOR='1'`). Fixtures use disposable native services and homes to verify crash/hang recovery, wrapper adoption (on Windows also after killing only the native wrapper) and clean intentional stop. Validate production local/HTTPS descriptors and native wrapper ownership after installation; do not fault-inject or reboot an active production machine.

## Client pairing

`node scripts/fleet.mjs pair codes --fleet /private/fleet.local.json` issues explicitly requested single-use codes using upstream's default scopes and lifetime. Enter them at the primary workspace under **+ Add environment → Remote link**. Codes are never saved to KO or receipts. `pair sessions` reports expiry (warning below seven days) and Connections permission mismatches; `pair revoke NAME SESSION_ID...` revokes only named sessions. `--only`, repeated `--scope`, `--ttl` and `--label` remain available; the legacy helper option `--scopes standard` explicitly reduces permissions to 13. Healthy sessions are not re-paired. Default inventory: `$T3_FLEET` or `~/.config/t3-code-ko/fleet.local.json`. The original `scripts/pair-fleet.mjs` command is also supported with this same validated schema. Agent links separately require Settings → Labs → Linked environments.
