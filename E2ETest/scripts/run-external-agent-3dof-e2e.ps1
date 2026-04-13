param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [ValidateSet("", "codex", "minimax")]
  [string]$ProviderId = "",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\ExternalAgent3DoF",
  [int]$AutoDispatchBudget = 30,
  [int]$MaxMinutes = 90,
  [int]$PollSeconds = 5,
  [switch]$SetupOnly,
  [bool]$StrictObserve = $true,
  [string]$MiniMaxApiKeyOverride = "",
  [string]$MiniMaxApiBaseOverride = "",
  [switch]$ClearMiniMaxSettings
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$scenarioPath = Join-Path $repoRoot "E2ETest\scenarios\workflow-external-agent-3dof.json"

& (Join-Path $scriptDir "run-workflow-e2e.ps1") `
  -BaseUrl $BaseUrl `
  -ScenarioPath $scenarioPath `
  -ProviderId $ProviderId `
  -WorkspaceRoot $WorkspaceRoot `
  -AutoDispatchBudget $AutoDispatchBudget `
  -MaxMinutes $MaxMinutes `
  -PollSeconds $PollSeconds `
  -SetupOnly:$SetupOnly `
  -StrictObserve $StrictObserve `
  -MiniMaxApiKeyOverride $MiniMaxApiKeyOverride `
  -MiniMaxApiBaseOverride $MiniMaxApiBaseOverride `
  -ClearMiniMaxSettings:$ClearMiniMaxSettings
