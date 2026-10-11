param([Parameter(Mandatory=$true)][string]$OpsRoot,[Parameter(Mandatory=$true)][string]$Config,[string]$Node=(Get-Command node).Source)
$ErrorActionPreference='Stop'
$script=Join-Path $OpsRoot 'scripts/observe.mjs'
if(!(Test-Path -LiteralPath $script) -or !(Test-Path -LiteralPath $Config)){throw 'Observer source or config missing'}
$Config=(Resolve-Path -LiteralPath $Config).Path
# Every console program started in the login session flashes a window, including powershell -WindowStyle Hidden.
# A headless conhost hosts node without one, so the five-minute repetition stays invisible.
$conhost=Join-Path $env:SystemRoot 'System32\conhost.exe'
$action=New-ScheduledTaskAction -Execute $conhost -Argument ('--headless '+((@($Node,$script,$Config)|ForEach-Object {'"'+$_+'"'}) -join ' ')) -WorkingDirectory $OpsRoot
$login=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 't3-maintenance-observer' -Action $action -Trigger @($login,$repeat) -Settings $settings -Principal $principal -Force | Out-Null
# Earlier installs generated a PowerShell launcher; the task no longer uses it.
Remove-Item -LiteralPath (Join-Path (Split-Path $Config) 'observer.ps1') -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 't3-maintenance-observer'
