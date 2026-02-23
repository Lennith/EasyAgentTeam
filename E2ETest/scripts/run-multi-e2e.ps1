param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [string[]]$Cases = @("chain", "discuss"),
  [string]$ChainScenarioPath = "",
  [string]$DiscussScenarioPath = "",
  [string]$ChainWorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestRound20",
  [string]$DiscussWorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestTeamDiscuss",
  [int]$AutoDispatchBudget = 30,
  [int]$MaxMinutes = 75,
  [int]$PollSeconds = 30,
  [switch]$SetupOnly
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
}

$selected = @()
foreach ($caseIdRaw in $Cases) {
  $caseId = $caseIdRaw.Trim().ToLower()
  if (-not $caseMap.ContainsKey($caseId)) {
    throw "Unknown case '$caseId'. Supported: chain, discuss"
  }
  $selected += $caseId
}
if ($selected.Count -eq 0) {
  throw "No cases selected"
}

Write-Host "== Multi E2E Start =="
Write-Host ("cases={0}" -f ($selected -join ","))
Write-Host ("base_url={0}" -f $BaseUrl)
Write-Host ("setup_only={0}" -f $SetupOnly.IsPresent)

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
      [bool]$SetupOnly
    )
    $args = @(
      "-ExecutionPolicy", "Bypass",
      "-File", $ScriptPath,
      "-BaseUrl", $BaseUrl,
      "-ScenarioPath", $ScenarioPath,
      "-WorkspaceRoot", $WorkspaceRoot,
      "-AutoDispatchBudget", "$AutoDispatchBudget",
      "-MaxMinutes", "$MaxMinutes",
      "-PollSeconds", "$PollSeconds"
    )
    if ($SetupOnly) {
      $args += "-SetupOnly"
    }
    & powershell @args
    $code = $LASTEXITCODE
    [pscustomobject]@{
      exitCode = $code
    }
  } -ArgumentList $scriptPath, $BaseUrl, $scenarioPath, $workspace, $AutoDispatchBudget, $MaxMinutes, $PollSeconds, $SetupOnly.IsPresent
}

$failed = @()
foreach ($job in $jobs) {
  Wait-Job -Id $job.Id | Out-Null
  $output = @(Receive-Job -Id $job.Id)
  if ($output) {
    foreach ($line in @($output)) { Write-Host ("[{0}] {1}" -f $job.Name, $line) }
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
