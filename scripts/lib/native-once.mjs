import fs from "node:fs";
import path from "node:path";
import { run } from "./ko-release.mjs";
import { windowsArgument } from "./ko-service-platforms.mjs";
const ps = (s) => "'" + s.replaceAll("'", "''") + "'";
const xml = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const powershell = (script) =>
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from("$ErrorActionPreference='Stop';" + script, "utf16le").toString("base64"),
  ]);
export function nativeOnce({ name, node, args, directory, userName, platform = process.platform }) {
  if (!/^t3-fleet-[0-9a-f-]+$/.test(name) || platform !== process.platform)
    throw Error("Invalid native job identity.");
  if (platform === "linux") {
    let active = false;
    try {
      active = run("systemctl", ["--user", "is-active", name + ".service"]) === "active";
    } catch {}
    if (active) return { name, status: "running" };
    run("systemd-run", [
      "--user",
      "--collect",
      `--unit=${name}`,
      `--working-directory=${directory}`,
      "--property=Type=exec",
      node,
      ...args,
    ]);
    return { name, status: "started" };
  }
  if (platform === "darwin") {
    const domain = `gui/${process.getuid()}`,
      file = path.join(directory, name + ".plist");
    let loaded = false;
    try {
      run("launchctl", ["print", `${domain}/${name}`]);
      loaded = true;
    } catch {}
    if (loaded)
      throw Error(
        "A native job with this identity remains loaded; inspect its receipt before cleanup.",
      );
    fs.writeFileSync(
      file,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[node, ...args].map((s) => "<string>" + xml(s) + "</string>").join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>WorkingDirectory</key><string>${xml(directory)}</string></dict></plist>`,
      { mode: 0o600 },
    );
    run("launchctl", ["bootstrap", domain, file]);
    return { name, status: "started" };
  }
  if (platform !== "win32" || !userName)
    throw Error("A Windows native job requires the explicit logged-in operator.");
  const command = args.map(windowsArgument).join(" ");
  const result = powershell(
    `$name=${ps(name)};$existing=Get-ScheduledTask -TaskPath '\\' -TaskName $name -ErrorAction SilentlyContinue;if($existing){if($existing.State -eq 'Running'){Write-Output 'running';exit 0};throw 'Existing native job requires receipt review'};$sid=(New-Object Security.Principal.NTAccount(${ps(userName)})).Translate([Security.Principal.SecurityIdentifier]).Value;$action=New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(command)} -WorkingDirectory ${ps(directory)};$principal=New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited;$settings=New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit (New-TimeSpan -Days 7) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskPath '\\' -TaskName $name -Action $action -Principal $principal -Settings $settings|Out-Null;Start-ScheduledTask -TaskPath '\\' -TaskName $name;Write-Output 'started'`,
  );
  return { name, status: result };
}
export function cleanupNative(name, platform, directory) {
  if (!/^t3-fleet-[0-9a-f-]+$/.test(name) || platform !== process.platform)
    throw Error("Invalid native cleanup identity.");
  if (platform === "win32")
    powershell(
      `Unregister-ScheduledTask -TaskPath '\\' -TaskName ${ps(name)} -Confirm:$false -ErrorAction SilentlyContinue`,
    );
  else if (platform === "darwin") {
    fs.rmSync(path.join(directory, name + ".plist"), { force: true });
    run("launchctl", ["bootout", `gui/${process.getuid()}/${name}`]);
  }
  // systemd --collect removes the transient job after its process exits.
}
