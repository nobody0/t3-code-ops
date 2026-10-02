# T3 fleet maintenance

Operations for `nobody0/t3code`. Stable candidates are prepared every four hours; an agent performs deployments only after the owner approves the exact candidate. Browser reminders never dispatch commands. Authentication remains upstream's 30-day policy.

## Preparation

The `Prepare stable T3 candidate` workflow merges the newest stable upstream release into a candidate branch descended from the fork's main branch. Conflicts require agent review. It tests the ownership guards, packages the browser/server once, then tests locked installs, native terminals and isolated startup on Linux x64, Windows x64 and both Mac architectures. GitHub-hosted validation does not replace target-specific NixOS/Mac checks.

Candidate IDs contain both source and operations commits. Unchanged successful candidates are not rebuilt. Four-hour checks refresh `maintenance-status/latest.json`. Schedule delays and outages are represented by timestamps. Workflows never connect to production machines. `T3_FORK_DEPLOY_KEY` is a dedicated write deploy key for the fork only; the build jobs never receive it.

GitHub can disable public-repository schedules after 60 days without repository activity. The observer marks preparation stale after eight hours instead of showing a false all-clear. If disabled, an agent re-enables `prepare.yml` and starts a check. See [GitHub's scheduling rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

`scripts/build-ko-release.mjs SOURCE OUTPUT` requires a clean published source; `T3_SOURCE_REF` selects an explicit candidate ref. The compatibility helper still ships at `node_modules/t3/dist/ko-session.mjs`. The maintained copy is separately installed at `tools/scripts/ko-session.mjs` under each deployment root.

## Agent rollout

1. Read the KO fleet and deployment entities, verify the target paths and refs, and obtain approval for the exact release in conversation. Check the report is ready and every target platform has a tested lock.
2. Fetch the candidate branch and fast-forward fork main to its exact commit after reviewing the diff. If main diverged, prepare a new candidate; do not force-push or rebuild the approved artifact.
3. Download the release archive and compare its SHA-256 with the reviewed report. Extract to a new incoming directory; keep the manifest and platform locks. Run `node tools/scripts/install-ko-release.mjs INCOMING RELEASES_ROOT`. This stages files and never restarts production.
4. On each target prepare a clean candidate source checkout with its frozen build dependencies. Set `migrationSource` in the local deployment config to that checkout, and `baselineVersion` to the approved candidate's upstream version. This enables database-only rehearsal without adding migration commands to T3 itself.
5. Run the external helper `check` and `idle` with the documented home, loopback origin, environment ID and installed CLI argv. Defer active turns or terminal subprocesses. Ask the user to pause new work during the brief cutover; idle checks are not an atomic application maintenance lock.
6. Run `node tools/scripts/manage-ko-release.mjs activate CONFIG RELEASE_ID`. The manager verifies the package, isolates a startup check, rechecks idle state, stops the native service, backs up the existing home, rehearses migrations on a copy and then activates. The original home, identities, service names and Tailscale mappings stay intact.
7. Verify authenticated API and provider readiness, DB integrity and migration report, running commit/receipt, HTTPS descriptor, frontend entry assets and stable process. Test Klarstand first, then Windows, then Caps. Stop the rollout after a failure. Update KO deployment entities with the actual result using `baseRev`; update local observer configurations with the verified commit/release.

The Mac remains pending until it is reachable, awake and Bob is logged in. An agent first verifies architecture, launchd and the old installation. During its initial migration, configure `initialCli` with the verified existing CLI argv, stage the candidate, and keep a copy of its original launchd definition. No startup checker installs software.

## Recovery

Activation journals record the previous service, backup and before/after migration state. Backups live under the deployment root with owner-only directory permissions. Treat them as credentials; never upload them to GitHub.

If an activation with a real database fails, the manager attempts to stop the candidate and records `recovery-required`. It never automatically restarts an older binary against a migrated DB. Inspect the journal and service logs. Keep both failed data and the pre-upgrade snapshot. Only restore data after proving no newer work will be lost or obtaining explicit incident-specific approval. Restore a matched database/settings/secrets/identity snapshot and its corresponding previous service, then revalidate. Binary-only rollback is reserved for disposable installations without databases. An interrupted transaction blocks a second activation.

## Read-only reminder

`node scripts/observe.mjs CONFIG.local.json` refreshes preparation status and public fleet descriptors. It never mints T3 credentials, starts jobs or installs anything. Run at operator login and every five minutes. Its cache is `<KO checkout>/.cache/t3-maintenance/status.json`; author the ordinary KO note from `templates/maintenance.html` through the content API. `ko.readText` stays same-origin. Opening the note checks the cache, which can be up to five minutes old. Reports older than eight hours or observations older than ten minutes are explicitly stale.

Configure the note as a Firefox home/startup tab without disabling session restore. `templates/install-observer.ps1` installs the hidden Windows login task; the Mac launch-agent equivalent is installed by the agent when that machine returns. The note offers only permanent links and a copyable agent request. KO remains documentation, not a job dispatcher.

For the Mac, run `node templates/install-observer-macos.mjs CONFIG.local.json`, then `node templates/install-startpage-macos.mjs FIREFOX_PROFILE KO_ROOT BUN_PATH`. The second command writes the homepage preference and a login LaunchAgent without opening the browser during setup. It preserves session restore. Keep the KO observer cache machine-local and publish the note through that machine's running KO API.

## Checks

Run `node --test scripts/*.test.mjs`. For actual native supervision fixtures set `KO_TEST_NATIVE=1` on Windows/macOS or `KO_TEST_SYSTEMD=1` on Linux; these use disposable service names and homes. Never point tests at production data. Review Node, provider CLIs, Tailscale and NixOS upgrades separately.
