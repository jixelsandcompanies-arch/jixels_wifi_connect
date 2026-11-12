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
    $hosts = @(Get-RouterItems -Path 'ip/hotspot/host' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','address'))
    $sameMacHosts = @($hosts | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac })
    $clientHost = $sameMacHosts | Where-Object { $_.address -eq $Command.client_ip } | Select-Object -First 1
    if (-not $clientHost -and $sameMacHosts.Count -eq 1) {
      $clientHost = $sameMacHosts[0]
      Write-AgentLog 'WARN' "Client IP changed from $($Command.client_ip) to $($clientHost.address); applying the paid grant to the same MAC."
    }
    $clientIp = if ($clientHost) { [string]$clientHost.address } else { '' }
    if (-not $clientHost) {
      Write-AgentLog 'WARN' 'The MikroTik does not currently list this paid MAC as a HotSpot host; preparing a MAC-only bypass so access applies when it reconnects.'
    }

    $script:CurrentOperation = 'check existing hotspot login for paid device'
    $active = @(Get-RouterItems -Path 'ip/hotspot/active' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','user'))

    $script:CurrentOperation = 'find existing Jixels paid-device binding'
    $bindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','address','type','comment'))
    $bindingComment = "Jixels session $($Command.session_id)"
    $ownedBindings = @($bindings | Where-Object { $_.comment -eq $bindingComment })
    $manualBindings = @($bindings | Where-Object {
      -not ([string]$_.comment).StartsWith('Jixels session ', [StringComparison]::Ordinal) -and
      ((-not $clientIp) -or $_.address -eq $clientIp)
    })
    if ($manualBindings.Count -gt 0) { throw 'A manually managed HotSpot IP binding matches this device. Ask the Wi-Fi administrator to review it.' }

    # Clear any previous authenticated session for this MAC only after
    # confirming there is no conflicting manually managed binding. The paid
    # bypass binding makes browser login unnecessary.
    $script:CurrentOperation = 'clear prior hotspot login for paid device'
    foreach ($client in $active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac }) {
      $encodedId = [Uri]::EscapeDataString([string]$client.'.id')
      Invoke-RouterRest -Path "ip/hotspot/active/$encodedId" -Method Delete | Out-Null
    }

    $binding = $ownedBindings | Select-Object -First 1
    $newBinding = @{ 'mac-address' = $mac; type = 'bypassed'; comment = $bindingComment }
    if ($clientIp) { $newBinding.address = $clientIp }
    if ($binding -and $clientIp) {
      $script:CurrentOperation = 'update paid-device bypass binding'
      $encodedId = [Uri]::EscapeDataString([string]$binding.'.id')
      Invoke-RouterRest -Path "ip/hotspot/ip-binding/$encodedId" -Method Patch -Body $newBinding | Out-Null
      foreach ($duplicate in ($ownedBindings | Select-Object -Skip 1)) {
        $encodedId = [Uri]::EscapeDataString([string]$duplicate.'.id')
        Invoke-RouterRest -Path "ip/hotspot/ip-binding/$encodedId" -Method Delete | Out-Null
      }
    } else {
      # Recreate a stale address-specific entry as MAC-only when the client is
      # offline. RouterOS supports MAC-only static HotSpot bindings, so the
      # paid authorization is ready for the device's next connection.
      foreach ($ownedBinding in $ownedBindings) {
        $encodedId = [Uri]::EscapeDataString([string]$ownedBinding.'.id')
        Invoke-RouterRest -Path "ip/hotspot/ip-binding/$encodedId" -Method Delete | Out-Null
      }
      $script:CurrentOperation = 'create paid-device bypass binding'
      Invoke-RouterRest -Path 'ip/hotspot/ip-binding' -Method Put -Body $newBinding | Out-Null
    }

    # Do not acknowledge the paid grant until RouterOS returns the persisted
    # binding with the expected MAC, current IP, session comment, and bypass type.
    $script:CurrentOperation = 'verify paid-device bypass binding'
    $verifiedBindings = @(Get-RouterItems -Path 'ip/hotspot/ip-binding' -Filters @{ 'mac-address' = $mac } -Properties @('.id','mac-address','address','type','comment'))
    $verifiedBinding = $verifiedBindings | Where-Object {
      (Normalize-Mac $_.'mac-address') -eq $mac -and
      ((-not $clientIp) -or $_.address -eq $clientIp) -and
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
