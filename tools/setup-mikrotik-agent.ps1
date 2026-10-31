param(
  [Parameter(Mandatory = $true)] [string]$AgentToken,
  [Parameter(Mandatory = $true)] [string]$RouterUrl,
  [string]$ApiUrl = 'https://jixels-wifi-connect.vercel.app/api/mikrotik-agent/commands'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($AgentToken)) { throw 'AgentToken is required.' }
if ($RouterUrl -notmatch '^https?://') { throw 'RouterUrl must start with http:// or https://.' }
$credential = Get-Credential -Message 'Enter the dedicated MikroTik RouterOS REST account. It stays on this PC.'
if (-not $credential -or -not $credential.Password -or $credential.Password.Length -eq 0) { throw 'A non-empty RouterOS password is required.' }

$directory = Join-Path $env:LOCALAPPDATA 'JixelsMikrotikAgent'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$credentialPath = Join-Path $directory 'router-credential.xml'
$credential | Export-Clixml -LiteralPath $credentialPath -Force
$configPath = Join-Path $directory 'agent.json'
@{ routerUrl = $RouterUrl.TrimEnd('/'); apiUrl = $ApiUrl; agentToken = $AgentToken; credentialPath = $credentialPath } |
  ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
if (-not (Test-Path -LiteralPath $configPath) -or -not (Test-Path -LiteralPath $credentialPath)) { throw 'Agent configuration was not saved.' }
Write-Host "Settings saved under $directory. Router credentials are encrypted for this Windows account."
Write-Host 'Keep this PC powered on and connected to the MikroTik LAN while the local agent runs.'
