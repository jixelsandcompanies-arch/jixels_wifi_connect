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
function Get-RouterItems {
  param([string]$Path, [hashtable]$Filters, [string[]]$Properties)
  $query = @(
    foreach ($key in $Filters.Keys) {
      "$key=$([Uri]::EscapeDataString([string]$Filters[$key]))"
    }
    ".proplist=$($Properties -join ',')"
  )
  Invoke-RouterRest -Path "$Path?$($query -join '&')"
}

function Apply-Command($Command) {
  $mac = Normalize-Mac $Command.mac_address

  if ($Command.action -eq 'ALLOW') {
    $script:CurrentOperation = 'verify paid device on hotspot'
    $hosts = @(Get-RouterItems -Path 'ip/hotspot/host' -Filters @{ 'mac-address' = $mac; address = $Command.client_ip } -Properties @('.id','mac-address','address'))
    $host = $hosts | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac -and $_.address -eq $Command.client_ip } | Select-Object -First 1
    if (-not $host) { throw 'The MikroTik no longer sees this client IP and MAC together. The command was not applied.' }

    $script:CurrentOperation = 'check existing hotspot login for paid device'
    $active = @(Get-RouterItems -Path 'ip/hotspot/active' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','user'))
    $alreadyActive = $active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac -and $_.user -eq $Command.hotspot_username } | Select-Object -First 1
    if ($alreadyActive) { return }

    # A previous login for this same device can prevent the browser's new
    # paid credentials from taking effect. Disconnect only this MAC after
    # the payment has completed and the live HotSpot host check has passed.
    $script:CurrentOperation = 'clear prior hotspot login for paid device'
    foreach ($client in $active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac }) {
      $encodedId = [Uri]::EscapeDataString([string]$client.'.id')
      Invoke-RouterRest -Path "ip/hotspot/active/$encodedId" -Method Delete | Out-Null
    }

    $script:CurrentOperation = 'find temporary paid hotspot user'
    $users = @(Get-RouterItems -Path 'ip/hotspot/user' -Filters @{ name = $Command.hotspot_username } -Properties @('.id','name'))
    $user = $users | Where-Object { $_.name -eq $Command.hotspot_username } | Select-Object -First 1

    $newUser = @{
      name = $Command.hotspot_username
      password = $Command.hotspot_password
      'mac-address' = $mac
      'limit-uptime' = "$($Command.duration_minutes)m"
      comment = "Jixels session $($Command.session_id)"
    }
    if ($user) {
      $script:CurrentOperation = 'update temporary paid hotspot user'
      $encodedId = [Uri]::EscapeDataString([string]$user.'.id')
      Invoke-RouterRest -Path "ip/hotspot/user/$encodedId" -Method Patch -Body $newUser | Out-Null
    } else {
      $script:CurrentOperation = 'create temporary paid hotspot user'
      Invoke-RouterRest -Path 'ip/hotspot/user' -Method Put -Body $newUser | Out-Null
    }
  } elseif ($Command.action -eq 'BLOCK') {
    $script:CurrentOperation = 'find active paid hotspot login to remove'
    $active = @(Get-RouterItems -Path 'ip/hotspot/active' -Filters @{ 'mac-address' = $mac; user = $Command.hotspot_username } -Properties @('.id','mac-address','user'))
    foreach ($client in ($active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac -and $_.user -eq $Command.hotspot_username })) {
      $script:CurrentOperation = 'remove expired hotspot login'
      $encodedId = [Uri]::EscapeDataString([string]$client.'.id')
      Invoke-RouterRest -Path "ip/hotspot/active/$encodedId" -Method Delete | Out-Null
    }
    $script:CurrentOperation = 'find expired temporary hotspot user'
    $users = @(Get-RouterItems -Path 'ip/hotspot/user' -Filters @{ name = $Command.hotspot_username } -Properties @('.id','name'))
    $user = $users | Where-Object { $_.name -eq $Command.hotspot_username } | Select-Object -First 1
    if ($user) {
      $script:CurrentOperation = 'remove expired temporary hotspot user'
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
        $script:CurrentOperation = 'apply router command'
        Apply-Command $command
        $ack = @{ commandId = $command.id; ok = $true } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null
        Write-Host "Applied $($command.action) for $($command.mac_address)."
      } catch {
        $failure = "$script:CurrentOperation failed: $($_.Exception.Message)"
        $ack = @{ commandId = $command.id; ok = $false; message = $failure } | ConvertTo-Json -Compress
        try { Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null } catch { }
        Write-Warning "Command $($command.id) failed during '$script:CurrentOperation' and will retry: $($_.Exception.Message)"
      }
    }
  } catch {
    $statusCode = 0
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { }
    if ($statusCode -eq 401) {
      Write-Warning 'Vercel rejected this agent before any RouterOS command ran. Check that Production has WIFI_GATEWAY_MODE=mikrotik-agent, MIKROTIK_AGENT_TOKEN exactly matches this PC, MIKROTIK_CREDENTIAL_SECRET is set, and MIKROTIK_HOTSPOT_LOGIN_URL is a private router login URL. Restart the agent after correcting Vercel settings.'
      break
    }
    Write-Warning "MikroTik agent poll failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 8
}
