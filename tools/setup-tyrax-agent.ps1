param(
  [Parameter(Mandatory = $true)]
  [string]$AgentToken,
  [string]$RouterUrl = 'http://192.168.1.1',
  [string]$ApiUrl = 'https://jixels-wifi-connect.vercel.app/api/tyrax-agent/commands'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($AgentToken)) { throw 'AgentToken is required.' }
$credential = Get-Credential -UserName 'CMCCAdmin' -Message 'Enter the TYRAX router admin password. It stays on this PC.'
if (-not $credential -or -not $credential.Password -or $credential.Password.Length -eq 0) { throw 'A non-empty router password is required. Setup was cancelled.' }
$directory = Join-Path $env:LOCALAPPDATA 'JixelsTyraxAgent'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$credentialPath = Join-Path $directory 'router-credential.xml'
$credential | Export-Clixml -LiteralPath $credentialPath -Force
$config = @{ routerUrl = $RouterUrl.TrimEnd('/'); apiUrl = $ApiUrl; agentToken = $AgentToken; credentialPath = $credentialPath }
$configPath = Join-Path $directory 'agent.json'
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
if (-not (Test-Path -LiteralPath $configPath) -or -not (Test-Path -LiteralPath $credentialPath)) { throw 'Agent configuration files were not created.' }
Write-Host "Agent settings saved in $configPath (router password encrypted for this Windows account)."
Write-Host 'Keep this PC powered on and on the router LAN while the agent runs.'
