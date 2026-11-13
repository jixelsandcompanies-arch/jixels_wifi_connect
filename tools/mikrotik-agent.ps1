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
function Get-RouterItemPathId([string]$Id) {
  # RouterOS REST item IDs begin with '*'. RouterOS requires the asterisk to
  # stay literal in the path and does not decode its %2A escape sequence.
  return ([Uri]::EscapeDataString($Id)).Replace('%2A', '*').Replace('%2a', '*')
}
function Get-RouterItems {
  param([string]$Path, [hashtable]$Filters, [string[]]$Properties)
  # Use RouterOS's print command with a .query and .proplist body so the
  # router returns only the matching device rows, never the full HotSpot menu.
  $query = @(
    foreach ($key in $Filters.Keys) {
      if ($key -eq 'mac-address') {
        $macValue = Normalize-Mac ([string]$Filters[$key])
        "mac-address=$macValue"
        "mac-address=$($macValue.ToUpperInvariant())"
        '#|'
      } else {
        "${key}=$($Filters[$key])"
      }
    }
  )
  $properties = @('.id') + @($Properties | Where-Object { $_ -ne '.id' })
  $body = @{ '.query' = $query; '.proplist' = $properties }
  return @(Invoke-RouterRest -Path "$Path/print" -Method Post -Body $body)
}

function Apply-Command($Command) {
  $mac = Normalize-Mac $Command.mac_address

  if ($Command.action -eq 'ALLOW') {
    # The captive portal context binds this paid command to the device MAC.
    # RouterOS allows only one IP binding per client, so reuse a Jixels-owned
    # binding for renewals/retries instead of trying to add a duplicate.
    $bindingComment = "Jixels session $($Command.session_id)"
    $newBinding = @{ 'mac-address' = $mac; type = 'bypassed'; comment = $bindingComment }
    $script:CurrentOperation = 'find existing paid-device binding'
    $bindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','address','type','comment'))
    $matchingBindings = @($bindings | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac })
    $ownedBindings = @($matchingBindings | Where-Object { ([string]$_.comment).StartsWith('Jixels session ', [StringComparison]::Ordinal) })
    $manualBindings = @($matchingBindings | Where-Object { -not ([string]$_.comment).StartsWith('Jixels session ', [StringComparison]::Ordinal) })
    if ($manualBindings.Count -gt 0) { throw 'A manually managed HotSpot binding already exists for this device. It was left unchanged; ask the Wi-Fi administrator to review it.' }

    if ($ownedBindings.Count -gt 0) {
      $targetBinding = $ownedBindings[0]
      $encodedId = Get-RouterItemPathId ([string]$targetBinding.'.id')
      $script:CurrentOperation = 'update existing paid-device bypass binding'
      Invoke-RouterRest -Path "ip/hotspot/ip-binding/$encodedId" -Method Patch -Body $newBinding | Out-Null
      foreach ($duplicate in @($ownedBindings | Select-Object -Skip 1)) {
        $script:CurrentOperation = 'remove duplicate paid-device bypass binding'
        $duplicateId = Get-RouterItemPathId ([string]$duplicate.'.id')
        Invoke-RouterRest -Path "ip/hotspot/ip-binding/$duplicateId" -Method Delete | Out-Null
      }
    } else {
      $script:CurrentOperation = 'create paid-device bypass binding'
      try {
        Invoke-RouterRest -Path 'ip/hotspot/ip-binding' -Method Put -Body $newBinding | Out-Null
      } catch {
        if ($_.Exception.Message -notmatch '(?i)such client already exists') { throw }

        # RouterOS can reject PUT because the client exists even when its
        # filtered print did not return it (for example, after a casing or
        # concurrent-command race). Re-read the small binding table and
        # reconcile the Jixels-owned row instead of retrying the same PUT.
        $script:CurrentOperation = 'recover existing client after duplicate binding response'
        $allBindings = @(Invoke-RouterRest -Path 'ip/hotspot/ip-binding' -Method Get)
        $matchingBindings = @($allBindings | Where-Object { (Normalize-Mac ([string]$_.'mac-address')) -eq $mac })
        $ownedBindings = @($matchingBindings | Where-Object { ([string]$_.comment).StartsWith('Jixels session ', [StringComparison]::Ordinal) })
        $manualBindings = @($matchingBindings | Where-Object { -not ([string]$_.comment).StartsWith('Jixels session ', [StringComparison]::Ordinal) })
        if ($manualBindings.Count -gt 0) { throw 'RouterOS has a manually managed binding for this device. It was left unchanged; ask the Wi-Fi administrator to review it.' }
        if ($ownedBindings.Count -eq 0) { throw 'RouterOS reported that this client already exists, but its binding could not be identified. The grant remains pending for retry.' }

        $targetBinding = $ownedBindings[0]
        $targetId = Get-RouterItemPathId ([string]$targetBinding.'.id')
        $script:CurrentOperation = 'update existing paid-device binding after duplicate response'
        Invoke-RouterRest -Path "ip/hotspot/ip-binding/$targetId" -Method Patch -Body $newBinding | Out-Null
        foreach ($duplicate in @($ownedBindings | Select-Object -Skip 1)) {
          $duplicateId = Get-RouterItemPathId ([string]$duplicate.'.id')
          $script:CurrentOperation = 'remove duplicate paid-device bypass binding'
          Invoke-RouterRest -Path "ip/hotspot/ip-binding/$duplicateId" -Method Delete | Out-Null
        }
      }
    }
  } elseif ($Command.action -eq 'BLOCK') {
    $bindingComment = "Jixels session $($Command.session_id)"
    # Find the client's small binding set by MAC, then match this session's
    # comment locally. This avoids relying on a comment query for revocation.
    $script:CurrentOperation = 'find paid-device bypass binding to remove'
    $bindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','address','type','comment'))
    $sessionBindings = @($bindings | Where-Object { $_.comment -eq $bindingComment -and (Normalize-Mac $_.'mac-address') -eq $mac })
    foreach ($binding in $sessionBindings) {
      # Remove only this session's bypass rule. This returns the device to
      # normal HotSpot authentication so its next request reaches the billing
      # portal. The HotSpot host table itself is read-only and must not be
      # deleted from.
      $script:CurrentOperation = 'remove expired paid-device bypass binding'
      $encodedId = Get-RouterItemPathId ([string]$binding.'.id')
      Invoke-RouterRest -Path "ip/hotspot/ip-binding/$encodedId" -Method Delete | Out-Null
    }
    $script:CurrentOperation = 'verify expired paid-device bypass was removed'
    $remainingBindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','comment'))
    $stillAuthorized = @($remainingBindings | Where-Object { $_.comment -eq $bindingComment -and (Normalize-Mac $_.'mac-address') -eq $mac })
    if ($stillAuthorized.Count -gt 0) { throw 'RouterOS still reports the expired Jixels bypass binding; expiry remains pending.' }

    # Also clean up entries created by the previous credential-based agent.
    $script:CurrentOperation = 'find active paid hotspot login to remove'
    $active = @(Get-RouterItems -Path 'ip/hotspot/active' -Filters @{ 'mac-address' = $mac; user = $Command.hotspot_username } -Properties @('.id','mac-address','user'))
    foreach ($client in ($active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac -and $_.user -eq $Command.hotspot_username })) {
      $script:CurrentOperation = 'remove expired hotspot login'
      $encodedId = Get-RouterItemPathId ([string]$client.'.id')
      Invoke-RouterRest -Path "ip/hotspot/active/$encodedId" -Method Delete | Out-Null
    }
    $script:CurrentOperation = 'find expired temporary hotspot user'
    $users = @(Get-RouterItems -Path 'ip/hotspot/user' -Filters @{ name = $Command.hotspot_username } -Properties @('.id','name'))
    $user = $users | Where-Object { $_.name -eq $Command.hotspot_username } | Select-Object -First 1
    if ($user) {
      $script:CurrentOperation = 'remove expired temporary hotspot user'
      $encodedId = Get-RouterItemPathId ([string]$user.'.id')
      Invoke-RouterRest -Path "ip/hotspot/user/$encodedId" -Method Delete | Out-Null
    }
  } else { throw "Unsupported router action: $($Command.action)" }
}

Write-AgentLog 'INFO' 'Jixels MikroTik agent started.'
try {
  # Older builds briefly marked expired Jixels rules as blocked, which also
  # stopped customers from reaching the captive billing page. Remove only
  # those Jixels-owned blocked rules during upgrade; leave manual router rules
  # untouched so clients return to normal HotSpot login.
  $script:CurrentOperation = 'find stale Jixels blocked bindings'
  $staleBlockedBindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ type = 'blocked' } -Properties @('.id','type','comment'))
  foreach ($binding in ($staleBlockedBindings | Where-Object { $_.type -eq 'blocked' -and ([string]$_.comment).StartsWith('Jixels session ', [StringComparison]::Ordinal) })) {
    try {
      $script:CurrentOperation = 'remove stale Jixels blocked binding'
      $encodedId = Get-RouterItemPathId ([string]$binding.'.id')
      Invoke-RouterRest -Path "ip/hotspot/ip-binding/$encodedId" -Method Delete | Out-Null
      Write-AgentLog 'WARN' "Removed a stale Jixels blocked binding $($binding.'.id'); the device can return to the billing portal."
    } catch {
      Write-AgentLog 'ERROR' "Could not remove stale Jixels blocked binding $($binding.'.id'): $($_.Exception.Message)"
    }
  }
} catch {
  Write-AgentLog 'ERROR' "Startup cleanup for stale Jixels blocked bindings failed: $($_.Exception.Message)"
}
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
