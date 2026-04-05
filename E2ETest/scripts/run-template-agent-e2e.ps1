param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$WorkspaceRoot = "",
  [string]$DataRoot = "",
  [int]$MaxSeconds = 120,
  [switch]$SetupOnly
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

$nodeArgs = @(
  (Join-Path $repoRoot "E2ETest\scripts\run-template-agent-e2e.mjs"),
  "--base-url", $BaseUrl,
  "--max-seconds", "$MaxSeconds"
)
if (-not [string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
  $nodeArgs += @("--workspace-root", $WorkspaceRoot)
}
if (-not [string]::IsNullOrWhiteSpace($DataRoot)) {
  $nodeArgs += @("--data-root", $DataRoot)
}
if ($SetupOnly) {
  $nodeArgs += "--setup-only"
}

& node @nodeArgs
exit $LASTEXITCODE
