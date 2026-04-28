param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir,
  [int]$WebPort = 3190,
  [int]$ProxyPort = 5690
)

$ErrorActionPreference = 'Stop'

$workspace = 'G:\project\kiro-account-manager'
$launcher = Join-Path $workspace '.tmp\start-loadtest-instance.cmd'
$driver = Join-Path $workspace '.tmp\loadtest-driver.mjs'
$logFile = Join-Path $DataDir ("web-proxy-$ProxyPort.console.log")

function Wait-Url {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [int]$TimeoutSec = 45
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    try {
      return Invoke-RestMethod -Uri $Url -TimeoutSec 5
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for $Url"
}

function Invoke-ApiJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [ValidateSet('GET', 'POST')]
    [string]$Method = 'GET',
    [object]$Body = $null,
    [int]$TimeoutSec = 120
  )

  if ($Method -eq 'GET') {
    return Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec
  }

  $payload = if ($null -eq $Body) { '{}' } else { $Body | ConvertTo-Json -Depth 20 -Compress }
  return Invoke-RestMethod -Uri $Url -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec $TimeoutSec
}

function Get-ProxyStatus {
  $response = Invoke-ApiJson -Url "http://127.0.0.1:$WebPort/api/renderer/call" -Method POST -Body @{
    method = 'proxyGetStatus'
    params = @{}
  }
  return $response.result
}

function Get-Health {
  return Invoke-ApiJson -Url "http://127.0.0.1:$ProxyPort/health"
}

function Update-ProxyConfig {
  param([hashtable]$Config)
  return Invoke-ApiJson -Url "http://127.0.0.1:$WebPort/api/proxy/config" -Method POST -Body @{ config = $Config }
}

function Run-Driver {
  param(
    [int]$Concurrency,
    [int]$Requests,
    [int]$TimeoutMs = 90000,
    [int]$PayloadSize = 0
  )

  $args = @(
    $driver,
    '--url',
    "http://127.0.0.1:$ProxyPort/v1/messages",
    '--concurrency',
    [string]$Concurrency,
    '--requests',
    [string]$Requests,
    '--timeout',
    [string]$TimeoutMs
  )

  if ($PayloadSize -gt 0) {
    $args += @('--payloadSize', [string]$PayloadSize)
  }

  $output = & node @args
  if ($LASTEXITCODE -ne 0) {
    throw "loadtest-driver failed with exit code $LASTEXITCODE"
  }

  return $output | ConvertFrom-Json
}

function Summarize-Health {
  param([object]$Health)
  return [PSCustomObject]@{
    accounts = $Health.accounts
    availableAccounts = $Health.availableAccounts
    rateLimitedAccounts = $Health.rateLimitedAccounts
    activeRequests = $Health.activeRequests
    queuedRequests = $Health.queuedRequests
    totalRequests = $Health.stats.totalRequests
    successRequests = $Health.stats.successRequests
    failedRequests = $Health.stats.failedRequests
    totalTokens = $Health.stats.totalTokens
    uptimeMs = $Health.stats.uptime
  }
}

function Summarize-Status {
  param([object]$Status)
  return [PSCustomObject]@{
    running = $Status.running
    config = [PSCustomObject]@{
      host = $Status.config.host
      port = $Status.config.port
      maxConcurrent = $Status.config.maxConcurrent
      maxQueueSize = $Status.config.maxQueueSize
      requestTimeoutMs = $Status.config.requestTimeoutMs
      maxInFlightPerAccount = $Status.config.maxInFlightPerAccount
      maxRetries = $Status.config.maxRetries
      retryDelayMs = $Status.config.retryDelayMs
    }
    sessionStats = [PSCustomObject]@{
      totalRequests = $Status.sessionStats.totalRequests
      successRequests = $Status.sessionStats.successRequests
      failedRequests = $Status.sessionStats.failedRequests
    }
    stats = [PSCustomObject]@{
      totalRequests = $Status.stats.totalRequests
      successRequests = $Status.stats.successRequests
      failedRequests = $Status.stats.failedRequests
      totalTokens = $Status.stats.totalTokens
      inputTokens = $Status.stats.inputTokens
      outputTokens = $Status.stats.outputTokens
    }
  }
}

function Summarize-Tier {
  param(
    [string]$Name,
    [int]$Concurrency,
    [int]$Requests,
    [object]$Result,
    [object]$Health
  )

  return [PSCustomObject]@{
    name = $Name
    concurrency = $Concurrency
    requests = $Requests
    success = $Result.success
    failures = $Result.failures
    throughputRps = [math]::Round([double]$Result.throughputRps, 2)
    elapsedMs = [math]::Round([double]$Result.elapsedMs, 2)
    statusBreakdown = $Result.statusBreakdown
    latencyMs = [PSCustomObject]@{
      min = [math]::Round([double]$Result.latencyMs.min, 2)
      p50 = [math]::Round([double]$Result.latencyMs.p50, 2)
      p90 = [math]::Round([double]$Result.latencyMs.p90, 2)
      p95 = [math]::Round([double]$Result.latencyMs.p95, 2)
      max = [math]::Round([double]$Result.latencyMs.max, 2)
      avg = [math]::Round([double]$Result.latencyMs.avg, 2)
    }
    failureSamples = $Result.failureSamples
    health = Summarize-Health $Health
  }
}

$process = $null

function Read-LauncherLogTail {
  if (-not (Test-Path $logFile)) {
    return '(log file not created)'
  }

  return ((Get-Content $logFile -Tail 40) -join [Environment]::NewLine)
}

try {
  $launcherArgs = "$launcher $DataDir $WebPort $ProxyPort $logFile"
  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $launcherArgs -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    throw "Launcher exited early.`n$(Read-LauncherLogTail)"
  }
  $null = Wait-Url -Url "http://127.0.0.1:$WebPort/api/meta"
  $initialHealth = Wait-Url -Url "http://127.0.0.1:$ProxyPort/health"
  $initialStatus = Get-ProxyStatus

  $warmup = Run-Driver -Concurrency 1 -Requests 1 -TimeoutMs 120000

  $tiers = @(
    @{ name = 'c10-r20'; concurrency = 10; requests = 20 },
    @{ name = 'c20-r40'; concurrency = 20; requests = 40 },
    @{ name = 'c40-r80'; concurrency = 40; requests = 80 }
  )

  $tierResults = @()
  foreach ($tier in $tiers) {
    $result = Run-Driver -Concurrency $tier.concurrency -Requests $tier.requests -TimeoutMs 120000
    $health = Get-Health
    $tierResults += Summarize-Tier -Name $tier.name -Concurrency $tier.concurrency -Requests $tier.requests -Result $result -Health $health
  }

  $baselineConfig = @{
    maxConcurrent = [int]$initialStatus.config.maxConcurrent
    maxQueueSize = [int]$initialStatus.config.maxQueueSize
    requestTimeoutMs = [int]$initialStatus.config.requestTimeoutMs
  }

  $null = Update-ProxyConfig -Config @{
    maxConcurrent = 2
    maxQueueSize = 3
    requestTimeoutMs = [Math]::Min($baselineConfig.requestTimeoutMs, 60000)
  }
  Start-Sleep -Seconds 1

  $queueResult = Run-Driver -Concurrency 8 -Requests 8 -TimeoutMs 120000
  $queueHealth = Get-Health

  $null = Update-ProxyConfig -Config $baselineConfig
  Start-Sleep -Seconds 1

  $bodyLimitBytes = 2 * 1024 * 1024 + 4096
  $bodyLimitResult = Run-Driver -Concurrency 1 -Requests 1 -TimeoutMs 30000 -PayloadSize $bodyLimitBytes
  $bodyLimitHealth = Get-Health

  $finalHealth = Get-Health
  $finalStatus = Get-ProxyStatus
  $proc = Get-Process -Id $process.Id

  [PSCustomObject]@{
    instance = [PSCustomObject]@{
      webPort = $WebPort
      proxyPort = $ProxyPort
      pid = $process.Id
      logFile = $logFile
    }
    initialHealth = Summarize-Health $initialHealth
    initialStatus = Summarize-Status $initialStatus
    warmup = [PSCustomObject]@{
      success = $warmup.success
      failures = $warmup.failures
      throughputRps = [math]::Round([double]$warmup.throughputRps, 2)
      elapsedMs = [math]::Round([double]$warmup.elapsedMs, 2)
      statusBreakdown = $warmup.statusBreakdown
      latencyMs = [PSCustomObject]@{
        min = [math]::Round([double]$warmup.latencyMs.min, 2)
        p50 = [math]::Round([double]$warmup.latencyMs.p50, 2)
        p90 = [math]::Round([double]$warmup.latencyMs.p90, 2)
        p95 = [math]::Round([double]$warmup.latencyMs.p95, 2)
        max = [math]::Round([double]$warmup.latencyMs.max, 2)
        avg = [math]::Round([double]$warmup.latencyMs.avg, 2)
      }
    }
    tiers = $tierResults
    queueProtection = Summarize-Tier -Name 'queue-protection' -Concurrency 8 -Requests 8 -Result $queueResult -Health $queueHealth
    bodyLimitProtection = Summarize-Tier -Name 'body-limit' -Concurrency 1 -Requests 1 -Result $bodyLimitResult -Health $bodyLimitHealth
    finalHealth = Summarize-Health $finalHealth
    finalStatus = Summarize-Status $finalStatus
    process = [PSCustomObject]@{
      cpu = $proc.CPU
      workingSetMB = [math]::Round($proc.WorkingSet64 / 1MB, 2)
      privateMemoryMB = [math]::Round($proc.PrivateMemorySize64 / 1MB, 2)
      virtualMemoryMB = [math]::Round($proc.VirtualMemorySize64 / 1MB, 2)
    }
  } | ConvertTo-Json -Depth 20
} finally {
  if ($null -ne $process) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
}
