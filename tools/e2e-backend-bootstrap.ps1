function Ensure-Dir {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Test-BackendHealthy {
  param([string]$HealthUrl)
  try {
    $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3
    if ([int]$resp.StatusCode -ne 200) {
      return $false
    }
    $body = $null
    try {
      $body = $resp.Content | ConvertFrom-Json
    } catch {
      return $false
    }
    return ([string]$body.status -eq "ok")
  } catch {
    return $false
  }
}

function Wait-BackendHealthy {
  param(
    [string]$HealthUrl,
    [int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-BackendHealthy -HealthUrl $HealthUrl) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  if ($ProcessId -le 0) {
    return
  }

  try {
    & taskkill.exe /PID $ProcessId /T /F *> $null
  } catch {
    try {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    } catch {
    }
  }
}

function Ensure-E2EBackend {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [string]$BootstrapLabel = "e2e-backend",
    [int]$TimeoutSeconds = 60
  )

  $healthUrl = "$BaseUrl/healthz"
  $handle = [pscustomobject]@{
    StartedByScript = $false
    Process = $null
    StdoutPath = ""
    StderrPath = ""
    HealthUrl = $healthUrl
  }

  if (Test-BackendHealthy -HealthUrl $healthUrl) {
    Write-Host "Backend health check passed: $healthUrl"
    return $handle
  }

  Write-Host "Backend is not healthy at $healthUrl. Starting local backend via pnpm run dev:server ..."
  $bootstrapDir = Join-Path $RepoRoot (".e2e-workspace\{0}" -f $BootstrapLabel)
  Ensure-Dir -Path $bootstrapDir
  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $serverStdout = Join-Path $bootstrapDir "server_stdout_$stamp.log"
  $serverStderr = Join-Path $bootstrapDir "server_stderr_$stamp.log"
  $pnpmCmd = Get-Command pnpm.cmd -ErrorAction Stop
  $serverProcess = Start-Process -FilePath $pnpmCmd.Source -ArgumentList @("run", "dev:server") -WorkingDirectory $RepoRoot -PassThru -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr

  if (-not (Wait-BackendHealthy -HealthUrl $healthUrl -TimeoutSeconds $TimeoutSeconds)) {
    if ($serverProcess -and -not $serverProcess.HasExited) {
      Stop-ProcessTree -ProcessId $serverProcess.Id
    }
    $stdoutTail = if (Test-Path -LiteralPath $serverStdout) { (Get-Content -LiteralPath $serverStdout -Tail 30 | Out-String) } else { "" }
    $stderrTail = if (Test-Path -LiteralPath $serverStderr) { (Get-Content -LiteralPath $serverStderr -Tail 30 | Out-String) } else { "" }
    throw "Backend bootstrap failed within $TimeoutSeconds s. stdout(log): $serverStdout`n$stdoutTail`nstderr(log): $serverStderr`n$stderrTail"
  }

  $handle.StartedByScript = $true
  $handle.Process = $serverProcess
  $handle.StdoutPath = $serverStdout
  $handle.StderrPath = $serverStderr
  Write-Host "Backend is healthy. pid=$($serverProcess.Id)"
  return $handle
}

function Stop-E2EBackend {
  param($Handle)

  if ($null -eq $Handle) {
    return
  }

  if ($Handle.StartedByScript -and $Handle.Process -and -not $Handle.Process.HasExited) {
    Write-Host "Stopping bootstrap backend process tree pid=$($Handle.Process.Id)"
    Stop-ProcessTree -ProcessId $Handle.Process.Id
  }
}
