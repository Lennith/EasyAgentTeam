param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string[]]$Cases = @("chain", "discuss", "workflow"),
  [string]$ChainScenarioPath = "",
  [string]$DiscussScenarioPath = "",
  [string]$WorkflowScenarioPath = "",
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
  [switch]$StrictObserve,
  [switch]$LegacyMode,
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
}

$selected = @()
foreach ($caseIdRaw in $Cases) {
  $caseId = $caseIdRaw.Trim().ToLower()
  if (-not $caseMap.ContainsKey($caseId)) {
    throw "Unknown case '$caseId'. Supported: chain, discuss, workflow"
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
$strictMode = $StrictObserve.IsPresent -or (-not $LegacyMode.IsPresent)
Write-Host ("strict_observe={0}" -f $strictMode)

$jobs = @()
foreach ($caseId in $selected) {
  $cfg = $caseMap[$caseId]
  $scriptPath = [string]$cfg.script
  $scenarioPath = [string]$cfg.scenario
  $workspace = [string]$cfg.workspace

  Write-Host ("[launch] case={0} script={1} workspace={2}" -f $caseId, $scriptPath, $workspace)
  $jobs += Start-Job -Name $caseId -ScriptBlock {
    param(
      [string]$ScriptPath,
      [string]$BaseUrl,
      [string]$ScenarioPath,
      [string]$WorkspaceRoot,
      [int]$AutoDispatchBudget,
      [int]$MaxMinutes,
      [int]$PollSeconds,
      [int]$AutoTopupStep,
      [int]$MaxTopups,
      [int]$MaxTotalBudget,
      [bool]$SetupOnly,
      [bool]$StrictObserve,
      [string]$CaseId,
      [string]$MiniMaxApiKeyOverride,
      [string]$MiniMaxApiBaseOverride,
      [bool]$ClearMiniMaxSettings
    )

    $args = @(
      "-ExecutionPolicy", "Bypass",
      "-File", $ScriptPath,
      "-BaseUrl", $BaseUrl,
      "-ScenarioPath", $ScenarioPath,
      "-WorkspaceRoot", $WorkspaceRoot,
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
    if ($StrictObserve -and $CaseId -eq "chain") {
      $args += "-StrictObserve"
    }
    if ($CaseId -eq "workflow") {
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
    & powershell @args
    [pscustomobject]@{
      exitCode = $LASTEXITCODE
    }
  } -ArgumentList $scriptPath, $BaseUrl, $scenarioPath, $workspace, $AutoDispatchBudget, $MaxMinutes, $PollSeconds, $AutoTopupStep, $MaxTopups, $MaxTotalBudget, $SetupOnly.IsPresent, $strictMode, $caseId, $MiniMaxApiKeyOverride, $MiniMaxApiBaseOverride, $ClearMiniMaxSettings.IsPresent
}

$failed = @()
foreach ($job in $jobs) {
  Wait-Job -Id $job.Id | Out-Null
  $output = @(Receive-Job -Id $job.Id)
  if ($output) {
    foreach ($line in @($output)) {
      Write-Host ("[{0}] {1}" -f $job.Name, $line)
    }
  }
  if ($job.State -ne "Completed") {
    $failed += $job.Name
    Write-Host ("[failed] case={0} state={1}" -f $job.Name, $job.State)
    continue
  }
  if ($job.ChildJobs.Count -gt 0 -and $job.ChildJobs[0].Error.Count -gt 0) {
    $failed += $job.Name
    Write-Host ("[failed] case={0} error={1}" -f $job.Name, $job.ChildJobs[0].Error[0])
    continue
  }
  $exitCodeObj = $output | Where-Object { $_ -and $_.PSObject.Properties.Match("exitCode").Count -gt 0 } | Select-Object -Last 1
  if ($exitCodeObj -and [int]$exitCodeObj.exitCode -ne 0) {
    $failed += $job.Name
    Write-Host ("[failed] case={0} exitCode={1}" -f $job.Name, [int]$exitCodeObj.exitCode)
  } else {
    Write-Host ("[done] case={0}" -f $job.Name)
  }
}

foreach ($job in $jobs) {
  Remove-Job -Id $job.Id -Force -ErrorAction SilentlyContinue
}

if ($failed.Count -gt 0) {
  Write-Host ("== Multi E2E Failed: {0} ==" -f ($failed -join ","))
  exit 2
}

Write-Host "== Multi E2E Passed =="
