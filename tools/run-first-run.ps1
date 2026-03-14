param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$WorkspaceRoot = "D:\\AgentWorkSpace\\TestTeam\\TestRound20"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$standardE2EScript = Join-Path $repoRoot "E2ETest\scripts\run-standard-e2e.ps1"

if (-not (Test-Path -LiteralPath $standardE2EScript)) {
  throw "Missing script: $standardE2EScript"
}

Write-Host "== First-run via official E2E baseline =="
Write-Host "Step 1/4: Ensure backend is running on $BaseUrl"
Write-Host "Step 2/4: Seed baseline project scenario"
Write-Host "Step 3/4: Execute orchestrator dispatch loop"
Write-Host "Step 4/4: Export task tree/timeline/evidence artifacts"

$args = @(
  "-ExecutionPolicy", "Bypass",
  "-File", $standardE2EScript,
  "-BaseUrl", $BaseUrl,
  "-WorkspaceRoot", $WorkspaceRoot
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
