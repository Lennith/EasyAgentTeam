param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\ExternalAgent3DoF",
  [int]$AutoDispatchBudget = 30,
  [int]$MaxMinutes = 90,
  [int]$PollSeconds = 5,
  [switch]$SetupOnly,
  [bool]$StrictObserve = $true
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$scenarioPath = Join-Path $repoRoot "E2ETest\scenarios\workflow-external-agent-3dof.json"

& (Join-Path $scriptDir "run-workflow-e2e.ps1") `
  -BaseUrl $BaseUrl `
  -ScenarioPath $scenarioPath `
  -WorkspaceRoot $WorkspaceRoot `
  -AutoDispatchBudget $AutoDispatchBudget `
  -MaxMinutes $MaxMinutes `
  -PollSeconds $PollSeconds `
  -SetupOnly:$SetupOnly `
  -StrictObserve $StrictObserve
