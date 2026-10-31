param(
  [Parameter(Mandatory = $true)]
  [string]$AgentToken,
  [string]$RouterUrl = 'http://192.168.1.1',
  [string]$ApiUrl = 'https://jixels-wifi-connect.vercel.app/api/tyrax-agent/commands'
)

$credential = Get-Credential -UserName 'CMCCAdmin' -Message 'Enter the TYRAX router admin password. It stays on this PC.'
$directory = Join-Path $env:LOCALAPPDATA 'JixelsTyraxAgent'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$config = @{
  routerUrl = $RouterUrl.TrimEnd('/')
  routerUsername = $credential.UserName
  routerPasswordDpapi = ConvertFrom-SecureString $credential.Password
  apiUrl = $ApiUrl
  agentToken = $AgentToken
}
$configPath = Join-Path $directory 'agent.json'
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

$acl = Get-Acl -LiteralPath $directory
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $directory -AclObject $acl
Write-Host "Agent settings saved in $configPath (router password encrypted for this Windows account)."
Write-Host 'Keep this PC powered on and on the router LAN while the agent runs.'
