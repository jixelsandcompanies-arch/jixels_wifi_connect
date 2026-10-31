$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$configPath = Join-Path $env:LOCALAPPDATA 'JixelsTyraxAgent\agent.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Agent not configured. Run setup-tyrax-agent.ps1 first.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$securePassword = ConvertTo-SecureString $config.routerPasswordDpapi
$routerPassword = [System.Net.NetworkCredential]::new('', $securePassword).Password
$routerRoot = "$($config.routerUrl)/cgi-bin/luci/admin/routerweb"
$apiHeaders = @{ Authorization = "Bearer $($config.agentToken)" }
$routerSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Connect-Tyrax {
  $body = @{ username = $config.routerUsername; password = $routerPassword } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Uri "$routerRoot/login" -Method Post -ContentType 'application/json' -Body $body -WebSession $routerSession -TimeoutSec 12
  if ($result.result -ne 0) { throw 'TYRAX router login failed. Check the locally saved password.' }
}

Connect-Tyrax
Write-Host 'Jixels TYRAX agent connected. Press Ctrl+C to stop.'
while ($true) {
  try {
    $feed = Invoke-RestMethod -Uri $config.apiUrl -Method Get -Headers $apiHeaders -TimeoutSec 15
    foreach ($command in $feed.commands) {
      try {
        Connect-Tyrax
        $disabled = if ($command.action -eq 'ALLOW') { 0 } else { 1 }
        $body = @{ mac = $command.mac_address; disabled = $disabled } | ConvertTo-Json -Compress
        $routerResult = Invoke-RestMethod -Uri "$routerRoot/deny_dev" -Method Post -ContentType 'application/json' -Body $body -WebSession $routerSession -TimeoutSec 12
        if ($routerResult.result -ne 0) { throw 'Router rejected the device permission change.' }
        $ack = @{ commandId = $command.id; ok = $true } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $apiHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null
        Write-Host "Applied $($command.action) to $($command.mac_address)."
      } catch {
        $ack = @{ commandId = $command.id; ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
        try { Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $apiHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null } catch { }
        Write-Warning "Command $($command.id) failed and will retry: $($_.Exception.Message)"
      }
    }
  } catch { Write-Warning "Agent poll failed: $($_.Exception.Message)" }
  Start-Sleep -Seconds 8
}
