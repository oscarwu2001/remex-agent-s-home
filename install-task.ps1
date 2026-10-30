# Sets up the hourly status post on this computer (run once, in PowerShell):
#   powershell -ExecutionPolicy Bypass -File install-task.ps1
# It runs post-status.js every hour from 9:00 to 19:00, every day, while you
# are logged in, with no window. No Claude, no tokens. Remove it with:
#   Unregister-ScheduledTask -TaskName 'Agents Home status' -Confirm:$false
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$vbs = Join-Path $PSScriptRoot 'post-status.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //NoLogo `"$vbs`" `"$node`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At 09:00
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At 09:00 -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 10 -Minutes 1)).Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'Agents Home status' -Action $action -Trigger $trigger -Settings $settings `
  -Description "Posts this computer's Claude work status to the agents-status branch (Agent's Home)." -Force | Out-Null
& $node (Join-Path $PSScriptRoot 'post-status.js') --force
if ($LASTEXITCODE -ne 0) { Write-Error 'The task is set up, but the first post did not go through.'; exit 1 }
Write-Host 'Done: this computer posts its status every hour, 9:00-19:00.'
