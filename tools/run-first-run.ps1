param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$WorkspaceRoot = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$projectDemoScript = Join-Path $repoRoot "tools\demo\run-project-demo.ps1"

if (-not (Test-Path -LiteralPath $projectDemoScript)) {
  throw "Missing script: $projectDemoScript"
}

Write-Host "== First-run quick path =="
Write-Host "Step 1/5: Ensure backend is running on $BaseUrl"
Write-Host "Step 2/5: Import project demo"
Write-Host "Step 3/5: Trigger one dispatch"
Write-Host "Step 4/5: Apply deterministic TASK_REPORT"
Write-Host "Step 5/5: Export task-tree/timeline evidence"

$args = @(
  "-ExecutionPolicy", "Bypass",
  "-File", $projectDemoScript,
  "-BaseUrl", $BaseUrl
)
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  $args += @("-WorkspaceRoot", $WorkspaceRoot)
}

& powershell @args
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
  Write-Host "first-run failed. See script output above for error context."
  exit $exitCode
}

Write-Host ""
Write-Host "First-run success criteria:"
Write-Host "1) task tree: /api/projects/demo_project_mode_v1/task-tree"
Write-Host "2) timeline: /api/projects/demo_project_mode_v1/agent-io/timeline?limit=200"
Write-Host "3) workspace evidence: <workspace>/docs/demo/project/run_summary.md"
