param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [string]$ScenarioPath = "",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\a-self-decompose-chain.json"
}
if (-not $OutputPath) {
  $OutputPath = Join-Path $ArtifactsDir "analysis.md"
}

$scenario = Get-Content -LiteralPath $ScenarioPath | ConvertFrom-Json
$roles = $scenario.roles
$roleA = [string]$roles.A
$roleB = [string]$roles.B
$roleC = [string]$roles.C
$roleD = [string]$roles.D

$taskAId = [string]$scenario.seed_tasks.task_a.task_id
$taskBId = [string]$scenario.seed_tasks.task_b_placeholder.task_id
$taskB1Id = [string]$scenario.seed_tasks.task_b1_child.task_id
$taskCId = [string]$scenario.seed_tasks.task_c.task_id

$eventsPath = Join-Path $ArtifactsDir "events.ndjson"
$treePath = Join-Path $ArtifactsDir "task_tree_final.json"
$sessionsPath = Join-Path $ArtifactsDir "sessions_final.json"
$preGatePath = Join-Path $ArtifactsDir "pre_gate_checks.json"

if (-not (Test-Path -LiteralPath $eventsPath)) { throw "events.ndjson not found: $eventsPath" }
if (-not (Test-Path -LiteralPath $treePath)) { throw "task_tree_final.json not found: $treePath" }
if (-not (Test-Path -LiteralPath $sessionsPath)) { throw "sessions_final.json not found: $sessionsPath" }
if (-not (Test-Path -LiteralPath $preGatePath)) { throw "pre_gate_checks.json not found: $preGatePath" }

$events = @()
foreach ($line in (Get-Content -LiteralPath $eventsPath)) {
  $trimmed = $line.Trim()
  if (-not $trimmed) { continue }
  try { $events += ($trimmed | ConvertFrom-Json) } catch {}
}

$tree = Get-Content -LiteralPath $treePath | ConvertFrom-Json
$sessions = Get-Content -LiteralPath $sessionsPath | ConvertFrom-Json
$preGate = Get-Content -LiteralPath $preGatePath | ConvertFrom-Json
$nodes = @($tree.nodes)
$nodeById = @{}
foreach ($n in $nodes) { $nodeById[$n.task_id] = $n }

function Get-DispatchOutcome {
  param(
    [object]$dispatchResponse
  )
  if (-not $dispatchResponse) { return $null }
  $results = @($dispatchResponse.results)
  if ($results.Count -eq 0) { return $null }
  return $results[0]
}

$preGateB1 = Get-DispatchOutcome -dispatchResponse $preGate.taskB1
$preGateC = Get-DispatchOutcome -dispatchResponse $preGate.taskC

$preGateB1Blocked = $false
$preGateCBlocked = $false
if ($preGateB1) {
  $reason = [string]$preGateB1.reason
  $preGateB1Blocked = (
    $preGateB1.outcome -eq "task_not_found" -and
    ($reason -like "*dependency gate is closed*" -or $reason -like "*is not runnable for session*")
  )
}
if ($preGateC) {
  $reason = [string]$preGateC.reason
  $preGateCBlocked = (
    $preGateC.outcome -eq "task_not_found" -and
    ($reason -like "*dependency gate is closed*" -or $reason -like "*is not runnable for session*")
  )
}

$hasTaskA = $nodeById.ContainsKey($taskAId)
$hasTaskB = $nodeById.ContainsKey($taskBId)
$hasTaskB1 = $nodeById.ContainsKey($taskB1Id)
$hasTaskC = $nodeById.ContainsKey($taskCId)
$allSeedTasksExist = ($hasTaskA -and $hasTaskB -and $hasTaskB1 -and $hasTaskC)

$seedStructureOk = $false
if ($allSeedTasksExist) {
  $taskA = $nodeById[$taskAId]
  $taskB = $nodeById[$taskBId]
  $taskB1 = $nodeById[$taskB1Id]
  $taskC = $nodeById[$taskCId]

  $seedStructureOk = (
    [string]$taskA.owner_role -eq $roleA -and
    [string]$taskB.owner_role -eq $roleA -and
    [string]$taskB1.owner_role -eq $roleB -and
    [string]$taskB1.parent_task_id -eq $taskBId -and
    [string]$taskC.owner_role -eq $roleC -and
    (@($taskB.dependencies) -contains $taskAId) -and
    (@($taskC.dependencies) -contains $taskBId)
  )
}

$dispatchStarted = @($events | Where-Object { $_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" })
$dispatchedTaskIds = @($dispatchStarted | ForEach-Object { $_.taskId } | Where-Object { $_ })
$b1Dispatched = @($dispatchedTaskIds | Where-Object { $_ -eq $taskB1Id }).Count -gt 0
$cDispatched = @($dispatchedTaskIds | Where-Object { $_ -eq $taskCId }).Count -gt 0
$bAndCDispatched = ($b1Dispatched -and $cDispatched)

$terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
$openExecutionTasks = @(
  $nodes | Where-Object {
    $_.task_kind -eq "EXECUTION" -and $terminalStates -notcontains $_.state
  }
)
$runningSessions = @($sessions.items | Where-Object { $_.status -eq "running" })

$dispatchFailedCount = @($events | Where-Object { $_.eventType -eq "ORCHESTRATOR_DISPATCH_FAILED" }).Count
$actionRejectedCount = @($events | Where-Object { $_.eventType -eq "TASK_ACTION_REJECTED" }).Count

$toolCallLogs = @(
  $events | Where-Object {
    $_.eventType -eq "MINIMAX_LOG" -and
    [string]($_.payload.content) -like "[Tool Call]*"
  }
)
$listDirectoryCalls = @(
  $toolCallLogs | Where-Object { [string]($_.payload.content) -like "[Tool Call] list_directory*" }
).Count
$shellExecuteCalls = @(
  $toolCallLogs | Where-Object { [string]($_.payload.content) -like "[Tool Call] shell_execute*" }
).Count
$allToolCallCount = @($toolCallLogs).Count
$shellExecuteRatio = if ($allToolCallCount -gt 0) { [math]::Round($shellExecuteCalls / $allToolCallCount, 4) } else { 0.0 }

$teamToolCalledCount = @($events | Where-Object { $_.eventType -eq "TEAM_TOOL_CALLED" }).Count
$teamToolSucceededCount = @($events | Where-Object { $_.eventType -eq "TEAM_TOOL_SUCCEEDED" }).Count
$teamToolFailedCount = @($events | Where-Object { $_.eventType -eq "TEAM_TOOL_FAILED" }).Count
$teamToolSuccessRate = if ($teamToolCalledCount -gt 0) {
  [math]::Round($teamToolSucceededCount / $teamToolCalledCount, 4)
} else {
  1.0
}

$checks = @(
  [pscustomobject]@{
    Name = "Seed tasks exist"
    Pass = $allSeedTasksExist
    Detail = "A=$hasTaskA B=$hasTaskB B1=$hasTaskB1 C=$hasTaskC"
  },
  [pscustomobject]@{
    Name = "Seed dependency structure is correct"
    Pass = $seedStructureOk
    Detail = "A->B dependency, B1 child-of-B, C depends on B"
  },
  [pscustomobject]@{
    Name = "Dependency gate blocked B1 before A completion path"
    Pass = $preGateB1Blocked
    Detail = "outcome=$($preGateB1.outcome) reason=$([string]$preGateB1.reason)"
  },
  [pscustomobject]@{
    Name = "Dependency gate blocked C before B completion path"
    Pass = $preGateCBlocked
    Detail = "outcome=$($preGateC.outcome) reason=$([string]$preGateC.reason)"
  },
  [pscustomobject]@{
    Name = "B1 and C were eventually dispatched"
    Pass = $bAndCDispatched
    Detail = "B1_dispatched=$b1Dispatched C_dispatched=$cDispatched"
  },
  [pscustomobject]@{
    Name = "No unresolved execution tasks"
    Pass = (@($openExecutionTasks).Count -eq 0)
    Detail = "open_execution_tasks=$(@($openExecutionTasks).Count)"
  },
  [pscustomobject]@{
    Name = "No running sessions at finish"
    Pass = (@($runningSessions).Count -eq 0)
    Detail = "running_sessions=$(@($runningSessions).Count)"
  },
  [pscustomobject]@{
    Name = "No dispatch failures"
    Pass = ($dispatchFailedCount -eq 0)
    Detail = "dispatch_failed_events=$dispatchFailedCount"
  },
  [pscustomobject]@{
    Name = "No list_directory toolcall noise"
    Pass = ($listDirectoryCalls -eq 0)
    Detail = "list_directory_calls=$listDirectoryCalls"
  },
  [pscustomobject]@{
    Name = "Team tool success rate is healthy"
    Pass = ($teamToolSuccessRate -ge 0.80)
    Detail = "team_tool_success_rate=$teamToolSuccessRate called=$teamToolCalledCount failed=$teamToolFailedCount"
  },
  [pscustomobject]@{
    Name = "shell_execute ratio is controlled"
    Pass = ($shellExecuteRatio -le 0.40)
    Detail = "shell_execute_calls=$shellExecuteCalls total_tool_calls=$allToolCallCount ratio=$shellExecuteRatio"
  }
)

$overallPass = @($checks | Where-Object { -not $_.Pass }).Count -eq 0

$lines = @()
$lines += "# E2E Dispatch Analysis"
$lines += ""
$lines += "- scenario: $($scenario.scenario_id)"
$lines += "- overall_pass: $overallPass"
$lines += "- event_count: $(@($events).Count)"
$lines += "- task_node_count: $(@($nodes).Count)"
$lines += "- task_action_rejected_count: $actionRejectedCount"
$lines += "- team_tool_called: $teamToolCalledCount"
$lines += "- team_tool_succeeded: $teamToolSucceededCount"
$lines += "- team_tool_failed: $teamToolFailedCount"
$lines += "- team_tool_success_rate: $teamToolSuccessRate"
$lines += "- list_directory_calls: $listDirectoryCalls"
$lines += "- shell_execute_calls: $shellExecuteCalls"
$lines += "- all_tool_calls: $allToolCallCount"
$lines += "- shell_execute_ratio: $shellExecuteRatio"
$lines += ""
$lines += "## Checks"
$lines += ""
foreach ($c in $checks) {
  $state = if ($c.Pass) { "PASS" } else { "FAIL" }
  $lines += "- [$state] $($c.Name): $($c.Detail)"
}
$lines += ""
$lines += "## Observability Signals"
$lines += ""
$lines += "- TASK_ACTION_REJECTED: $actionRejectedCount"
$lines += "- ORCHESTRATOR_DISPATCH_FAILED: $dispatchFailedCount"
$lines += "- running_sessions: $(@($runningSessions).Count)"
$lines += "- open_execution_tasks: $(@($openExecutionTasks).Count)"
$lines += "- TEAM_TOOL_CALLED: $teamToolCalledCount"
$lines += "- TEAM_TOOL_SUCCEEDED: $teamToolSucceededCount"
$lines += "- TEAM_TOOL_FAILED: $teamToolFailedCount"
$lines += "- MINIMAX list_directory tool calls: $listDirectoryCalls"
$lines += "- MINIMAX shell_execute ratio: $shellExecuteRatio"
$lines += ""
$lines += "## Notes"
$lines += ""
$lines += "- This scenario seeds A/B/B1/C structure from manager, then validates dependency gating before auto dispatch."
$lines += "- Role D remains registered to observe idle behavior and ensure no unexpected dispatch."

[System.IO.File]::WriteAllLines($OutputPath, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Analysis written to: $OutputPath"
if (-not $overallPass) {
  exit 2
}
