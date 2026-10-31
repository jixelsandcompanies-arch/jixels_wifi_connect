$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$configPath = Join-Path $env:LOCALAPPDATA 'JixelsMikrotikAgent\agent.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Agent not configured. Run setup-mikrotik-agent.ps1 first.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$credential = Import-Clixml -LiteralPath $config.credentialPath
if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'Saved RouterOS credential is invalid. Rerun setup-mikrotik-agent.ps1.' }
$routerRoot = "$($config.routerUrl)/rest"
$agentHeaders = @{ Authorization = "Bearer $($config.agentToken)" }
$routerPassword = $credential.GetNetworkCredential().Password
$routerBasic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($credential.UserName):$routerPassword"))
$routerHeaders = @{ Authorization = "Basic $routerBasic" }

function Invoke-RouterRest {
  param([string]$Path, [string]$Method = 'Get', $Body = $null)
  $params = @{ Uri = "$routerRoot/$Path"; Method = $Method; Headers = $routerHeaders; TimeoutSec = 12 }
  if ($null -ne $Body) { $params.ContentType = 'application/json'; $params.Body = ($Body | ConvertTo-Json -Compress -Depth 6) }
  Invoke-RestMethod @params
}

function Normalize-Mac([string]$Mac) { $Mac.Trim().ToLowerInvariant() }
function Apply-Command($Command) {
  $mac = Normalize-Mac $Command.mac_address
  $users = @(Invoke-RouterRest -Path 'ip/hotspot/user')
  $user = $users | Where-Object { $_.name -eq $Command.hotspot_username } | Select-Object -First 1

  if ($Command.action -eq 'ALLOW') {
    $hosts = @(Invoke-RouterRest -Path 'ip/hotspot/host')
    $host = $hosts | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac -and $_.address -eq $Command.client_ip } | Select-Object -First 1
    if (-not $host) { throw 'The MikroTik no longer sees this client IP and MAC together. The command was not applied.' }

    $active = @(Invoke-RouterRest -Path 'ip/hotspot/active')
    $alreadyActive = $active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac -and $_.user -eq $Command.hotspot_username } | Select-Object -First 1
    if ($alreadyActive) { return }

    $newUser = @{
      name = $Command.hotspot_username
      password = $Command.hotspot_password
      'mac-address' = $mac
      'limit-uptime' = "$($Command.duration_minutes)m"
      comment = "Jixels session $($Command.session_id)"
    }
    if ($user) {
      $encodedId = [Uri]::EscapeDataString([string]$user.'.id')
      Invoke-RouterRest -Path "ip/hotspot/user/$encodedId" -Method Patch -Body $newUser | Out-Null
    } else {
      Invoke-RouterRest -Path 'ip/hotspot/user' -Method Put -Body $newUser | Out-Null
    }
  } elseif ($Command.action -eq 'BLOCK') {
    $active = @(Invoke-RouterRest -Path 'ip/hotspot/active')
    foreach ($client in ($active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac })) {
      $encodedId = [Uri]::EscapeDataString([string]$client.'.id')
      Invoke-RouterRest -Path "ip/hotspot/active/$encodedId" -Method Delete | Out-Null
    }
    if ($user) {
      $encodedId = [Uri]::EscapeDataString([string]$user.'.id')
      Invoke-RouterRest -Path "ip/hotspot/user/$encodedId" -Method Delete | Out-Null
    }
  } else { throw "Unsupported router action: $($Command.action)" }
}

Write-Host 'Jixels MikroTik agent connected. Press Ctrl+C to stop.'
while ($true) {
  try {
    $feed = Invoke-RestMethod -Uri $config.apiUrl -Method Get -Headers $agentHeaders -TimeoutSec 15
    foreach ($command in $feed.commands) {
      try {
        Apply-Command $command
        $ack = @{ commandId = $command.id; ok = $true } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null
        Write-Host "Applied $($command.action) for $($command.mac_address)."
      } catch {
        $ack = @{ commandId = $command.id; ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
        try { Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null } catch { }
        Write-Warning "Command $($command.id) failed and will retry: $($_.Exception.Message)"
      }
    }
  } catch { Write-Warning "MikroTik agent poll failed: $($_.Exception.Message)" }
  Start-Sleep -Seconds 8
}
