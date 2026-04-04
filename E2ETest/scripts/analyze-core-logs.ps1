param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [string]$ScenarioPath = "",
  [string]$OutputPath = "",
  [string]$FinalReasonHint = "",
  [string]$WorkspaceRoot = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

function Write-Utf8NoBomWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Lines,
    [int]$RetryCount = 10,
    [int]$RetryDelayMs = 200
  )
  $content = $Lines -join [Environment]::NewLine
  for ($attempt = 1; $attempt -le $RetryCount; $attempt++) {
    try {
      [System.IO.File]::WriteAllText($Path, $content, [System.Text.UTF8Encoding]::new($false))
      return
    } catch [System.IO.IOException] {
      if ($attempt -ge $RetryCount) { throw }
      Start-Sleep -Milliseconds $RetryDelayMs
    } catch [System.UnauthorizedAccessException] {
      if ($attempt -ge $RetryCount) { throw }
      Start-Sleep -Milliseconds $RetryDelayMs
    }
  }
}

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\a-self-decompose-chain.json"
}
if (-not $OutputPath) {
  $OutputPath = Join-Path $ArtifactsDir "analysis.md"
}

$scenario = Get-Content -LiteralPath $ScenarioPath -Raw | ConvertFrom-Json
$roles = $scenario.roles
$roleA = [string]$roles.A
$roleB = [string]$roles.B
$roleC = [string]$roles.C
$roleD = [string]$roles.D
$reminderProbe = $scenario.reminder_probe
$roleByRef = @{ A = $roleA; B = $roleB; C = $roleC; D = $roleD }

$taskAId = [string]$scenario.seed_tasks.task_a.task_id
$taskBId = [string]$scenario.seed_tasks.task_b_placeholder.task_id
$taskB1Id = [string]$scenario.seed_tasks.task_b1_child.task_id
$taskCId = [string]$scenario.seed_tasks.task_c.task_id
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
$stabilityPath = Join-Path $ArtifactsDir "stability_metrics.json"

foreach ($required in @($eventsPath, $treePath, $sessionsPath, $preGatePath, $topupLogPath, $reminderPath, $stabilityPath)) {
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
$stability = Get-Content -LiteralPath $stabilityPath -Raw | ConvertFrom-Json

$finalReason = [string]$FinalReasonHint
if ([string]::IsNullOrWhiteSpace($finalReason) -and (Test-Path -LiteralPath $runSummaryPath)) {
  $summaryLines = Get-Content -LiteralPath $runSummaryPath
  $finalReasonLine = @($summaryLines | Where-Object { $_ -like "- final_reason:*" } | Select-Object -First 1)
  if ($finalReasonLine.Count -gt 0) {
    $finalReason = ($finalReasonLine -replace '^- final_reason:\s*', '').Trim()
  }
}

$workspacePath = [string]$WorkspaceRoot
if ([string]::IsNullOrWhiteSpace($workspacePath) -and (Test-Path -LiteralPath $runSummaryPath)) {
  $summaryLines = Get-Content -LiteralPath $runSummaryPath
  $workspaceLine = @($summaryLines | Where-Object { $_ -match "^\s*-\s*workspace:" } | Select-Object -First 1)
  if ($workspaceLine.Count -gt 0) {
    $workspacePath = (([string]$workspaceLine[0]) -replace '^\s*-\s*workspace:\s*', '').Trim()
  }
}
$probeArtifactRelativePath = "docs\e2e\standard_reminder_probe.md"
$probeArtifactPath = if ([string]::IsNullOrWhiteSpace($workspacePath)) { "" } else { Join-Path $workspacePath $probeArtifactRelativePath }
$probeArtifactExists = if ([string]::IsNullOrWhiteSpace($probeArtifactPath)) { $false } else { Test-Path -LiteralPath $probeArtifactPath }

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

function Get-EventTimestampMs {
  param([object]$Event)
  if (-not $Event) {
    return 0
  }
  try {
    return [DateTimeOffset]::Parse([string]$Event.createdAt).ToUnixTimeMilliseconds()
  } catch {
    return 0
  }
}

$preGateB1 = Get-DispatchOutcome -dispatchResponse $preGate.taskB1
$preGateC = Get-DispatchOutcome -dispatchResponse $preGate.taskC

$preGateB1Blocked = $false
$preGateCBlocked = $false
if ($preGateB1) {
  $reason = [string]$preGateB1.reason
  $preGateB1Blocked = ($preGateB1.outcome -eq "task_not_found" -and ($reason -like "*dependency gate is closed*" -or $reason -like "*is not runnable for session*"))
}
if ($preGateC) {
  $reason = [string]$preGateC.reason
  $preGateCBlocked = ($preGateC.outcome -eq "task_not_found" -and ($reason -like "*dependency gate is closed*" -or $reason -like "*is not runnable for session*"))
}

$requiredIds = @($taskAId, $taskBId, $taskB1Id, $taskCId, $probeTaskId, $gateTaskId)
$allSeedTasksExist = @($requiredIds | Where-Object { -not $nodeById.ContainsKey($_) }).Count -eq 0

$seedStructureOk = $false
if ($allSeedTasksExist) {
  $taskA = $nodeById[$taskAId]
  $taskB = $nodeById[$taskBId]
  $taskB1 = $nodeById[$taskB1Id]
  $taskC = $nodeById[$taskCId]
  $probeTask = $nodeById[$probeTaskId]
  $gateTask = $nodeById[$gateTaskId]
  $seedStructureOk = (
    [string]$taskA.owner_role -eq $roleA -and
    [string]$taskB.owner_role -eq $roleA -and
    [string]$taskB1.owner_role -eq $roleB -and
    [string]$taskB1.parent_task_id -eq $taskBId -and
    [string]$taskC.owner_role -eq $roleC -and
    [string]$probeTask.owner_role -eq $probeRole -and
    [string]$gateTask.owner_role -eq "manager" -and
    (@($taskA.dependencies) -contains $gateTaskId) -and
    (@($taskB.dependencies) -contains $taskAId) -and
    (@($taskC.dependencies) -contains $taskBId)
  )
}

$dispatchStarted = @($events | Where-Object { $_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" })
$dispatchedTaskIds = @($dispatchStarted | ForEach-Object { $_.taskId } | Where-Object { $_ })
$b1Dispatched = @($dispatchedTaskIds | Where-Object { $_ -eq $taskB1Id }).Count -gt 0
$cDispatched = @($dispatchedTaskIds | Where-Object { $_ -eq $taskCId }).Count -gt 0
$terminalStates = @("DONE", "CANCELED")
$b1Terminal = $nodeById.ContainsKey($taskB1Id) -and $terminalStates -contains [string]$nodeById[$taskB1Id].state
$cTerminal = $nodeById.ContainsKey($taskCId) -and $terminalStates -contains [string]$nodeById[$taskCId].state
$bAndCReached = (($b1Dispatched -or $b1Terminal) -and ($cDispatched -or $cTerminal))

$openExecutionTasks = @($nodes | Where-Object { $_.task_kind -eq "EXECUTION" -and $terminalStates -notcontains $_.state })
$runningSessions = @($sessions.items | Where-Object { $_.status -eq "running" })
$dispatchFailedEvents = @($events | Where-Object { $_.eventType -eq "ORCHESTRATOR_DISPATCH_FAILED" })
$dispatchFailedCount = @($dispatchFailedEvents).Count
$dispatchFailureClassifications = @()
foreach ($dispatchFailed in $dispatchFailedEvents) {
  $taskId = [string]$dispatchFailed.taskId
  $dispatchId = [string]$dispatchFailed.payload.dispatchId
  $failedAtMs = Get-EventTimestampMs -Event $dispatchFailed
  $hasReportBeforeFail = @(
    $events | Where-Object {
      $_.eventType -eq "TASK_REPORT_APPLIED" -and
      [string]$_.taskId -eq $taskId -and
      (Get-EventTimestampMs -Event $_) -le $failedAtMs
    }
  ).Count -gt 0
  $hasDispatchStarted = if ([string]::IsNullOrWhiteSpace($dispatchId)) {
    $false
  } else {
    @(
      $events | Where-Object {
        $_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" -and
        [string]$_.payload.dispatchId -eq $dispatchId
      }
    ).Count -gt 0
  }
  $hasFatalDismissed = if ([string]::IsNullOrWhiteSpace($dispatchId)) {
    $false
  } else {
    @(
      $events | Where-Object {
        $_.eventType -eq "RUNNER_FATAL_ERROR_DISMISSED" -and
        [string]$_.payload.dispatchId -eq $dispatchId
      }
    ).Count -gt 0
  }
  $finalState = if ($nodeById.ContainsKey($taskId)) { [string]$nodeById[$taskId].state } else { "MISSING" }
  $recoverable = ($hasReportBeforeFail -and $finalState -eq "DONE")
  $dispatchFailureClassifications += [pscustomobject]@{
    task_id = $taskId
    dispatch_id = $dispatchId
    recoverable = $recoverable
    has_report_before_fail = $hasReportBeforeFail
    has_dispatch_started = $hasDispatchStarted
    has_fatal_dismissed = $hasFatalDismissed
    final_state = $finalState
    error = [string]$dispatchFailed.payload.error
  }
}
$recoverableDispatchFailedCount = @($dispatchFailureClassifications | Where-Object { $_.recoverable }).Count
$unrecoveredDispatchFailures = @($dispatchFailureClassifications | Where-Object { -not $_.recoverable })
$unrecoveredDispatchFailedCount = @($unrecoveredDispatchFailures).Count
$actionRejectedCount = @($events | Where-Object { $_.eventType -eq "TASK_ACTION_REJECTED" }).Count

$toolCallLogs = @($events | Where-Object { $_.eventType -eq "MINIMAX_LOG" -and [string]($_.payload.content) -like "[Tool Call]*" })
$listDirectoryCalls = @($toolCallLogs | Where-Object { [string]($_.payload.content) -like "[Tool Call] list_directory*" }).Count
$shellExecuteCalls = @($toolCallLogs | Where-Object { [string]($_.payload.content) -like "[Tool Call] shell_execute*" }).Count
$allToolCallCount = @($toolCallLogs).Count
$shellExecuteRatio = if ($allToolCallCount -gt 0) { [math]::Round($shellExecuteCalls / $allToolCallCount, 4) } else { 0.0 }

$teamToolCalledCount = @($events | Where-Object { $_.eventType -eq "TEAM_TOOL_CALLED" }).Count
$teamToolSucceededCount = @($events | Where-Object { $_.eventType -eq "TEAM_TOOL_SUCCEEDED" }).Count
$teamToolFailedCount = @($events | Where-Object { $_.eventType -eq "TEAM_TOOL_FAILED" }).Count
$teamToolSuccessRate = if ($teamToolCalledCount -gt 0) { [math]::Round($teamToolSucceededCount / $teamToolCalledCount, 4) } else { 1.0 }
$stabilityFields = @("case_id", "start_time", "end_time", "exit_code", "toolcall_failed_count", "toolcall_failed_timestamps", "timeout_recovered_count", "timeout_recovered_timestamps", "fallback_events", "final_pass", "final_reason")
$stabilityMissing = @()
foreach ($f in $stabilityFields) {
  if (-not ($stability.PSObject.Properties.Name -contains $f)) {
    $stabilityMissing += $f
  }
}
$stabilityComplete = ($stabilityMissing.Count -eq 0)

$checks = @(
  [pscustomobject]@{ Name = "Seed tasks exist"; Pass = $allSeedTasksExist; Detail = "A/B/B1/C + reminder probe/gate exist" },
  [pscustomobject]@{ Name = "Seed dependency structure is correct"; Pass = $seedStructureOk; Detail = "A depends on reminder gate; B depends on A; B1 child-of-B; C depends on B" },
  [pscustomobject]@{ Name = "Dependency gate blocked B1 before A completion path"; Pass = $preGateB1Blocked; Detail = "outcome=$($preGateB1.outcome) reason=$([string]$preGateB1.reason)" },
  [pscustomobject]@{ Name = "Dependency gate blocked C before B completion path"; Pass = $preGateCBlocked; Detail = "outcome=$($preGateC.outcome) reason=$([string]$preGateC.reason)" },
  [pscustomobject]@{ Name = "Reminder probe triggered for designated role"; Pass = [bool]$reminderResult.evidence.trigger_pass; Detail = "role=$probeRole trigger_count=$($reminderResult.evidence.reminder_trigger_count)" },
  [pscustomobject]@{ Name = "Reminder probe was redispatched after trigger"; Pass = [bool]$reminderResult.evidence.dispatch_pass; Detail = "task_id=$probeTaskId dispatch_count=$($reminderResult.evidence.message_dispatch_count) reminder_redispatch_count=$($reminderResult.evidence.redispatch_count)" },
  [pscustomobject]@{ Name = "Reminder probe role later progressed task"; Pass = [bool]$reminderResult.evidence.progress_pass; Detail = "report_applied_count=$($reminderResult.evidence.report_applied_count) probe_state=$($reminderResult.evidence.probe_state)" },
  [pscustomobject]@{ Name = "Reminder probe artifact exists"; Pass = $probeArtifactExists; Detail = "path=$probeArtifactPath" },
  [pscustomobject]@{ Name = "B1 and C were eventually reached (dispatched or terminal)"; Pass = $bAndCReached; Detail = "B1_dispatched=$b1Dispatched B1_terminal=$b1Terminal C_dispatched=$cDispatched C_terminal=$cTerminal" },
  [pscustomobject]@{ Name = "No unresolved execution tasks"; Pass = (@($openExecutionTasks).Count -eq 0); Detail = "open_execution_tasks=$(@($openExecutionTasks).Count)" },
  [pscustomobject]@{ Name = "No running sessions at finish"; Pass = (@($runningSessions).Count -eq 0); Detail = "running_sessions=$(@($runningSessions).Count)" },
  [pscustomobject]@{ Name = "No unrecovered dispatch failures"; Pass = ($unrecoveredDispatchFailedCount -eq 0); Detail = "dispatch_failed_total=$dispatchFailedCount recoverable=$recoverableDispatchFailedCount unrecovered=$unrecoveredDispatchFailedCount" },
  [pscustomobject]@{ Name = "No list_directory toolcall noise"; Pass = ($listDirectoryCalls -eq 0); Detail = "list_directory_calls=$listDirectoryCalls" },
  [pscustomobject]@{ Name = "Team tool success rate is healthy"; Pass = ($teamToolSuccessRate -ge 0.70); Detail = "team_tool_success_rate=$teamToolSuccessRate threshold=0.70 called=$teamToolCalledCount failed=$teamToolFailedCount" },
  [pscustomobject]@{ Name = "shell_execute ratio is controlled"; Pass = ($shellExecuteRatio -le 0.40); Detail = "shell_execute_calls=$shellExecuteCalls total_tool_calls=$allToolCallCount ratio=$shellExecuteRatio" },
  [pscustomobject]@{ Name = "Topup run ends with explicit reason"; Pass = $topupReasonExplicit; Detail = "topup_count=$topupCount final_reason=$finalReason" },
  [pscustomobject]@{ Name = "Stability metrics schema is complete"; Pass = $stabilityComplete; Detail = "missing_fields=$($stabilityMissing -join ',')" }
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
$lines += "- dispatch_failed_total: $dispatchFailedCount"
$lines += "- dispatch_failed_recoverable: $recoverableDispatchFailedCount"
$lines += "- dispatch_failed_unrecovered: $unrecoveredDispatchFailedCount"
$lines += "- team_tool_called: $teamToolCalledCount"
$lines += "- team_tool_succeeded: $teamToolSucceededCount"
$lines += "- team_tool_failed: $teamToolFailedCount"
$lines += "- team_tool_success_rate: $teamToolSuccessRate"
$lines += "- list_directory_calls: $listDirectoryCalls"
$lines += "- shell_execute_calls: $shellExecuteCalls"
$lines += "- all_tool_calls: $allToolCallCount"
$lines += "- shell_execute_ratio: $shellExecuteRatio"
$lines += "- topup_count: $topupCount"
$lines += "- stability_toolcall_failed_count: $([int]$stability.toolcall_failed_count)"
$lines += "- stability_timeout_recovered_count: $([int]$stability.timeout_recovered_count)"
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
$lines += "- This scenario embeds reminder validation before the main dependency chain is released."
$lines += "- Role D owns the reminder probe task; manager-owned gate task blocks Task A until reminder redispatch is observed."
if ($dispatchFailedCount -gt 0) {
  $lines += "- Dispatch failure breakdown: total=$dispatchFailedCount, recoverable=$recoverableDispatchFailedCount, unrecovered=$unrecoveredDispatchFailedCount."
  foreach ($item in $dispatchFailureClassifications) {
    $lines += "- dispatch_failure task=$($item.task_id) recoverable=$($item.recoverable) final_state=$($item.final_state) has_report_before_fail=$($item.has_report_before_fail) has_fatal_dismissed=$($item.has_fatal_dismissed) error=$($item.error)"
  }
}

Write-Utf8NoBomWithRetry -Path $OutputPath -Lines $lines
Write-Host "Analysis written to: $OutputPath"
if (-not $overallPass) {
  exit 2
}
