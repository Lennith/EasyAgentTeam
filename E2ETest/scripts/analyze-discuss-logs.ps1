param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [string]$ScenarioPath = "",
  [string]$OutputPath = "",
  [string]$FinalReasonHint = ""
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

$scenario = Get-Content -LiteralPath $ScenarioPath -Raw | ConvertFrom-Json
$roles = $scenario.roles
$roleLead = [string]$roles.LEAD
$roleB = [string]$roles.B
$roleC = [string]$roles.C
$roleD = [string]$roles.D
$reminderProbe = $scenario.reminder_probe
$roleByRef = @{ LEAD = $roleLead; B = $roleB; C = $roleC; D = $roleD }

$seed = $scenario.seed_tasks
$taskLeadId = [string]$seed.task_lead_plan.task_id
$taskBId = [string]$seed.task_design_b.task_id
$taskCId = [string]$seed.task_design_c.task_id
$taskDId = [string]$seed.task_design_d.task_id
$taskAlignId = [string]$seed.task_alignment.task_id
$taskFinalId = [string]$seed.task_final.task_id
$probeTaskId = [string]$reminderProbe.probe_task_id
$gateTaskId = [string]$reminderProbe.gate_task_id
$probeRole = [string]$roleByRef[[string]$reminderProbe.blocked_role_ref]

$eventsPath = Join-Path $ArtifactsDir "events.ndjson"
$treePath = Join-Path $ArtifactsDir "task_tree_final.json"
$sessionsPath = Join-Path $ArtifactsDir "sessions_final.json"
$preGatePath = Join-Path $ArtifactsDir "pre_gate_checks.json"
$topupLogPath = Join-Path $ArtifactsDir "topup_log.json"
$reminderPath = Join-Path $ArtifactsDir "reminder_probe.json"
$runSummaryPath = Join-Path $ArtifactsDir "run_summary.md"

foreach ($required in @($eventsPath, $treePath, $sessionsPath, $preGatePath, $topupLogPath, $reminderPath)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Required artifact not found: $required"
  }
}

$events = @()
foreach ($line in (Get-Content -LiteralPath $eventsPath)) {
  $trimmed = $line.Trim()
  if (-not $trimmed) { continue }
  try { $events += ($trimmed | ConvertFrom-Json) } catch {}
}
$tree = Get-Content -LiteralPath $treePath -Raw | ConvertFrom-Json
$sessions = Get-Content -LiteralPath $sessionsPath -Raw | ConvertFrom-Json
$preGate = Get-Content -LiteralPath $preGatePath -Raw | ConvertFrom-Json
$topupLog = @((Get-Content -LiteralPath $topupLogPath -Raw | ConvertFrom-Json))
$reminderResult = Get-Content -LiteralPath $reminderPath -Raw | ConvertFrom-Json

$finalReason = [string]$FinalReasonHint
if ([string]::IsNullOrWhiteSpace($finalReason) -and (Test-Path -LiteralPath $runSummaryPath)) {
  $summaryLines = Get-Content -LiteralPath $runSummaryPath
  $finalReasonLine = @($summaryLines | Where-Object { $_ -like "- final_reason:*" } | Select-Object -First 1)
  if ($finalReasonLine.Count -gt 0) {
    $finalReason = ($finalReasonLine -replace '^- final_reason:\s*', '').Trim()
  }
}

$topupCount = @($topupLog).Count
$topupReasonExplicit = if ($topupCount -eq 0) { $true } else { @("closed_loop", "max_topups_reached", "max_total_budget_reached", "timeout") -contains $finalReason }

$nodes = @($tree.nodes)
$nodeById = @{}
foreach ($n in $nodes) { $nodeById[[string]$n.task_id] = $n }

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
  return ($Outcome.outcome -eq "task_not_found" -and ($reason -like "*dependency gate is closed*" -or $reason -like "*is not runnable for session*"))
}

$preGateBBlocked = Is-BlockedByGate -Outcome $preGateB
$preGateCBlocked = Is-BlockedByGate -Outcome $preGateC
$preGateDBlocked = Is-BlockedByGate -Outcome $preGateD
$preGateDProbeOccupied = ($preGateD -and [string]$preGateD.outcome -eq "dispatched" -and [string]$preGateD.taskId -eq $probeTaskId)
$invalidParentDependencyRejected = ([int]$invalidParentDependencyCreate.status -eq 409)

$requiredTasks = @($taskLeadId, $taskBId, $taskCId, $taskDId, $taskAlignId, $taskFinalId, $probeTaskId, $gateTaskId)
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
    [string]$nodeById[$probeTaskId].owner_role -eq $probeRole -and
    [string]$nodeById[$gateTaskId].owner_role -eq "manager" -and
    (@($nodeById[$taskLeadId].dependencies) -contains $gateTaskId) -and
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

$terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
$bTerminal = $nodeById.ContainsKey($taskBId) -and $terminalStates -contains [string]$nodeById[$taskBId].state
$cTerminal = $nodeById.ContainsKey($taskCId) -and $terminalStates -contains [string]$nodeById[$taskCId].state
$dTerminal = $nodeById.ContainsKey($taskDId) -and $terminalStates -contains [string]$nodeById[$taskDId].state
$alignTerminal = $nodeById.ContainsKey($taskAlignId) -and $terminalStates -contains [string]$nodeById[$taskAlignId].state
$draftsReached = (($bDispatched -or $bTerminal) -and ($cDispatched -or $cTerminal) -and ($dDispatched -or $dTerminal))
$alignReached = ($reviewDispatched -or $alignTerminal)

$messageRoutedDiscuss = @($events | Where-Object {
    $_.eventType -eq "MESSAGE_ROUTED" -and (
      [string]$_.payload.messageType -eq "TASK_DISCUSS_REQUEST" -or
      [string]$_.payload.messageType -eq "TASK_DISCUSS_REPLY" -or
      [string]$_.payload.messageType -eq "TASK_DISCUSS_CLOSED"
    )
  })
$hasDiscussFlow = @($messageRoutedDiscuss).Count -gt 0

$openExecutionTasks = @($nodes | Where-Object { $_.task_kind -eq "EXECUTION" -and $terminalStates -notcontains $_.state })
$runningSessions = @($sessions.items | Where-Object { $_.status -eq "running" })
$dispatchFailedCount = @($events | Where-Object { $_.eventType -eq "ORCHESTRATOR_DISPATCH_FAILED" }).Count
$dispatchRecovered = ($dispatchFailedCount -gt 0 -and @($openExecutionTasks).Count -eq 0 -and @($runningSessions).Count -eq 0 -and $finalReason -eq "closed_loop")

$checks = @(
  [pscustomobject]@{ Name = "Seed tasks exist"; Pass = $allTasksExist; Detail = "required=$($requiredTasks.Count) includes reminder probe/gate" },
  [pscustomobject]@{ Name = "Seed structure and dependencies are correct"; Pass = $structureOk; Detail = "lead+3 drafts+alignment+final with reminder gate" },
  [pscustomobject]@{ Name = "Invalid parent dependency create is rejected"; Pass = $invalidParentDependencyRejected; Detail = "status=$([int]$invalidParentDependencyCreate.status) error_code=$([string]$invalidParentDependencyCreate.body.error_code)" },
  [pscustomobject]@{ Name = "Pre-gate blocks B/C and keeps D occupied by reminder probe before lead task completes"; Pass = ($preGateBBlocked -and $preGateCBlocked -and ($preGateDBlocked -or $preGateDProbeOccupied)); Detail = "B=$preGateBBlocked C=$preGateCBlocked D_blocked=$preGateDBlocked D_probe_occupied=$preGateDProbeOccupied" },
  [pscustomobject]@{ Name = "Reminder probe triggered for designated role"; Pass = [bool]$reminderResult.evidence.trigger_pass; Detail = "role=$probeRole trigger_count=$($reminderResult.evidence.reminder_trigger_count)" },
  [pscustomobject]@{ Name = "Reminder probe was redispatched after trigger"; Pass = [bool]$reminderResult.evidence.dispatch_pass; Detail = "task_id=$probeTaskId dispatch_count=$($reminderResult.evidence.message_dispatch_count) reminder_redispatch_count=$($reminderResult.evidence.redispatch_count)" },
  [pscustomobject]@{ Name = "Reminder probe role later progressed task"; Pass = [bool]$reminderResult.evidence.progress_pass; Detail = "report_applied_count=$($reminderResult.evidence.report_applied_count) probe_state=$($reminderResult.evidence.probe_state)" },
  [pscustomobject]@{ Name = "Three draft tasks were eventually reached (dispatched or terminal)"; Pass = $draftsReached; Detail = "B_dispatched=$bDispatched B_terminal=$bTerminal C_dispatched=$cDispatched C_terminal=$cTerminal D_dispatched=$dDispatched D_terminal=$dTerminal" },
  [pscustomobject]@{ Name = "Alignment task was reached (dispatched or terminal)"; Pass = $alignReached; Detail = "alignment_dispatched=$reviewDispatched alignment_terminal=$alignTerminal" },
  [pscustomobject]@{ Name = "Discuss flow exists"; Pass = $hasDiscussFlow; Detail = "message_routed_discuss_count=$(@($messageRoutedDiscuss).Count)" },
  [pscustomobject]@{ Name = "No unresolved execution tasks"; Pass = (@($openExecutionTasks).Count -eq 0); Detail = "open_execution_tasks=$(@($openExecutionTasks).Count)" },
  [pscustomobject]@{ Name = "No running sessions at finish"; Pass = (@($runningSessions).Count -eq 0); Detail = "running_sessions=$(@($runningSessions).Count)" },
  [pscustomobject]@{ Name = "Dispatch failures are either absent or fully recovered"; Pass = ($dispatchFailedCount -eq 0 -or $dispatchRecovered); Detail = "dispatch_failed_events=$dispatchFailedCount recovered=$dispatchRecovered" },
  [pscustomobject]@{ Name = "Topup run ends with explicit reason"; Pass = $topupReasonExplicit; Detail = "topup_count=$topupCount final_reason=$finalReason" }
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
$lines += "- topup_count: $topupCount"
$lines += "- final_reason: $finalReason"
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
$lines += "- This scenario embeds reminder validation before the lead planning task is released."
$lines += "- Reminder probe belongs to role D and must wake back up through message redispatch before normal discuss flow continues."

[System.IO.File]::WriteAllLines($OutputPath, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Analysis written to: $OutputPath"
if (-not $overallPass) {
  exit 2
}
