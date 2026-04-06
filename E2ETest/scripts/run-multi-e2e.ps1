param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string[]]$Cases = @("chain", "discuss", "workflow"),
  [string]$ChainScenarioPath = "",
  [string]$DiscussScenarioPath = "",
  [string]$WorkflowScenarioPath = "",
  [string]$TemplateAgentWorkspaceRoot = "",
  [string]$TemplateAgentDataRoot = "",
  [string]$ChainWorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestRound20",
  [string]$DiscussWorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestTeamDiscuss",
  [string]$WorkflowWorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestWorkflowSpace",
  [int]$AutoDispatchBudget = 30,
  [int]$MaxMinutes = 90,
  [int]$PollSeconds = 5,
  [int]$AutoTopupStep = 30,
  [int]$MaxTopups = 10,
  [int]$MaxTotalBudget = 330,
  [switch]$SetupOnly,
  [string]$MiniMaxApiKeyOverride = "",
  [string]$MiniMaxApiBaseOverride = "",
  [switch]$ClearMiniMaxSettings
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

if (-not $ChainScenarioPath) {
  $ChainScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\a-self-decompose-chain.json"
}
if (-not $DiscussScenarioPath) {
  $DiscussScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\team-discuss-framework.json"
}
if (-not $WorkflowScenarioPath) {
  $WorkflowScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\workflow-gesture-real-agent.json"
}
if (-not $TemplateAgentWorkspaceRoot) {
  $TemplateAgentWorkspaceRoot = Join-Path $repoRoot ".e2e-workspace\TestTeam\TemplateAgent"
}
if (-not $TemplateAgentDataRoot) {
  $TemplateAgentDataRoot = Join-Path $repoRoot "data"
}

$caseMap = @{
  "chain" = @{
    script = Join-Path $scriptDir "run-standard-e2e.ps1"
    scenario = $ChainScenarioPath
    workspace = $ChainWorkspaceRoot
  }
  "discuss" = @{
    script = Join-Path $scriptDir "run-discuss-e2e.ps1"
    scenario = $DiscussScenarioPath
    workspace = $DiscussWorkspaceRoot
  }
  "workflow" = @{
    script = Join-Path $scriptDir "run-workflow-e2e.ps1"
    scenario = $WorkflowScenarioPath
    workspace = $WorkflowWorkspaceRoot
  }
  "template-agent" = @{
    script = Join-Path $scriptDir "run-template-agent-e2e.ps1"
    scenario = ""
    workspace = $TemplateAgentWorkspaceRoot
    dataRoot = $TemplateAgentDataRoot
  }
}

$selected = @()
foreach ($caseIdRaw in $Cases) {
  $caseId = $caseIdRaw.Trim().ToLower()
  if (-not $caseMap.Contains($caseId)) {
    throw "Unknown case '$caseId'. Supported: chain, discuss, workflow, template-agent"
  }
  $selected += $caseId
}
if ($selected.Count -eq 0) {
  throw "No cases selected"
}
if (($selected -notcontains "workflow") -or (-not ($selected -contains "chain" -or $selected -contains "discuss"))) {
  throw "run-multi-e2e requires workflow plus at least one project baseline (chain or discuss)"
}

Write-Host "== Multi E2E Start =="
Write-Host ("cases={0}" -f ($selected -join ","))
Write-Host ("base_url={0}" -f $BaseUrl)
Write-Host ("setup_only={0}" -f $SetupOnly.IsPresent)
Write-Host "strict_observe=True"

$caseArtifacts = @{}
$caseExitCodes = @{}
$failed = @()

foreach ($caseId in $selected) {
  $cfg = $caseMap[$caseId]
  $scriptPath = [string]$cfg.script
  $scenarioPath = [string]$cfg.scenario
  $workspace = [string]$cfg.workspace
  $dataRoot = if ($cfg.ContainsKey("dataRoot")) { [string]$cfg.dataRoot } else { "" }

  $args = @("-ExecutionPolicy", "Bypass", "-File", $scriptPath, "-BaseUrl", $BaseUrl, "-WorkspaceRoot", $workspace)
  if ($caseId -eq "template-agent") {
    $maxSeconds = [Math]::Max(60, ($MaxMinutes * 60))
    $args += @("-MaxSeconds", "$maxSeconds")
    if (-not [string]::IsNullOrWhiteSpace($dataRoot)) {
      $args += @("-DataRoot", $dataRoot)
    }
    if ($SetupOnly) {
      $args += "-SetupOnly"
    }
  } else {
    $args += @(
      "-ScenarioPath", $scenarioPath,
      "-AutoDispatchBudget", "$AutoDispatchBudget",
      "-MaxMinutes", "$MaxMinutes",
      "-PollSeconds", "$PollSeconds",
      "-AutoTopupStep", "$AutoTopupStep",
      "-MaxTopups", "$MaxTopups",
      "-MaxTotalBudget", "$MaxTotalBudget"
    )
    if ($SetupOnly) {
      $args += "-SetupOnly"
    }
    if ($caseId -eq "chain") {
      $args += "-StrictObserve"
    }
    if ($caseId -eq "workflow") {
      if (-not [string]::IsNullOrWhiteSpace($MiniMaxApiKeyOverride)) {
        $args += @("-MiniMaxApiKeyOverride", $MiniMaxApiKeyOverride)
      }
      if (-not [string]::IsNullOrWhiteSpace($MiniMaxApiBaseOverride)) {
        $args += @("-MiniMaxApiBaseOverride", $MiniMaxApiBaseOverride)
      }
      if ($ClearMiniMaxSettings) {
        $args += "-ClearMiniMaxSettings"
      }
    }
  }

  Write-Host ("[launch] case={0} script={1} workspace={2}" -f $caseId, $scriptPath, $workspace)
  $output = @(& powershell @args 2>&1)
  $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
  foreach ($line in $output) {
    $text = [string]$line
    Write-Host ("[{0}] {1}" -f $caseId, $text)
    if ($text -like "artifacts=*") {
      $caseArtifacts[$caseId] = ($text -replace "^artifacts=", "").Trim()
    }
  }
  $caseExitCodes[$caseId] = $exitCode
  if ($exitCode -ne 0) {
    $failed += $caseId
    Write-Host ("[failed] case={0} exitCode={1}" -f $caseId, $exitCode)
  } else {
    Write-Host ("[done] case={0}" -f $caseId)
  }
}

function Build-PlaceholderMetrics {
  param(
    [string]$CaseId,
    [int]$ExitCode
  )
  return [ordered]@{
    case_id = $CaseId
    start_time = ""
    end_time = (Get-Date).ToString("o")
    exit_code = $ExitCode
    final_pass = $false
    final_reason = "metrics_missing"
    toolcall_failed_count = 0
    toolcall_failed_timestamps = @()
    timeout_recovered_count = 0
    timeout_recovered_timestamps = @()
    fallback_events = @()
    metrics_missing = $true
  }
}

$aggregateItems = @()
$totalsToolFail = 0
$totalsTimeoutRecovered = 0
foreach ($caseId in $selected) {
  $metricsObj = $null
  $artifactDir = if ($caseArtifacts.Contains($caseId)) { [string]$caseArtifacts[$caseId] } else { "" }
  $metricsPath = if (-not [string]::IsNullOrWhiteSpace($artifactDir)) { Join-Path $artifactDir "stability_metrics.json" } else { "" }
  if (-not [string]::IsNullOrWhiteSpace($metricsPath) -and (Test-Path -LiteralPath $metricsPath)) {
    try {
      $metricsObj = Get-Content -LiteralPath $metricsPath -Raw | ConvertFrom-Json
      $metricsObj | Add-Member -NotePropertyName metrics_missing -NotePropertyValue $false -Force
      $metricsObj | Add-Member -NotePropertyName artifacts_dir -NotePropertyValue $artifactDir -Force
    } catch {
      $metricsObj = Build-PlaceholderMetrics -CaseId $caseId -ExitCode $(if ($caseExitCodes.Contains($caseId)) { [int]$caseExitCodes[$caseId] } else { 2 })
      $metricsObj.artifacts_dir = $artifactDir
    }
  } else {
    $metricsObj = Build-PlaceholderMetrics -CaseId $caseId -ExitCode $(if ($caseExitCodes.Contains($caseId)) { [int]$caseExitCodes[$caseId] } else { 2 })
    $metricsObj.artifacts_dir = $artifactDir
  }

  $totalsToolFail += [int]$metricsObj.toolcall_failed_count
  $totalsTimeoutRecovered += [int]$metricsObj.timeout_recovered_count
  $aggregateItems += $metricsObj
}

$multiStamp = Get-Date -Format "yyyyMMdd_HHmmss"
$multiOutDir = Join-Path $repoRoot "docs\e2e\multi\$multiStamp"
[System.IO.Directory]::CreateDirectory($multiOutDir) | Out-Null
$aggregateJson = [ordered]@{
  generated_at = (Get-Date).ToString("o")
  base_url = $BaseUrl
  selected_cases = $selected
  totals = @{
    toolcall_failed_count = $totalsToolFail
    timeout_recovered_count = $totalsTimeoutRecovered
  }
  cases = $aggregateItems
}
($aggregateJson | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $multiOutDir "stability_metrics_all.json") -Encoding UTF8

$md = @()
$md += "# Multi E2E Stability Metrics"
$md += ""
$md += "- generated_at: $((Get-Date).ToString("o"))"
$md += "- selected_cases: $($selected -join ",")"
$md += "- total_toolcall_failed_count: $totalsToolFail"
$md += "- total_timeout_recovered_count: $totalsTimeoutRecovered"
$md += ""
$md += "## Cases"
$md += ""
foreach ($item in $aggregateItems) {
  $md += "- case=$($item.case_id) pass=$($item.final_pass) exit_code=$($item.exit_code) toolcall_failed=$($item.toolcall_failed_count) timeout_recovered=$($item.timeout_recovered_count) metrics_missing=$($item.metrics_missing) artifacts_dir=$($item.artifacts_dir)"
}
[System.IO.File]::WriteAllLines((Join-Path $multiOutDir "stability_metrics_all.md"), $md, [System.Text.UTF8Encoding]::new($false))
Write-Host ("multi_stability_metrics_dir={0}" -f $multiOutDir)

if ($failed.Count -gt 0) {
  Write-Host ("== Multi E2E Failed: {0} ==" -f ($failed -join ","))
  exit 2
}

Write-Host "== Multi E2E Passed =="
