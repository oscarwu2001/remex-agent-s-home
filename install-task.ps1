# Sets up the hourly status post on this computer (run once, in PowerShell):
#   powershell -ExecutionPolicy Bypass -File install-task.ps1
# It runs post-status.js every hour from 9:00 to 19:00, every day, while you
# are logged in. No Claude, no tokens. Remove it with:
#   schtasks /Delete /TN "Agents Home status" /F
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'post-status.js'
schtasks /Create /F /TN "Agents Home status" /SC HOURLY /ST 09:00 /ET 19:01 /K `
  /TR "`"$node`" `"$script`"" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error 'The task could not be created.'; exit 1 }
& $node $script --force
Write-Host 'Done: this computer posts its status every hour, 9:00-19:00.'
