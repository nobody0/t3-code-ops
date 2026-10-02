param([Parameter(Mandatory=$true)][string]$ProfileDir,[Parameter(Mandatory=$true)][string]$KoRoot,[Parameter(Mandatory=$true)][string]$Firefox,[Parameter(Mandatory=$true)][string]$Bun)
$ErrorActionPreference='Stop'
$url='http://localhost:4321/e/t3-maintenance'
$cache=Join-Path $KoRoot '.cache/t3-maintenance'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$userJs=Join-Path $ProfileDir 'user.js'
$existing=if(Test-Path -LiteralPath $userJs){[IO.File]::ReadAllText($userJs)}else{''}
if(Test-Path -LiteralPath $userJs){Copy-Item -LiteralPath $userJs -Destination (Join-Path $cache ('firefox-user-'+(Get-Date -Format yyyyMMddHHmmss)+'.js'))}
$prefs=[IO.File]::ReadAllText((Join-Path $ProfileDir 'prefs.js'))
$match=[regex]::Match($prefs,'user_pref\("browser.startup.homepage",\s*("(?:[^"\\]|\\.)*")\);')
$homepage=if($match.Success){$match.Groups[1].Value|ConvertFrom-Json}else{'about:home'}
$pages=@($homepage.Split('|')|Where-Object {$_ -and $_ -ne $url})+@($url)
$setting='user_pref("browser.startup.homepage", '+(($pages -join '|')|ConvertTo-Json -Compress)+');'
$existing=[regex]::Replace($existing,'(?s)\n?// BEGIN T3 maintenance homepage.*?// END T3 maintenance homepage\n?','')
[IO.File]::WriteAllText($userJs,($existing.TrimEnd()+"`n// BEGIN T3 maintenance homepage`n"+$setting+"`n// END T3 maintenance homepage`n").Replace("`r`n","`n"),(New-Object Text.UTF8Encoding($false)))
$quote={param($s) "'"+$s.Replace("'","''")+"'"}
$launch=Join-Path $cache 'open-reminder.ps1'
$body=@"
`$ErrorActionPreference='Stop'
`$ready=`$false
try { `$ready=(Invoke-RestMethod 'http://localhost:4321/api/health' -TimeoutSec 3).ok } catch {}
if(-not `$ready){
  Start-Process -FilePath $(& $quote $Bun) -ArgumentList 'dev' -WorkingDirectory $(& $quote $KoRoot) -WindowStyle Hidden
  for(`$attempt=0;`$attempt -lt 15;`$attempt++){try {Invoke-RestMethod 'http://localhost:4321/api/health' -TimeoutSec 2|Out-Null;break}catch {Start-Sleep -Seconds 2}}
}
Start-Process -FilePath $(& $quote $Firefox) -ArgumentList @('-new-tab',$(& $quote $url)) -WindowStyle Normal
"@
[IO.File]::WriteAllText($launch,$body.Replace("`r`n","`n"),(New-Object Text.UTF8Encoding($false)))
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launch+'"')
$who=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $who
$settings=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 't3-maintenance-startpage' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output 'Homepage configured; reminder tab will open at the next login. Session restore is unchanged.'
