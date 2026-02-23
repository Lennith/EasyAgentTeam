param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [string]$ScenarioPath = "",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\team-discuss-framework.json"
}
if (-not $OutputPath) {
  $OutputPath = Join-Path $ArtifactsDir "analysis.md"
}

$scenario = Get-Content -LiteralPath $ScenarioPath | ConvertFrom-Json
$roles = $scenario.roles
$roleLead = [string]$roles.LEAD
$roleB = [string]$roles.B
$roleC = [string]$roles.C
$roleD = [string]$roles.D

$seed = $scenario.seed_tasks
$taskLeadId = [string]$seed.task_lead_plan.task_id
$taskBId = [string]$seed.task_design_b.task_id
$taskCId = [string]$seed.task_design_c.task_id
$taskDId = [string]$seed.task_design_d.task_id
$taskAlignId = [string]$seed.task_alignment.task_id
$taskFinalId = [string]$seed.task_final.task_id

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
  param([object]$dispatchResponse)
  if (-not $dispatchResponse) { return $null }
  $results = @($dispatchResponse.results)
  if ($results.Count -eq 0) { return $null }
  return $results[0]
}

$preGateB = Get-DispatchOutcome -dispatchResponse $preGate.taskDesignB
$preGateC = Get-DispatchOutcome -dispatchResponse $preGate.taskDesignC
$preGateD = Get-DispatchOutcome -dispatchResponse $preGate.taskDesignD
$invalidParentDependencyCreate = $preGate.invalidParentDependencyCreate

function Is-BlockedByGate {
  param([object]$Outcome)
  if (-not $Outcome) { return $false }
  $reason = [string]$Outcome.reason
  return (
    $Outcome.outcome -eq "task_not_found" -and
    ($reason -like "*dependency gate is closed*" -or $reason -like "*is not runnable for session*")
  )
}

$preGateBBlocked = Is-BlockedByGate -Outcome $preGateB
$preGateCBlocked = Is-BlockedByGate -Outcome $preGateC
$preGateDBlocked = Is-BlockedByGate -Outcome $preGateD
$invalidParentDependencyRejected = (
  [int]$invalidParentDependencyCreate.status -eq 409
)

$requiredTasks = @($taskLeadId, $taskBId, $taskCId, $taskDId, $taskAlignId, $taskFinalId)
$allTasksExist = @($requiredTasks | Where-Object { -not $nodeById.ContainsKey($_) }).Count -eq 0

$structureOk = $false
if ($allTasksExist) {
  $structureOk = (
    [string]$nodeById[$taskLeadId].owner_role -eq $roleLead -and
    [string]$nodeById[$taskBId].owner_role -eq $roleB -and
    [string]$nodeById[$taskCId].owner_role -eq $roleC -and
    [string]$nodeById[$taskDId].owner_role -eq $roleD -and
    [string]$nodeById[$taskAlignId].owner_role -eq $roleLead -and
    [string]$nodeById[$taskFinalId].owner_role -eq $roleLead -and
    (@($nodeById[$taskBId].dependencies) -contains $taskLeadId) -and
    (@($nodeById[$taskCId].dependencies) -contains $taskLeadId) -and
    (@($nodeById[$taskDId].dependencies) -contains $taskLeadId) -and
    (@($nodeById[$taskAlignId].dependencies) -contains $taskBId) -and
    (@($nodeById[$taskAlignId].dependencies) -contains $taskCId) -and
    (@($nodeById[$taskAlignId].dependencies) -contains $taskDId) -and
    (@($nodeById[$taskFinalId].dependencies) -contains $taskAlignId)
  )
}

$dispatchStarted = @($events | Where-Object { $_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" })
$dispatchedIds = @($dispatchStarted | ForEach-Object { $_.taskId } | Where-Object { $_ })
$bDispatched = @($dispatchedIds | Where-Object { $_ -eq $taskBId }).Count -gt 0
$cDispatched = @($dispatchedIds | Where-Object { $_ -eq $taskCId }).Count -gt 0
$dDispatched = @($dispatchedIds | Where-Object { $_ -eq $taskDId }).Count -gt 0
$reviewDispatched = @($dispatchedIds | Where-Object { $_ -eq $taskAlignId }).Count -gt 0

$messageRoutedDiscuss = @(
  $events | Where-Object {
    $_.eventType -eq "MESSAGE_ROUTED" -and
    (
      [string]$_.payload.messageType -eq "TASK_DISCUSS_REQUEST" -or
      [string]$_.payload.messageType -eq "TASK_DISCUSS_REPLY" -or
      [string]$_.payload.messageType -eq "TASK_DISCUSS_CLOSED"
    )
  }
)
$hasDiscussFlow = @($messageRoutedDiscuss).Count -gt 0

$terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
$openExecutionTasks = @(
  $nodes | Where-Object { $_.task_kind -eq "EXECUTION" -and $terminalStates -notcontains $_.state }
)
$runningSessions = @($sessions.items | Where-Object { $_.status -eq "running" })
$dispatchFailedCount = @($events | Where-Object { $_.eventType -eq "ORCHESTRATOR_DISPATCH_FAILED" }).Count

$checks = @(
  [pscustomobject]@{ Name = "Seed tasks exist"; Pass = $allTasksExist; Detail = "required=$($requiredTasks.Count)" },
  [pscustomobject]@{ Name = "Seed structure and dependencies are correct"; Pass = $structureOk; Detail = "lead+3 drafts+alignment+final" },
  [pscustomobject]@{ Name = "Invalid parent dependency create is rejected"; Pass = $invalidParentDependencyRejected; Detail = "status=$([int]$invalidParentDependencyCreate.status) error_code=$([string]$invalidParentDependencyCreate.body.error_code)" },
  [pscustomobject]@{ Name = "Pre-gate blocks B/C/D before lead task completes"; Pass = ($preGateBBlocked -and $preGateCBlocked -and $preGateDBlocked); Detail = "B=$preGateBBlocked C=$preGateCBlocked D=$preGateDBlocked" },
  [pscustomobject]@{ Name = "Three draft tasks were eventually dispatched"; Pass = ($bDispatched -and $cDispatched -and $dDispatched); Detail = "B=$bDispatched C=$cDispatched D=$dDispatched" },
  [pscustomobject]@{ Name = "Alignment task was dispatched"; Pass = $reviewDispatched; Detail = "alignment_dispatched=$reviewDispatched" },
  [pscustomobject]@{ Name = "Discuss flow exists"; Pass = $hasDiscussFlow; Detail = "message_routed_discuss_count=$(@($messageRoutedDiscuss).Count)" },
  [pscustomobject]@{ Name = "No unresolved execution tasks"; Pass = (@($openExecutionTasks).Count -eq 0); Detail = "open_execution_tasks=$(@($openExecutionTasks).Count)" },
  [pscustomobject]@{ Name = "No running sessions at finish"; Pass = (@($runningSessions).Count -eq 0); Detail = "running_sessions=$(@($runningSessions).Count)" },
  [pscustomobject]@{ Name = "No dispatch failures"; Pass = ($dispatchFailedCount -eq 0); Detail = "dispatch_failed_events=$dispatchFailedCount" }
)

$overallPass = @($checks | Where-Object { -not $_.Pass }).Count -eq 0

$lines = @()
$lines += "# E2E Discuss Analysis"
$lines += ""
$lines += "- scenario: $($scenario.scenario_id)"
$lines += "- overall_pass: $overallPass"
$lines += "- event_count: $(@($events).Count)"
$lines += "- task_node_count: $(@($nodes).Count)"
$lines += "- discuss_message_routed_count: $(@($messageRoutedDiscuss).Count)"
$lines += ""
$lines += "## Checks"
$lines += ""
foreach ($c in $checks) {
  $state = if ($c.Pass) { "PASS" } else { "FAIL" }
  $lines += "- [$state] $($c.Name): $($c.Detail)"
}
$lines += ""
$lines += "## Notes"
$lines += ""
$lines += "- This scenario validates multi-agent design discussion convergence under task dependencies."
$lines += "- Lead can start alignment only after all three architecture draft tasks are completed."

[System.IO.File]::WriteAllLines($OutputPath, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Analysis written to: $OutputPath"
if (-not $overallPass) {
  exit 2
}
