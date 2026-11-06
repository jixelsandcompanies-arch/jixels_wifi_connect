$ErrorActionPreference = 'Stop'

$configPath = Join-Path $env:LOCALAPPDATA 'JixelsMikrotikAgent\agent.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw 'Agent is not configured. Run setup-mikrotik-agent.ps1 first.'
}

$agentScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'mikrotik-agent.ps1')).Path
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskName = 'Jixels MikroTik Agent'
$powershell = Join-Path $PSHOME 'powershell.exe'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$agentScript`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Runs the Jixels MikroTik agent in the signed-in user session and restarts it after failures.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started '$taskName' for $currentUser. It starts hidden at sign-in and retries after failures."
Write-Host 'Keep this PC powered on, signed in, and connected to the MikroTik LAN.'
