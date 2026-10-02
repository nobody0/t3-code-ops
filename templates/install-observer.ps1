param([Parameter(Mandatory=$true)][string]$OpsRoot,[Parameter(Mandatory=$true)][string]$Config,[string]$Node=(Get-Command node).Source)
$ErrorActionPreference='Stop'
$script=Join-Path $OpsRoot 'scripts/observe.mjs'
if(!(Test-Path -LiteralPath $script) -or !(Test-Path -LiteralPath $Config)){throw 'Observer source or config missing'}
$launcher=Join-Path (Split-Path $Config) 'observer.ps1'
$quote={param($s) "'"+$s.Replace("'","''")+"'"}
$body="`$ErrorActionPreference='Stop'`n& $(& $quote $Node) $(& $quote $script) $(& $quote $Config)`nexit `$LASTEXITCODE`n"
[IO.File]::WriteAllText($launcher,$body,(New-Object Text.UTF8Encoding($false)))
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launcher+'"')
$login=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 't3-maintenance-observer' -Action $action -Trigger @($login,$repeat) -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 't3-maintenance-observer'
