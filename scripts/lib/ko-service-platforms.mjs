/* oxlint-disable t3code/no-global-process-runtime -- Standalone native service tooling outside the Effect application. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { run } from "./ko-release.mjs";

const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export const appArgs = (c, target) => [
  NodePath.join(target, "node_modules/t3/dist/bin.mjs"),
  "serve",
  "--host",
  "127.0.0.1",
  "--port",
  String(c.port),
  "--base-dir",
  c.baseDir,
];
export const nativeArgs = (c, target) => [
  NodePath.join(c.root, "tools/scripts/serve-t3.mjs"),
  NodePath.join(c.root, "config.json"),
  target,
];
export function ensureSupervisor(c) {
  const config = NodePath.join(c.root, "config.json");
  if (!NodeFS.existsSync(config)) writeFile(config, JSON.stringify(c, null, 2) + "\n");
  for (const name of ["serve-t3.mjs", "lib/service-monitor.mjs"]) {
    const source = NodePath.resolve(import.meta.dirname, "..", name);
    const destination = NodePath.join(c.root, "tools/scripts", name);
    if (NodePath.resolve(source) !== NodePath.resolve(destination))
      writeFile(destination, NodeFS.readFileSync(source, "utf8"));
  }
}
export function renderSystemdOverride(c, target) {
  const quote = (value) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  return `[Service]\nUnsetEnvironment=T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT\nEnvironment=T3_KO_MANAGED=1\nRestart=always\nRestartSec=5\nKillMode=control-group\nExecStart=\nExecStart=${[c.node, ...nativeArgs(c, target)].map(quote).join(" ")}\n`;
}
export function windowsArgument(value) {
  return (
    '"' +
    String(value)
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\+)$/, "$1$1") +
    '"'
  );
}
export function optionalFile(file) {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export function writeFile(file, value) {
  if (value === null) {
    NodeFS.rmSync(file, { force: true });
    return;
  }
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
  NodeFS.renameSync(temporary, file);
}
function plistValue(value) {
  if (typeof value === "string") return `<string>${xml(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number" && Number.isInteger(value)) return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join("")}</array>`;
  if (value && typeof value === "object")
    return `<dict>${Object.entries(value)
      .map(([key, item]) => `<key>${xml(key)}</key>${plistValue(item)}`)
      .join("")}</dict>`;
  throw new Error("Unsupported existing plist value; preserve it manually before migration.");
}
export function renderLaunchd(c, target, previous = {}) {
  if (previous.Label && previous.Label !== c.service)
    throw new Error("Existing launchd label does not match configuration.");
  const next = {
    ...previous,
    Label: c.service,
    ProgramArguments: [c.node, ...nativeArgs(c, target)],
    RunAtLoad: true,
    KeepAlive: true,
    AbandonProcessGroup: false,
    StandardOutPath: previous.StandardOutPath ?? NodePath.join(c.root, "service.stdout.log"),
    StandardErrorPath: previous.StandardErrorPath ?? NodePath.join(c.root, "service.stderr.log"),
  };
  // Program takes precedence over argv[0]; remove an older launcher executable.
  delete next.Program;
  next.EnvironmentVariables = {
    ...previous.EnvironmentVariables,
    T3CODE_HOME: c.baseDir,
    T3_KO_MANAGED: "1",
  };
  delete next.EnvironmentVariables.T3_BOOT_SERVICE_UNIT;
  delete next.EnvironmentVariables.T3_SERVICE_LAUNCHER_CONTEXT;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(next)}</plist>\n`;
}
export function renderWindowsScript(c, target) {
  const runtime = NodePath.join(c.root, "task-runtime.json");
  return `$ErrorActionPreference = 'Stop'
$nodePath = ${psQuote(c.node)}
$arguments = ${psQuote(nativeArgs(c, target).map(windowsArgument).join(" "))}
$runtimePath = ${psQuote(runtime)}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodePath
$psi.Arguments = $arguments
$psi.WorkingDirectory = ${psQuote(c.baseDir)}
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables['T3CODE_HOME'] = ${psQuote(c.baseDir)}
$psi.EnvironmentVariables['T3_KO_MANAGED'] = '1'
$psi.EnvironmentVariables.Remove('T3_BOOT_SERVICE_UNIT')
$psi.EnvironmentVariables.Remove('T3_SERVICE_LAUNCHER_CONTEXT')
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $psi
$started = $false
try {
  if (-not $child.Start()) { throw 'T3 process did not start.' }
  $started = $true
  @{ pid = $child.Id; started = $child.StartTime.ToUniversalTime().ToString('o'); executable = $nodePath } | ConvertTo-Json -Compress | Set-Content -LiteralPath $runtimePath -Encoding UTF8
  # The supervisor writes its own and the app's logs, so they survive this wrapper.
  $outCopy = $child.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
  $errCopy = $child.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
  $child.WaitForExit()
  $outCopy.GetAwaiter().GetResult()
  $errCopy.GetAwaiter().GetResult()
  $result = $child.ExitCode
  try { Add-Content -LiteralPath ${psQuote(NodePath.join(c.root, "service-supervisor.log"))} -Value ('{0} [native] supervisor pid={1} exited code={2}' -f [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), $child.Id, $result) } catch {}
} finally {
  # If the wrapper was killed abruptly, clean only its verified app child tree.
  $ownedRuntime = ${psQuote(NodePath.join(c.root, "service-runtime.json"))}
  if ($started -and $child.HasExited -and (Test-Path -LiteralPath $ownedRuntime)) {
    $owned = Get-Content -Raw -LiteralPath $ownedRuntime | ConvertFrom-Json
    if ($owned.pid -eq $child.Id -and $owned.childPid) {
      $app = Get-CimInstance Win32_Process -Filter "ProcessId=$($owned.childPid)" -ErrorAction SilentlyContinue
      if ($app -and $app.ParentProcessId -eq $child.Id -and $app.ExecutablePath -eq $nodePath -and $app.CommandLine.Contains(${psQuote(NodePath.join(target, "node_modules/t3/dist/bin.mjs"))})) {
        & taskkill.exe /PID $app.ProcessId /T /F | Out-Null
      }
    }
  }
  $stdout.Dispose(); $stderr.Dispose()
}
# A server exit, including a clean unexpected exit, asks Task Scheduler to recover.
if ($result -eq 0) { exit 1 }
exit $result
`;
}
export function renderWindowsTask(c, scriptPath, sid) {
  const executable = NodePath.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
  ]
    .map(windowsArgument)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger><CalendarTrigger><Repetition><Interval>PT1M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>${xml(executable)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(c.baseDir)}</WorkingDirectory></Exec></Actions>
</Task>`;
}
function powershell(script) {
  return run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
        script +
        "; exit 0",
      "utf16le",
    ).toString("base64"),
  ]);
}
export function platformAdapter(c) {
  if ((c.platform ?? "linux") !== process.platform)
    throw new Error(`Run ${c.platform} service management on that target platform.`);
  if ((c.platform ?? "linux") === "linux") {
    const ctl = (...args) => run("systemctl", ["--user", ...args, c.service]);
    return {
      info: () => {
        const text = ctl("show", "--property=ActiveState,MainPID");
        return {
          state: text.match(/^ActiveState=(.*)$/m)?.[1] ?? "unknown",
          pid: text.match(/^MainPID=([1-9][0-9]*)$/m)?.[1] ?? "",
        };
      },
      start: () => ctl("start"),
      stop: () => ctl("stop"),
      suspend: () => {},
      resume: () => {},
      install: (target) => {
        ensureSupervisor(c);
        writeFile(
          NodePath.join(c.unitDirectory, `${c.service}.d/90-ko-fork.conf`),
          renderSystemdOverride(c, target),
        );
        run("systemctl", ["--user", "daemon-reload"]);
        ctl("restart");
      },
    };
  }
  if (c.platform === "darwin") {
    const file = NodePath.join(c.unitDirectory, `${c.service}.plist`);
    const domain = `gui/${process.getuid()}`;
    const name = `${domain}/${c.service}`;
    function info() {
      try {
        const result = run("launchctl", ["print", name]);
        return {
          state: /state = running/.test(result) ? "active" : "inactive",
          pid: result.match(/\bpid = (\d+)/)?.[1] ?? "",
        };
      } catch {
        return { state: "inactive", pid: "" };
      }
    }
    function replace(value) {
      // A loaded stopped job still needs bootout before replacing its definition.
      let loaded = false;
      try {
        run("launchctl", ["print", name]);
        loaded = true;
      } catch {
        /* absent */
      }
      if (loaded) stop();
      writeFile(file, value);
      if (value !== null) {
        run("plutil", ["-lint", file]);
        // bootout returns before launchd has finished unloading the old job.
        const deadline = Date.now() + 10000;
        while (true) {
          try {
            run("launchctl", ["bootstrap", domain, file]);
            break;
          } catch (error) {
            if (Date.now() >= deadline) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          }
        }
      }
    }
    function stop() {
      let loaded = false;
      try {
        run("launchctl", ["print", name]);
        loaded = true;
      } catch {
        /* unloaded */
      }
      if (!loaded) return;
      const owned = info().pid;
      run("launchctl", ["bootout", name]);
      if (!owned) return;
      const deadline = Date.now() + 10000;
      while (true) {
        try {
          process.kill(Number(owned), 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
        if (Date.now() >= deadline) throw Error("launchd wrapper has not finished stopping.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    return {
      info,
      start: () => {
        let loaded = false;
        try {
          run("launchctl", ["print", name]);
          loaded = true;
        } catch {
          /* unloaded */
        }
        if (loaded) run("launchctl", ["kickstart", name]);
        else run("launchctl", ["bootstrap", domain, file]);
      },
      suspend: () => run("launchctl", ["disable", name]),
      resume: () => run("launchctl", ["enable", name]),
      stop,
      capture: () => ({ definition: optionalFile(file) }),
      install: (target) => {
        ensureSupervisor(c);
        const old = optionalFile(file);
        const previous =
          old === null ? {} : JSON.parse(run("plutil", ["-convert", "json", "-o", "-", file]));
        replace(renderLaunchd(c, target, previous));
      },
      restore: (saved) => replace(saved.definition),
    };
  }
  if (c.platform !== "win32") throw new Error("Unsupported native service platform.");
  const scriptPath = NodePath.join(c.unitDirectory, `${c.service}.ps1`);
  const task = psQuote(c.service);
  const runtime = psQuote(NodePath.join(c.root, "task-runtime.json"));
  const getTask = `$task=Get-ScheduledTask -TaskPath '\\' -TaskName ${task} -ErrorAction SilentlyContinue;`;
  // Validate both identity and creation time before trusting a reusable process ID.
  const getChild = `$child=$null; if(Test-Path -LiteralPath ${runtime}){ $r=Get-Content -Raw -LiteralPath ${runtime}|ConvertFrom-Json; $candidate=Get-Process -Id $r.pid -ErrorAction SilentlyContinue; if($candidate -and $candidate.Path -eq $r.executable -and $candidate.StartTime.ToUniversalTime().ToString('o') -eq $r.started){$child=$candidate} };`;
  function stop() {
    // The owner is normally the task's child; after a wrapper replacement it is the
    // supervisor that child adopted. Its token proves it before the wait.
    powershell(
      `${getTask}${getChild}
      $ownedFile=${psQuote(NodePath.join(c.root, "service-runtime.json"))};
      if(Test-Path -LiteralPath $ownedFile){$owned=Get-Content -Raw -LiteralPath $ownedFile|ConvertFrom-Json;
        if($owned.controlOrigin -match '^http://127\\.0\\.0\\.1:[0-9]+$'){
          $supervisor=Get-Process -Id $owned.pid -ErrorAction SilentlyContinue;
          try{Invoke-RestMethod -Method Post -Uri ($owned.controlOrigin+'/stop') -Headers @{Authorization=('Bearer '+$owned.token)} -TimeoutSec 2|Out-Null;if($supervisor){$supervisor.WaitForExit(10000)|Out-Null}}catch{}
        }
      }; if($child -and -not $child.HasExited){ & taskkill.exe /PID $child.Id /T /F | Out-Null }; if($task){ Stop-ScheduledTask -TaskPath '\\' -TaskName ${task} };`,
    );
  }
  function register(definition) {
    powershell(
      `Register-ScheduledTask -TaskPath '\\' -TaskName ${task} -Xml ${psQuote(definition)} -Force | Out-Null; Start-ScheduledTask -TaskPath '\\' -TaskName ${task}`,
    );
  }
  return {
    stop,
    start: () => powershell(`Start-ScheduledTask -TaskPath '\\' -TaskName ${task}`),
    suspend: () => powershell(`Disable-ScheduledTask -TaskPath '\\' -TaskName ${task}|Out-Null`),
    resume: () => powershell(`Enable-ScheduledTask -TaskPath '\\' -TaskName ${task}|Out-Null`),
    info: () =>
      JSON.parse(
        powershell(
          `${getTask}${getChild} @{state=$(if($task -and $task.State -eq 'Running' -and $child){'active'}else{'inactive'});pid=$(if($child){[string]$child.Id}else{''})} | ConvertTo-Json -Compress`,
        ),
      ),
    capture: () => ({
      definition:
        powershell(
          `${getTask} if($task){ Export-ScheduledTask -TaskPath '\\' -TaskName ${task} }`,
        ) || null,
      script: optionalFile(scriptPath),
    }),
    install: (target) => {
      ensureSupervisor(c);
      const sid = powershell(
        `(New-Object System.Security.Principal.NTAccount(${psQuote(c.userName)})).Translate([System.Security.Principal.SecurityIdentifier]).Value`,
      );
      if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error("Cannot resolve Windows operator SID.");
      stop();
      writeFile(scriptPath, renderWindowsScript(c, target));
      register(renderWindowsTask(c, scriptPath, sid));
    },
    restore: (saved) => {
      stop();
      writeFile(scriptPath, saved.script ?? null);
      if (saved.definition !== null) register(saved.definition);
      else
        powershell(
          `${getTask} if($task){Unregister-ScheduledTask -TaskPath '\\' -TaskName ${task} -Confirm:$false}`,
        );
    },
  };
}
