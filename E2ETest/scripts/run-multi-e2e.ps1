param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string[]]$Cases = @("chain", "discuss", "workflow"),
  [ValidateSet("", "codex", "minimax")]
  [string]$ProviderId = "",
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
Write-Host ("provider_mode={0}" -f $(if ([string]::IsNullOrWhiteSpace($ProviderId)) { "mixed" } else { "forced:$ProviderId" }))
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
    if (-not [string]::IsNullOrWhiteSpace($ProviderId)) {
      $args += @("-ProviderId", $ProviderId)
    }
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

function Build-ProviderAuditSummary {
  param(
    [string]$CaseId,
    [string]$ArtifactDir
  )

  $applicable = ($CaseId -ne "template-agent")
  $summary = [ordered]@{
    applicable = $applicable
    providers_resolved = @()
    mixed_provider_pass = $null
    provider_session_audit_pass = $null
    provider_activity_pass = $null
    provider_matrix_missing = $applicable
    provider_session_audit_missing = $applicable
    provider_activity_missing = $applicable
  }

  if (-not $applicable -or [string]::IsNullOrWhiteSpace($ArtifactDir)) {
    return $summary
  }

  $matrixPath = Join-Path $ArtifactDir "provider_matrix_resolved.json"
  if (Test-Path -LiteralPath $matrixPath) {
    try {
      $matrixObj = Get-Content -LiteralPath $matrixPath -Raw | ConvertFrom-Json
      $providers = @($matrixObj.providers | ForEach-Object { ([string]$_).Trim().ToLower() } | Where-Object { $_ } | Sort-Object -Unique)
      $summary.providers_resolved = $providers
      $summary.mixed_provider_pass = (($providers.Count -eq 2) -and (@($providers | Where-Object { $_ -notin @("codex", "minimax") }).Count -eq 0))
      $summary.provider_matrix_missing = $false
    } catch {}
  }

  $sessionAuditPath = Join-Path $ArtifactDir "provider_session_audit.json"
  if (Test-Path -LiteralPath $sessionAuditPath) {
    try {
      $sessionAudit = Get-Content -LiteralPath $sessionAuditPath -Raw | ConvertFrom-Json
      $summary.provider_session_audit_pass = [bool]$sessionAudit.all_sessions_match
      $summary.provider_session_audit_missing = $false
    } catch {}
  }

  $activityPath = Join-Path $ArtifactDir "provider_activity_summary.json"
  if (Test-Path -LiteralPath $activityPath) {
    try {
      $activity = Get-Content -LiteralPath $activityPath -Raw | ConvertFrom-Json
      $summary.provider_activity_pass = [bool]$activity.overall_pass
      $summary.provider_activity_missing = $false
    } catch {}
  }

  return $summary
}

$aggregateItems = @()
$totalsToolFail = 0
$totalsTimeoutRecovered = 0
$totalsMixedProviderCases = 0
$totalsProviderSessionAuditPass = 0
$totalsProviderActivityPass = 0
$providerAuditFailures = @()
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

  $providerAudit = Build-ProviderAuditSummary -CaseId $caseId -ArtifactDir $artifactDir
  $metricsObj | Add-Member -NotePropertyName providers_resolved -NotePropertyValue @($providerAudit.providers_resolved) -Force
  $metricsObj | Add-Member -NotePropertyName mixed_provider_pass -NotePropertyValue $providerAudit.mixed_provider_pass -Force
  $metricsObj | Add-Member -NotePropertyName provider_session_audit_pass -NotePropertyValue $providerAudit.provider_session_audit_pass -Force
  $metricsObj | Add-Member -NotePropertyName provider_activity_pass -NotePropertyValue $providerAudit.provider_activity_pass -Force
  $metricsObj | Add-Member -NotePropertyName provider_matrix_missing -NotePropertyValue $providerAudit.provider_matrix_missing -Force
  $metricsObj | Add-Member -NotePropertyName provider_session_audit_missing -NotePropertyValue $providerAudit.provider_session_audit_missing -Force
  $metricsObj | Add-Member -NotePropertyName provider_activity_missing -NotePropertyValue $providerAudit.provider_activity_missing -Force

  $totalsToolFail += [int]$metricsObj.toolcall_failed_count
  $totalsTimeoutRecovered += [int]$metricsObj.timeout_recovered_count
  if ($providerAudit.applicable) {
    if ($providerAudit.mixed_provider_pass) {
      $totalsMixedProviderCases += 1
    }
    if ($providerAudit.provider_session_audit_pass) {
      $totalsProviderSessionAuditPass += 1
    }
    if ($providerAudit.provider_activity_pass) {
      $totalsProviderActivityPass += 1
    }
    if ((-not $providerAudit.mixed_provider_pass) -or (-not $providerAudit.provider_session_audit_pass) -or (-not $providerAudit.provider_activity_pass)) {
      $providerAuditFailures += $caseId
    }
  }
  $aggregateItems += $metricsObj
}

$multiStamp = Get-Date -Format "yyyyMMdd_HHmmss"
$multiOutDir = Join-Path $repoRoot "docs\e2e\multi\$multiStamp"
[System.IO.Directory]::CreateDirectory($multiOutDir) | Out-Null
$aggregateJson = [ordered]@{
  generated_at = (Get-Date).ToString("o")
  base_url = $BaseUrl
  provider_mode = if ([string]::IsNullOrWhiteSpace($ProviderId)) { "mixed" } else { "forced_provider" }
  forced_provider_id = if ([string]::IsNullOrWhiteSpace($ProviderId)) { $null } else { $ProviderId }
  selected_cases = $selected
  totals = @{
    toolcall_failed_count = $totalsToolFail
    timeout_recovered_count = $totalsTimeoutRecovered
    mixed_provider_case_pass_count = $totalsMixedProviderCases
    provider_session_audit_pass_count = $totalsProviderSessionAuditPass
    provider_activity_pass_count = $totalsProviderActivityPass
  }
  cases = $aggregateItems
}
($aggregateJson | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $multiOutDir "stability_metrics_all.json") -Encoding UTF8

$md = @()
$md += "# Multi E2E Stability Metrics"
$md += ""
$md += "- generated_at: $((Get-Date).ToString("o"))"
$md += "- provider_mode: $(if ([string]::IsNullOrWhiteSpace($ProviderId)) { "mixed" } else { "forced:$ProviderId" })"
$md += "- selected_cases: $($selected -join ",")"
$md += "- total_toolcall_failed_count: $totalsToolFail"
$md += "- total_timeout_recovered_count: $totalsTimeoutRecovered"
$md += "- mixed_provider_case_pass_count: $totalsMixedProviderCases"
$md += "- provider_session_audit_pass_count: $totalsProviderSessionAuditPass"
$md += "- provider_activity_pass_count: $totalsProviderActivityPass"
$md += ""
$md += "## Cases"
$md += ""
foreach ($item in $aggregateItems) {
  $md += "- case=$($item.case_id) pass=$($item.final_pass) exit_code=$($item.exit_code) providers=$(@($item.providers_resolved) -join ',') mixed_provider_pass=$($item.mixed_provider_pass) provider_session_audit_pass=$($item.provider_session_audit_pass) provider_activity_pass=$($item.provider_activity_pass) toolcall_failed=$($item.toolcall_failed_count) timeout_recovered=$($item.timeout_recovered_count) metrics_missing=$($item.metrics_missing) artifacts_dir=$($item.artifacts_dir)"
}
[System.IO.File]::WriteAllLines((Join-Path $multiOutDir "stability_metrics_all.md"), $md, [System.Text.UTF8Encoding]::new($false))
Write-Host ("multi_stability_metrics_dir={0}" -f $multiOutDir)

foreach ($caseId in ($providerAuditFailures | Select-Object -Unique)) {
  if ($failed -notcontains $caseId) {
    $failed += $caseId
  }
}

if ($failed.Count -gt 0) {
  Write-Host ("== Multi E2E Failed: {0} ==" -f ($failed -join ","))
  exit 2
}

Write-Host "== Multi E2E Passed =="
