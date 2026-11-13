$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$configPath = Join-Path $env:LOCALAPPDATA 'JixelsMikrotikAgent\agent.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Agent not configured. Run setup-mikrotik-agent.ps1 first.' }
$agentDirectory = Split-Path -Parent $configPath
$logPath = Join-Path $agentDirectory 'agent.log'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$credential = Import-Clixml -LiteralPath $config.credentialPath
if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'Saved RouterOS credential is invalid. Rerun setup-mikrotik-agent.ps1.' }
$routerRoot = "$($config.routerUrl)/rest"
$agentHeaders = @{ Authorization = "Bearer $($config.agentToken)" }
$routerPassword = $credential.GetNetworkCredential().Password
$routerBasic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($credential.UserName):$routerPassword"))
$routerHeaders = @{ Authorization = "Basic $routerBasic" }

function Write-AgentLog {
  param([string]$Level, [string]$Message)
  $safeMessage = $Message -replace '\b(?:Bearer|Basic)\s+\S+', '[redacted]'
  $line = "$(Get-Date -Format o) [$Level] $safeMessage"
  try {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
      $recentLines = @(Get-Content -LiteralPath $logPath -Tail 500)
      Set-Content -LiteralPath $logPath -Value $recentLines -Encoding UTF8
    }
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch { }
  if ($Level -eq 'WARN' -or $Level -eq 'ERROR') { Write-Warning $line } else { Write-Host $line }
}

$agentMutex = [System.Threading.Mutex]::new($false, 'Local\JixelsMikrotikAgent')
$ownsAgentMutex = $false
try { $ownsAgentMutex = $agentMutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $ownsAgentMutex = $true }
if (-not $ownsAgentMutex) { exit 0 }

function Invoke-RouterRest {
  param([string]$Path, [string]$Method = 'Get', $Body = $null)
  $params = @{ Uri = "$routerRoot/$Path"; Method = $Method; Headers = $routerHeaders; TimeoutSec = 12 }
  if ($null -ne $Body) { $params.ContentType = 'application/json'; $params.Body = ($Body | ConvertTo-Json -Compress -Depth 6) }
  try {
    Invoke-RestMethod @params
  } catch {
    $detail = [string]$_.ErrorDetails.Message
    $response = $_.Exception.Response
    if (-not $detail -and $response) {
      try {
        $stream = $response.GetResponseStream()
        if ($stream) {
          $reader = [System.IO.StreamReader]::new($stream)
          try { $detail = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
      } catch { }
    }
    if ($detail) {
      $statusCode = 0
      try { $statusCode = [int]$response.StatusCode } catch { }
      throw "RouterOS REST $Method $Path failed (HTTP $statusCode): $detail"
    }
    throw
  }
}

function Normalize-Mac([string]$Mac) { $Mac.Trim().ToLowerInvariant() }
function Get-RouterItems {
  param([string]$Path, [hashtable]$Filters, [string[]]$Properties)
  # Use RouterOS's print command with a .query and .proplist body so the
  # router returns only the matching device rows, never the full HotSpot menu.
  $query = @($Filters.Keys | ForEach-Object { "${_}=$($Filters[$_])" })
  $properties = @('.id') + @($Properties | Where-Object { $_ -ne '.id' })
  $body = @{ '.query' = $query; '.proplist' = $properties }
  return @(Invoke-RouterRest -Path "$Path/print" -Method Post -Body $body)
}

function Apply-Command($Command) {
  $mac = Normalize-Mac $Command.mac_address

  if ($Command.action -eq 'ALLOW') {
    # The captive portal context binds this paid command to the device MAC.
    # Avoid reading the entire HotSpot host/active tables: those REST calls
    # can time out and prevent a paid grant from being applied. A MAC-only
    # bypass also remains valid if the device reconnects with a new IP.
    $script:CurrentOperation = 'find existing Jixels paid-device binding'
    $bindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','address','type','comment'))
    $bindingComment = "Jixels session $($Command.session_id)"
    $ownedBindings = @($bindings | Where-Object { $_.comment -eq $bindingComment })
    $manualBindings = @($bindings | Where-Object {
      -not ([string]$_.comment).StartsWith('Jixels session ', [StringComparison]::Ordinal) -and
      (Normalize-Mac $_.'mac-address') -eq $mac
    })
    if ($manualBindings.Count -gt 0) { throw 'A manually managed HotSpot IP binding matches this device. Ask the Wi-Fi administrator to review it.' }

    $newBinding = @{ 'mac-address' = $mac; type = 'bypassed'; comment = $bindingComment }
    # Keep the bypass tied to the paid MAC even when its IP changes. Delete
    # any stale session entry first so no old address restriction survives.
    foreach ($ownedBinding in $ownedBindings) {
      $encodedId = [Uri]::EscapeDataString([string]$ownedBinding.'.id')
      Invoke-RouterRest -Path "ip/hotspot/ip-binding/$encodedId" -Method Delete | Out-Null
    }
    $script:CurrentOperation = 'create paid-device bypass binding'
    Invoke-RouterRest -Path 'ip/hotspot/ip-binding' -Method Put -Body $newBinding | Out-Null

    # Do not acknowledge until RouterOS returns the persisted MAC-only
    # binding with the expected session comment and bypass type.
    $script:CurrentOperation = 'verify paid-device bypass binding'
    $verifiedBindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','address','type','comment'))
    $verifiedBinding = $verifiedBindings | Where-Object {
      (Normalize-Mac $_.'mac-address') -eq $mac -and
      $_.type -eq 'bypassed' -and
      $_.comment -eq $bindingComment
    } | Select-Object -First 1
    if (-not $verifiedBinding) { throw 'RouterOS did not confirm the paid-device bypass binding. The grant remains queued for retry.' }
  } elseif ($Command.action -eq 'BLOCK') {
    $script:CurrentOperation = 'find paid-device bypass binding to remove'
    $bindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','address','type','comment'))
    $bindingComment = "Jixels session $($Command.session_id)"
    foreach ($binding in ($bindings | Where-Object { $_.comment -eq $bindingComment })) {
      $script:CurrentOperation = 'remove expired paid-device bypass binding'
      $encodedId = [Uri]::EscapeDataString([string]$binding.'.id')
      Invoke-RouterRest -Path "ip/hotspot/ip-binding/$encodedId" -Method Delete | Out-Null
    }

    # Also clean up entries created by the previous credential-based agent.
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

Write-AgentLog 'INFO' 'Jixels MikroTik agent started.'
while ($true) {
  try {
    $feed = Invoke-RestMethod -Uri $config.apiUrl -Method Get -Headers $agentHeaders -TimeoutSec 15
    foreach ($command in $feed.commands) {
      try {
        $script:CurrentOperation = 'apply router command'
        Apply-Command $command
        $ack = @{ commandId = $command.id; ok = $true } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null
        Write-AgentLog 'INFO' "Applied $($command.action) command $($command.id)."
      } catch {
        $failure = "$script:CurrentOperation failed: $($_.Exception.Message)"
        $ack = @{ commandId = $command.id; ok = $false; message = $failure } | ConvertTo-Json -Compress
        try { Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null } catch { }
        Write-AgentLog 'ERROR' "Command $($command.id) failed during '$script:CurrentOperation' and will retry: $($_.Exception.Message)"
      }
    }
  } catch {
    $statusCode = 0
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { }
    if ($statusCode -eq 401) {
      Write-AgentLog 'ERROR' 'Vercel rejected this agent before any RouterOS command ran. Check WIFI_GATEWAY_MODE, MIKROTIK_GATEWAY_ID, and MIKROTIK_AGENT_TOKEN.'
      exit 1
    }
    Write-AgentLog 'WARN' "MikroTik agent poll failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 3
}
