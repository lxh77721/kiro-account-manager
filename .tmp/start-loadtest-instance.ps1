param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir,
  [int]$WebPort = 3180,
  [int]$ProxyPort = 5680,
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'

if (-not $LogFile) {
  $LogFile = Join-Path $DataDir 'web-proxy.console.log'
}

$env:KIRO_USER_DATA_PATH = $DataDir
$env:KIRO_WEB_HOST = '127.0.0.1'
$env:KIRO_WEB_PORT = [string]$WebPort
$env:KIRO_PROXY_HOST = '127.0.0.1'
$env:KIRO_PROXY_PORT = [string]$ProxyPort

Set-Location 'G:\project\kiro-account-manager'
node out/web-proxy/web-proxy/server.js *> $LogFile
