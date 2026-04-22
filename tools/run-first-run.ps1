param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$WorkspaceRoot = "D:\\AgentWorkSpace\\TestTeam\\TestRound20"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$standardE2EScript = Join-Path $repoRoot "E2ETest\scripts\run-standard-e2e.ps1"
$startedServerByScript = $false
$serverProcess = $null

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

if (-not (Test-Path -LiteralPath $standardE2EScript)) {
  throw "Missing script: $standardE2EScript"
}

Write-Host "== First-run via official E2E baseline =="
Write-Host "Step 1/4: Ensure backend is running on $BaseUrl"
Write-Host "Step 2/4: Seed baseline project scenario"
Write-Host "Step 3/4: Skip orchestrator checks (setup-only mode)"
Write-Host "Step 4/4: Export setup evidence artifacts"

try {
  $healthUrl = "$BaseUrl/healthz"
  if (-not (Test-BackendHealthy -HealthUrl $healthUrl)) {
    Write-Host "Backend is not healthy at $healthUrl. Starting local backend via pnpm run dev:server ..."
    $bootstrapDir = Join-Path $repoRoot ".e2e-workspace\first-run"
    Ensure-Dir -Path $bootstrapDir
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $serverStdout = Join-Path $bootstrapDir "server_stdout_$stamp.log"
    $serverStderr = Join-Path $bootstrapDir "server_stderr_$stamp.log"
    $pnpmCmd = Get-Command pnpm.cmd -ErrorAction Stop
    $serverProcess = Start-Process -FilePath $pnpmCmd.Source -ArgumentList @("run", "dev:server") -WorkingDirectory $repoRoot -PassThru -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr
    $startedServerByScript = $true

    if (-not (Wait-BackendHealthy -HealthUrl $healthUrl -TimeoutSeconds 60)) {
      if ($serverProcess -and -not $serverProcess.HasExited) {
        Stop-ProcessTree -ProcessId $serverProcess.Id
      }
      $stdoutTail = if (Test-Path -LiteralPath $serverStdout) { (Get-Content -LiteralPath $serverStdout -Tail 30 | Out-String) } else { "" }
      $stderrTail = if (Test-Path -LiteralPath $serverStderr) { (Get-Content -LiteralPath $serverStderr -Tail 30 | Out-String) } else { "" }
      throw "Backend bootstrap failed within 60s. stdout(log): $serverStdout`n$stdoutTail`nstderr(log): $serverStderr`n$stderrTail"
    }

    Write-Host "Backend is healthy. pid=$($serverProcess.Id)"
  } else {
    Write-Host "Backend health check passed: $healthUrl"
  }

$args = @(
  "-ExecutionPolicy", "Bypass",
  "-File", $standardE2EScript,
  "-BaseUrl", $BaseUrl,
  "-WorkspaceRoot", $WorkspaceRoot,
  "-SetupOnly"
)

  & powershell @args
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Write-Host "first-run failed. See script output above for error context."
    exit $exitCode
  }

  Write-Host ""
  Write-Host "First-run success criteria:"
  Write-Host "1) run_summary.md contains runtime_pass=true and analysis_pass=true"
  Write-Host "2) artifacts directory contains task_tree_final.json and events.ndjson"
  Write-Host "3) dashboard Projects task-tree and timeline reflect the same terminal state"
} finally {
  if ($startedServerByScript -and $serverProcess -and -not $serverProcess.HasExited) {
    Write-Host "Stopping bootstrap backend process tree pid=$($serverProcess.Id)"
    Stop-ProcessTree -ProcessId $serverProcess.Id
  }
}
