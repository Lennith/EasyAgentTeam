param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$ProjectE2EWorkspaceRoot = "D:\\AgentWorkSpace\\TestTeam\\TestRound20",
  [string]$WorkflowE2EWorkspaceRoot = "D:\\AgentWorkSpace\\TestTeam\\TestWorkflowSpace"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$gateOutDir = Join-Path $repoRoot ".e2e-workspace\standard-gate\$timestamp"
New-Item -ItemType Directory -Path $gateOutDir -Force | Out-Null

function Invoke-GateStep {
  param(
    [string]$Name,
    [scriptblock]$Command,
    [string]$LogFile
  )

  Write-Host "== Gate step: $Name =="
  $output = @()
  $exitCode = 0
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(& $Command 2>&1)
    $exitCode = if ($LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
  } catch {
    $output += $_
    $exitCode = 1
  } finally {
    $ErrorActionPreference = $oldErrorAction
  }
  $output | Set-Content -LiteralPath $LogFile -Encoding UTF8
  foreach ($line in $output) {
    Write-Host "[$Name] $line"
  }

  $artifactLine = @($output | Where-Object { [string]$_ -match "^artifacts=" } | Select-Object -Last 1)
  $artifactPath = ""
  if ($artifactLine.Count -gt 0) {
    $artifactPath = ([string]$artifactLine[0]).Substring("artifacts=".Length).Trim()
  }

  return [pscustomobject]@{
    name = $Name
    success = ($exitCode -eq 0)
    exit_code = $exitCode
    log_file = $LogFile
    artifact_path = $artifactPath
  }
}

Push-Location $repoRoot
try {
  $steps = @()

  $steps += Invoke-GateStep -Name "smoke" -LogFile (Join-Path $gateOutDir "01_smoke.log") -Command {
    pnpm test:smoke
  }

  $steps += Invoke-GateStep -Name "project_core_e2e" -LogFile (Join-Path $gateOutDir "02_project_core_e2e.log") -Command {
    powershell -NoProfile -ExecutionPolicy Bypass -File ".\E2ETest\scripts\run-standard-e2e.ps1" `
      -BaseUrl $BaseUrl `
      -WorkspaceRoot $ProjectE2EWorkspaceRoot
  }

  $steps += Invoke-GateStep -Name "workflow_core_e2e" -LogFile (Join-Path $gateOutDir "03_workflow_core_e2e.log") -Command {
    powershell -NoProfile -ExecutionPolicy Bypass -File ".\E2ETest\scripts\run-workflow-e2e.ps1" `
      -BaseUrl $BaseUrl `
      -WorkspaceRoot $WorkflowE2EWorkspaceRoot
  }

  $summary = @()
  $summary += "# Standard Gate Summary"
  $summary += ""
  $summary += "- timestamp: $timestamp"
  $summary += "- gate_output_dir: $gateOutDir"
  $summary += "- base_url: $BaseUrl"
  foreach ($step in $steps) {
    $summary += ""
    $summary += "## $($step.name)"
    $summary += "- success: $($step.success)"
    $summary += "- exit_code: $($step.exit_code)"
    $summary += "- log_file: $($step.log_file)"
    $summary += "- artifact_path: $($step.artifact_path)"
  }
  $summaryPath = Join-Path $gateOutDir "run_summary.md"
  [System.IO.File]::WriteAllLines($summaryPath, $summary, [System.Text.UTF8Encoding]::new($false))

  $gateIndexOutput = @()
  $gateIndexExitCode = 0
  try {
    $gateIndexOutput = @(& node ".\tools\generate-gate-doc-index.mjs" "--summary" $summaryPath 2>&1)
    $gateIndexExitCode = if ($LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
  } catch {
    $gateIndexOutput += $_
    $gateIndexExitCode = 1
  }
  foreach ($line in $gateIndexOutput) {
    Write-Host "[gate_index] $line"
  }

  $gateIndexJsonPath = Join-Path $gateOutDir "gate_doc_index.json"
  $gateIndexMdPath = Join-Path $gateOutDir "gate_doc_index.md"
  $gateIndexArtifactsExist = (Test-Path -LiteralPath $gateIndexJsonPath) -and (Test-Path -LiteralPath $gateIndexMdPath)

  $failed = @($steps | Where-Object { -not $_.success })
  $gateIndexFailed = ($gateIndexExitCode -ne 0) -or (-not $gateIndexArtifactsExist)
  if ($failed.Count -gt 0) {
    Write-Host "== Standard gate failed =="
    foreach ($step in $failed) {
      Write-Host ("failed_step={0}" -f $step.name)
      Write-Host ("log_file={0}" -f $step.log_file)
      if (-not [string]::IsNullOrWhiteSpace([string]$step.artifact_path)) {
        Write-Host ("artifact_path={0}" -f $step.artifact_path)
      }
    }
    if ($gateIndexFailed) {
      Write-Host "failed_step=gate_doc_index"
      Write-Host ("exit_code={0}" -f $gateIndexExitCode)
      if (-not $gateIndexArtifactsExist) {
        Write-Host ("missing_artifact={0}" -f $gateIndexJsonPath)
        Write-Host ("missing_artifact={0}" -f $gateIndexMdPath)
      }
    }
    Write-Host ("gate_summary={0}" -f $summaryPath)
    exit 2
  }

  if ($gateIndexFailed) {
    Write-Host "== Standard gate failed =="
    Write-Host "failed_step=gate_doc_index"
    Write-Host ("exit_code={0}" -f $gateIndexExitCode)
    if (-not $gateIndexArtifactsExist) {
      Write-Host ("missing_artifact={0}" -f $gateIndexJsonPath)
      Write-Host ("missing_artifact={0}" -f $gateIndexMdPath)
    }
    Write-Host ("gate_summary={0}" -f $summaryPath)
    exit 2
  }

  Write-Host "== Standard gate passed =="
  Write-Host ("gate_summary={0}" -f $summaryPath)
} finally {
  Pop-Location
}
