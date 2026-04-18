param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$ScenarioPath = "",
  [ValidateSet("", "codex", "minimax")]
  [string]$ProviderId = "",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestRound20",
  [int]$AutoDispatchBudget = 30,
  [int]$MaxMinutes = 75,
  [int]$PollSeconds = 30,
  [int]$AutoTopupStep = 30,
  [int]$MaxTopups = 10,
  [int]$MaxTotalBudget = 330,
  [switch]$SetupOnly,
  [switch]$StrictObserve
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $scriptDir "invoke-api.ps1")
. (Join-Path $scriptDir "e2e-provider-matrix.ps1")
. (Join-Path $scriptDir "e2e-settings-isolation.ps1")

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\a-self-decompose-chain.json"
}

if (-not (Test-Path -LiteralPath $ScenarioPath)) {
  throw "Scenario file not found: $ScenarioPath"
}

$scenario = Get-Content -LiteralPath $ScenarioPath -Encoding UTF8 -Raw | ConvertFrom-Json
$projectId = [string]$scenario.project_id
$projectName = [string]$scenario.project_name
$seedTasks = $scenario.seed_tasks
$roles = $scenario.roles
$routeTable = $scenario.route_table
$taskAssignRouteTable = $scenario.task_assign_route_table
$routeDiscussRounds = $scenario.route_discuss_rounds
$reminderProbe = $scenario.reminder_probe

$roleA = [string]$roles.A
$roleB = [string]$roles.B
$roleC = [string]$roles.C
$roleD = [string]$roles.D
$roleList = @($roleA, $roleB, $roleC, $roleD)
$roleByRef = @{
  A = $roleA
  B = $roleB
  C = $roleC
  D = $roleD
}
$resolvedMatrix = Resolve-E2ERoleModelMatrix -Scenario $scenario -RoleByKey $roleByRef -ForcedProviderId $ProviderId
$providerModeLabel = if ($resolvedMatrix.mode -eq "forced_provider") { [string]$resolvedMatrix.forced_provider_id } else { "mixed" }
Assert-E2EMixedProviderBaseline -ResolvedMatrix $resolvedMatrix -CaseId "chain"

$workspace = $WorkspaceRoot
$artifactsBase = Join-Path $workspace "docs\e2e"
$strictMode = $StrictObserve.IsPresent
$scriptRunStart = Get-Date
$script:stabilityFallbackEvents = @()
$script:stabilityOutDir = $null
$script:stabilityCaseId = "chain"
$script:settingsIsolationPlan = $null
$script:settingsIsolationApplyAudit = $null
$script:settingsIsolationRestoreAudit = $null
$finalReason = "not_started"
$pass = $false
$analysisExit = 1

function Get-ResolvedRoleModelConfig {
  param(
    [Parameter(Mandatory = $true)][string]$RoleId
  )

  $config = $resolvedMatrix.by_role_id[$RoleId]
  if (-not $config) {
    throw "Missing resolved agent model config for role '$RoleId'."
  }
  return $config
}

function Build-ProviderSessionAudit {
  param(
    [Parameter(Mandatory = $true)][object]$SessionsBody
  )

  $items = if ($SessionsBody -and $SessionsBody.items) { @($SessionsBody.items) } else { @() }
  $auditItems = @()
  $mismatches = @()
  foreach ($role in $roleList) {
    $expected = Get-ResolvedRoleModelConfig -RoleId $role
    $session = @($items | Where-Object { [string]$_.role -eq $role } | Select-Object -First 1)[0]
    $actualProvider = if ($session) { ([string]$session.provider).Trim().ToLower() } else { "" }
    $matches = ($session -and $actualProvider -eq [string]$expected.provider_id)
    $auditItems += [ordered]@{
      role_id = $role
      role_key = [string]$expected.role_key
      expected_provider_id = [string]$expected.provider_id
      actual_provider_id = if ($session) { $actualProvider } else { $null }
      model = [string]$expected.model
      effort = [string]$expected.effort
      session_id = if ($session) { [string]$session.sessionId } else { $null }
      status = if ($session) { [string]$session.status } else { $null }
      provider_matches = [bool]$matches
    }
    if (-not $matches) {
      $mismatches += [ordered]@{
        role_id = $role
        expected_provider_id = [string]$expected.provider_id
        actual_provider_id = if ($session) { $actualProvider } else { $null }
        session_id = if ($session) { [string]$session.sessionId } else { $null }
      }
    }
  }
  return [ordered]@{
    mode = [string]$resolvedMatrix.mode
    providers = @($resolvedMatrix.providers)
    all_sessions_match = ($mismatches.Count -eq 0)
    items = $auditItems
    mismatches = $mismatches
  }
}

function Build-ProjectProviderActivitySummary {
  param(
    [Parameter(Mandatory = $true)][object]$SessionAudit
  )

  $eventsPath = Join-Path $repoRoot "data\projects\$projectId\collab\events.jsonl"
  $agentOutputPath = Join-Path $repoRoot "data\projects\$projectId\collab\audit\agent_output.jsonl"
  $events = @()
  if (Test-Path -LiteralPath $eventsPath) {
    foreach ($line in (Get-Content -LiteralPath $eventsPath)) {
      $trimmed = $line.Trim()
      if (-not $trimmed) { continue }
      try { $events += ($trimmed | ConvertFrom-Json) } catch {}
    }
  }
  $agentOutput = @()
  if (Test-Path -LiteralPath $agentOutputPath) {
    foreach ($line in (Get-Content -LiteralPath $agentOutputPath)) {
      $trimmed = $line.Trim()
      if (-not $trimmed) { continue }
      try { $agentOutput += ($trimmed | ConvertFrom-Json) } catch {}
    }
  }

  $providerItems = @()
  foreach ($providerIdValue in @("codex", "minimax")) {
    $rolesForProvider = @(
      $roleList | Where-Object { ([string](Get-ResolvedRoleModelConfig -RoleId $_).provider_id) -eq $providerIdValue }
    )
    if ($rolesForProvider.Count -eq 0) {
      continue
    }
    $roleItems = @()
    foreach ($role in $rolesForProvider) {
      $expected = Get-ResolvedRoleModelConfig -RoleId $role
      $auditItem = @($SessionAudit.items | Where-Object { [string]$_.role_id -eq $role } | Select-Object -First 1)[0]
      $sessionId = if ($auditItem) { [string]$auditItem.session_id } else { "" }
      $startedCount = 0
      $finishedCount = 0
      $agentOutputLines = 0
      $providerRunStartedEvents = @()
      $observedRunConfig = [ordered]@{
        observed_models = @()
        observed_efforts = @()
      }
      if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
        $providerRunStartedEvents = if ($providerIdValue -eq "codex") {
          @($events | Where-Object { [string]$_.eventType -eq "CODEX_RUN_STARTED" -and [string]$_.sessionId -eq $sessionId })
        } else {
          @($events | Where-Object { [string]$_.eventType -eq "MINIMAX_RUN_STARTED" -and [string]$_.sessionId -eq $sessionId })
        }
        $startedCount = @($providerRunStartedEvents).Count
        $finishedCount = if ($providerIdValue -eq "codex") {
          @($events | Where-Object { [string]$_.eventType -eq "CODEX_RUN_FINISHED" -and [string]$_.sessionId -eq $sessionId }).Count
        } else {
          @($events | Where-Object { [string]$_.eventType -eq "MINIMAX_RUN_FINISHED" -and [string]$_.sessionId -eq $sessionId }).Count
        }
        $agentOutputLines = @($agentOutput | Where-Object { [string]$_.sessionId -eq $sessionId }).Count
        $observedRunConfig = if ($providerIdValue -eq "codex") {
          Get-E2ECodexObservedRunConfig -Events $providerRunStartedEvents
        } else {
          Get-E2EMiniMaxObservedRunConfig -Events $providerRunStartedEvents
        }
      }
      $modelMatches = Test-E2EObservedValueMatch -ExpectedValue ([string]$expected.model) -ObservedValues $observedRunConfig.observed_models
      $effortMatches = if ($providerIdValue -eq "codex") {
        Test-E2EObservedValueMatch -ExpectedValue ([string]$expected.effort) -ObservedValues $observedRunConfig.observed_efforts
      } else {
        $true
      }
      $roleItems += [ordered]@{
        role_id = $role
        session_id = if ($auditItem) { [string]$auditItem.session_id } else { $null }
        provider_id = $providerIdValue
        session_status = if ($auditItem) { [string]$auditItem.status } else { $null }
        provider_matches = if ($auditItem) { [bool]$auditItem.provider_matches } else { $false }
        expected_model = [string]$expected.model
        expected_effort = [string]$expected.effort
        observed_models = @($observedRunConfig.observed_models)
        observed_efforts = @($observedRunConfig.observed_efforts)
        model_matches = [bool]$modelMatches
        effort_matches = [bool]$effortMatches
        run_started_count = $startedCount
        run_finished_count = $finishedCount
        agent_output_line_count = $agentOutputLines
        direct_evidence_pass = if ($providerIdValue -eq "codex") {
          ($startedCount -ge 1 -and $finishedCount -ge 1 -and $agentOutputLines -ge 1)
        } else {
          ($startedCount -ge 1)
        }
        model_evidence_pass = if ($providerIdValue -eq "codex") {
          ($startedCount -ge 1 -and $modelMatches -and $effortMatches)
        } else {
          ($startedCount -ge 1 -and $modelMatches)
        }
      }
    }
    $providerItems += [ordered]@{
      provider_id = $providerIdValue
      role_count = $rolesForProvider.Count
      roles = $roleItems
      session_match_pass = (@($roleItems | Where-Object { -not $_.provider_matches }).Count -eq 0)
      direct_evidence_pass = (@($roleItems | Where-Object { -not $_.direct_evidence_pass }).Count -eq 0)
      model_evidence_pass = (@($roleItems | Where-Object { -not $_.model_evidence_pass }).Count -eq 0)
    }
  }

  return [ordered]@{
    mode = [string]$resolvedMatrix.mode
    project_id = $projectId
    event_path = $eventsPath
    agent_output_path = $agentOutputPath
    providers = $providerItems
    overall_pass = (
      $SessionAudit.all_sessions_match -and
      (@($providerItems | Where-Object { -not $_.session_match_pass -or -not $_.direct_evidence_pass -or -not $_.model_evidence_pass }).Count -eq 0)
    )
  }
}

$providerSettingsResp = Assert-E2EProvidersConfigured -BaseUrl $BaseUrl -ResolvedMatrix $resolvedMatrix
$script:settingsIsolationPlan = New-E2ESettingsIsolationPlan -SettingsBody $providerSettingsResp.body -ResolvedMatrix $resolvedMatrix
$providerSettingsPatch = if ($script:settingsIsolationPlan) { $script:settingsIsolationPlan.patch } else { $null }

function Add-StabilityFallbackEvent {
  param(
    [string]$Type,
    [string]$Detail
  )
  $script:stabilityFallbackEvents += [pscustomobject]@{
    type = $Type
    timestamp = (Get-Date).ToString("o")
    detail = $Detail
  }
}

function Write-StabilityMetrics {
  param(
    [string]$OutDir,
    [string]$CaseId,
    [datetime]$StartTime,
    [bool]$FinalPass,
    [string]$FinalReason,
    [int]$ExitCode
  )

  Ensure-Dir -Path $OutDir
  $eventsPath = Join-Path $OutDir "events.ndjson"
  $toolFailedTs = @()
  if (Test-Path -LiteralPath $eventsPath) {
    foreach ($line in (Get-Content -LiteralPath $eventsPath)) {
      $trimmed = $line.Trim()
      if (-not $trimmed) { continue }
      try {
        $evt = $trimmed | ConvertFrom-Json
        $etype = [string]$evt.eventType
        if ($etype -eq "TEAM_TOOL_FAILED" -or $etype -eq "TOOL_CALL_FAILED" -or $etype -eq "TOOLCALL_FAILED") {
          $toolFailedTs += [string]$evt.createdAt
        }
      } catch {}
    }
  }

  $timeoutRecoveredTs = @()
  if ($FinalPass) {
    $timeoutRecoveredTs = @($script:stabilityFallbackEvents | ForEach-Object { [string]$_.timestamp })
  }

  $metrics = [ordered]@{
    case_id = $CaseId
    start_time = $StartTime.ToString("o")
    end_time = (Get-Date).ToString("o")
    exit_code = $ExitCode
    final_pass = $FinalPass
    final_reason = [string]$FinalReason
    toolcall_failed_count = @($toolFailedTs).Count
    toolcall_failed_timestamps = @($toolFailedTs)
    timeout_recovered_count = @($timeoutRecoveredTs).Count
    timeout_recovered_timestamps = @($timeoutRecoveredTs)
    fallback_events = @($script:stabilityFallbackEvents)
  }
  ($metrics | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $OutDir "stability_metrics.json") -Encoding UTF8
  return [pscustomobject]$metrics
}

trap {
  $trapOutDir = $script:stabilityOutDir
  if ([string]::IsNullOrWhiteSpace($trapOutDir)) {
    $stampTrap = Get-Date -Format "yyyyMMdd_HHmmss"
    $trapOutDir = Join-Path $artifactsBase "$stampTrap-failed"
    $script:stabilityOutDir = $trapOutDir
  }
  $finalReason = "script_exception"
  $pass = $false
  $analysisExit = 1
  $errRecord = $_
  $errMessage = if ($errRecord -and $errRecord.Exception) { [string]$errRecord.Exception.Message } else { [string]$errRecord }
  $errStack = if ($errRecord) { [string]$errRecord.ScriptStackTrace } else { "" }
  $errDetail = [ordered]@{
    captured_at = (Get-Date).ToString("o")
    message = $errMessage
    stack = $errStack
    error_record = [string]$errRecord
  }
  Ensure-Dir -Path $trapOutDir
  ($errDetail | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $trapOutDir "script_exception.json") -Encoding UTF8
  Write-Host ("script_exception_message={0}" -f $errMessage)
  if (-not [string]::IsNullOrWhiteSpace($errStack)) {
    Write-Host ("script_exception_stack={0}" -f $errStack)
  }
  if (-not $script:settingsIsolationRestoreAudit) {
    try {
      $script:settingsIsolationRestoreAudit = Invoke-E2ESettingsIsolationRestore -BaseUrl $BaseUrl -Plan $script:settingsIsolationPlan
    } catch {
      $errDetail.settings_restore_failed = $_.Exception.Message
      $script:settingsIsolationRestoreAudit = Get-E2ESettingsIsolationAuditPayload -Plan $script:settingsIsolationPlan
    }
  }
  if ($script:settingsIsolationPlan) {
    (Get-E2ESettingsIsolationAuditPayload -Plan $script:settingsIsolationPlan | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $trapOutDir "settings_isolation_audit.json") -Encoding UTF8
  }
  $writeMetricsCommand = Get-Command Write-StabilityMetrics -ErrorAction SilentlyContinue
  if ($writeMetricsCommand) {
    Write-StabilityMetrics -OutDir $trapOutDir -CaseId $script:stabilityCaseId -StartTime $scriptRunStart -FinalPass $false -FinalReason $finalReason -ExitCode 2
  } else {
    $fallbackMetrics = [ordered]@{
      case_id = $script:stabilityCaseId
      start_time = $scriptRunStart.ToString("o")
      end_time = (Get-Date).ToString("o")
      exit_code = 2
      final_pass = $false
      final_reason = [string]$finalReason
      toolcall_failed_count = 0
      toolcall_failed_timestamps = @()
      timeout_recovered_count = 0
      timeout_recovered_timestamps = @()
      fallback_events = @($script:stabilityFallbackEvents)
    }
    ($fallbackMetrics | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath (Join-Path $trapOutDir "stability_metrics.json") -Encoding UTF8
  }
  exit 2
}

function Build-AgentPrompt {
  param([string]$Role)
  $providerId = ""
  if ($resolvedMatrix -and $resolvedMatrix.by_role_id -and $resolvedMatrix.by_role_id[$Role]) {
    $providerId = [string]$resolvedMatrix.by_role_id[$Role].provider_id
  }
  $roleWorkspace = Join-Path (Join-Path $workspace "Agents") $Role
  $roleProgressPath = Join-Path $roleWorkspace "progress.md"
  $canonicalToolLine = "Canonical TeamTool names: task_report_in_progress, task_report_done, task_report_block."
  $completionToolName = if ($providerId -eq "codex") { "mcp__teamtool__task_report_done" } else { "task_report_done" }
  $providerToolLines = if ($providerId -eq "codex") {
    @(
      "Codex runtime may expose MCP aliases. In this role, call the exact exposed Codex names: mcp__teamtool__task_report_in_progress, mcp__teamtool__task_report_done, mcp__teamtool__task_report_block.",
      "Exact report examples for this role: mcp__teamtool__task_report_in_progress({""content"":""Started <task>"",""progress_file"":""$roleProgressPath""}) and mcp__teamtool__task_report_done({""task_report_path"":""$roleProgressPath""})."
    )
  } else {
    @(
      "In this role, use canonical TeamTool names only. Do not prepend mcp__teamtool__ to TeamTool names.",
      "Tool names starting with mcp__teamtool__ are invalid in this runtime and will fail.",
      "Exact report examples for this role: task_report_in_progress({""content"":""Started <task>"",""progress_file"":""$roleProgressPath""}) and task_report_done({""task_report_path"":""$roleProgressPath""})."
    )
  }
  $providerToolText = $providerToolLines -join "`n"
  if ($Role -eq $roleA) {
    return @(
      "You are role A (lead orchestrator).",
      "Execute assigned tasks and coordinate dependency progress.",
      "Do not bypass task dependencies.",
      "Use TeamTool task report calls to update progress and completion.",
      "Only call task_report_* on tasks owned by your role or tasks created by your role.",
      "Your local progress file absolute path is $roleProgressPath. Always use that absolute path in TeamTool report calls; never use ./progress.md.",
      $canonicalToolLine,
      $providerToolText,
      "Shell output is never evidence that TeamTool is unavailable.",
      "If the task is complete, call $completionToolName immediately before writing any final summary.",
      "A natural-language completion note without the matching task_report_done ToolCall is invalid and will be treated as unfinished work.",
      "Only claim a reporting blocker if the actual ToolCall failed and then quote its error_code and next_action."
    ) -join "`n"
  }
  return @(
    "You are implementation role $Role.",
    "Only execute assigned tasks and report through TeamTools.",
    "Use task_report_in_progress during work, task_report_done when complete, task_report_block when blocked.",
    "Only call task_report_* on tasks owned by your role or tasks created by your role.",
    "Your local progress file absolute path is $roleProgressPath. Always use that absolute path in TeamTool report calls; never use ./progress.md.",
    $canonicalToolLine,
    $providerToolText,
    "Shell output is never evidence that TeamTool is unavailable.",
    "If the task is complete, call $completionToolName immediately before writing any final summary.",
    "A natural-language completion note without the matching task_report_done ToolCall is invalid and will be treated as unfinished work.",
    "Only claim a reporting blocker if the actual ToolCall failed and then quote its error_code and next_action."
  ) -join "`n"
}

function New-TaskCreateBody {
  param(
    [string]$TaskId,
    [string]$TaskKind,
    [string]$ParentTaskId,
    [string]$RootTaskId,
    [string]$Title,
    [string]$OwnerRole,
    [int]$Priority,
    [array]$Dependencies,
    [string]$Content,
    [array]$WriteSet = @(),
    [array]$Acceptance = @(),
    [array]$Artifacts = @()
  )

  return @{
    action_type = "TASK_CREATE"
    from_agent = "manager"
    from_session_id = "manager-system"
    task_id = $TaskId
    task_kind = $TaskKind
    parent_task_id = $ParentTaskId
    root_task_id = $RootTaskId
    title = $Title
    owner_role = $OwnerRole
    priority = $Priority
    dependencies = @($Dependencies)
    write_set = @($WriteSet)
    acceptance = @($Acceptance)
    artifacts = @($Artifacts)
    content = $Content
  }
}

function Get-NodeByIdMap {
  param([object[]]$Nodes)
  $map = @{}
  foreach ($node in @($Nodes)) {
    $map[[string]$node.task_id] = $node
  }
  return $map
}

function Get-ReminderProbeEvidence {
  param(
    [object[]]$Events,
    [object[]]$Nodes,
    [string]$ProbeRole,
    [string]$ProbeTaskId
  )

  $triggerEventsByRole = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED" -and
      [string]$_.payload.role -eq $ProbeRole
    })
  $triggerEventsAny = @($Events | Where-Object { $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED" })
  $triggerEventsByRole = @($triggerEventsByRole | Sort-Object { [datetime]$_.createdAt })
  $triggerEventsAny = @($triggerEventsAny | Sort-Object { [datetime]$_.createdAt })
  $effectiveTriggerEvents = @(if ($triggerEventsByRole.Count -gt 0) { $triggerEventsByRole } else { $triggerEventsAny })
  $usedTriggerFallback = ($triggerEventsByRole.Count -eq 0 -and $triggerEventsAny.Count -gt 0)
  $firstTriggerAt = if ($effectiveTriggerEvents.Count -gt 0) { [datetime]$effectiveTriggerEvents[0].createdAt } else { $null }
  $dispatchEvents = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" -and
      [string]$_.taskId -eq $ProbeTaskId -and
      ($null -eq $firstTriggerAt -or [datetime]$_.createdAt -ge $firstTriggerAt)
    })
  $redispatchEventsByRole = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH" -and
      [string]$_.payload.role -eq $ProbeRole -and
      [string]$_.payload.outcome -eq "dispatched"
    })
  $redispatchEventsAny = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH" -and
      [string]$_.payload.outcome -eq "dispatched"
    })
  $effectiveRedispatchEvents = @(if ($redispatchEventsByRole.Count -gt 0) { $redispatchEventsByRole } else { $redispatchEventsAny })
  $usedRedispatchFallback = ($redispatchEventsByRole.Count -eq 0 -and $redispatchEventsAny.Count -gt 0)
  $reportEvents = @($Events | Where-Object {
      $_.eventType -eq "TASK_REPORT_APPLIED" -and @([string[]]$_.payload.appliedTaskIds) -contains $ProbeTaskId
    })

  $nodeMap = Get-NodeByIdMap -Nodes $Nodes
  $probeNode = if ($nodeMap.ContainsKey($ProbeTaskId)) { $nodeMap[$ProbeTaskId] } else { $null }
  $terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
  $probeTerminal = $false
  $probeState = "MISSING"
  if ($probeNode) {
    $probeState = [string]$probeNode.state
    $probeTerminal = $terminalStates -contains $probeState
  }

  return [pscustomobject]@{
    probe_role = $ProbeRole
    probe_task_id = $ProbeTaskId
    reminder_trigger_count = $effectiveTriggerEvents.Count
    reminder_trigger_count_by_role = $triggerEventsByRole.Count
    reminder_trigger_count_any = $triggerEventsAny.Count
    message_dispatch_count = $dispatchEvents.Count
    redispatch_count = $effectiveRedispatchEvents.Count
    redispatch_count_by_role = $redispatchEventsByRole.Count
    redispatch_count_any = $redispatchEventsAny.Count
    report_applied_count = $reportEvents.Count
    probe_state = $probeState
    probe_terminal = $probeTerminal
    used_trigger_fallback = $usedTriggerFallback
    used_redispatch_fallback = $usedRedispatchFallback
    trigger_pass = ($effectiveTriggerEvents.Count -ge 1)
    dispatch_pass = ($dispatchEvents.Count -ge 1 -or $effectiveRedispatchEvents.Count -ge 1)
    progress_pass = ($reportEvents.Count -ge 1 -or $probeTerminal)
    pass = ($effectiveTriggerEvents.Count -ge 1 -and ($dispatchEvents.Count -ge 1 -or $effectiveRedispatchEvents.Count -ge 1) -and ($reportEvents.Count -ge 1 -or $probeTerminal))
    trigger_events = $effectiveTriggerEvents
    dispatch_events = $dispatchEvents
    redispatch_events = $effectiveRedispatchEvents
    report_events = $reportEvents
  }
}

function Wait-ForReminderProbe {
  param(
    [string]$ProjectId,
    [string]$ProbeRole,
    [string]$ProbeTaskId,
    [int]$TimeoutMinutes,
    [int]$PollIntervalSeconds
  )

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $fallbackAt = (Get-Date).AddSeconds([Math]::Max(90, $PollIntervalSeconds * 6))
  $manualDispatchIssued = $false
  $manualDispatchReason = ""
  $probeSessionRecoveryCount = 0
  $trace = New-Object System.Collections.Generic.List[object]

  while ((Get-Date) -lt $deadline) {
    $eventsResp = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $ProjectId
    $treeResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/task-tree" -AllowStatus @(200)
    $sessionsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions" -AllowStatus @(200)
    $null = Suppress-ManagerSessions -ProjectId $ProjectId -SessionItems @($sessionsResp.body.items) -Reason "reminder_probe_wait"
    $evidence = Get-ReminderProbeEvidence -Events $eventsResp.items -Nodes $treeResp.body.nodes -ProbeRole $ProbeRole -ProbeTaskId $ProbeTaskId

    $probeSession = @($sessionsResp.body.items | Where-Object { [string]$_.role -eq $ProbeRole } | Select-Object -First 1)[0]
    $trace.Add([pscustomobject]@{
        at = (Get-Date).ToString("o")
        reminder_trigger_count = $evidence.reminder_trigger_count
        message_dispatch_count = $evidence.message_dispatch_count
        report_applied_count = $evidence.report_applied_count
        probe_state = $evidence.probe_state
        probe_terminal = $evidence.probe_terminal
        session_status = if ($probeSession) { [string]$probeSession.status } else { "missing" }
        manual_dispatch_issued = $manualDispatchIssued
        manual_dispatch_reason = $manualDispatchReason
        probe_session_recovery_count = $probeSessionRecoveryCount
      })

    $probeDispatchFailure = @(
      $eventsResp.items | Where-Object {
        (
          [string]$_.eventType -eq "ORCHESTRATOR_DISPATCH_FAILED" -or
          [string]$_.eventType -eq "RUNNER_FATAL_ERROR_DISMISSED"
        ) -and
        [string]$_.taskId -eq $ProbeTaskId
      } | Select-Object -Last 1
    )[0]

    if ($evidence.trigger_pass -and -not $manualDispatchIssued) {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -Body @{
        role = $ProbeRole
        task_id = $ProbeTaskId
        force = $false
        only_idle = $false
      } -AllowStatus @(200) | Out-Null
      $manualDispatchIssued = $true
      $manualDispatchReason = "after_passive_reminder_trigger"
    } elseif (
      -not $manualDispatchIssued -and
      (Get-Date) -ge $fallbackAt -and
      -not $evidence.trigger_pass -and
      -not $evidence.dispatch_pass -and
      -not $evidence.progress_pass -and
      $probeSession -and
      [string]$probeSession.status -eq "idle"
    ) {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -Body @{
        role = $ProbeRole
        task_id = $ProbeTaskId
        force = $false
        only_idle = $false
      } -AllowStatus @(200) | Out-Null
      $manualDispatchIssued = $true
      $manualDispatchReason = "fallback_without_passive_reminder"
    }

    if (
      -not $probeSession -and
      -not $evidence.probe_terminal -and
      $probeSessionRecoveryCount -lt 2 -and
      $probeDispatchFailure
    ) {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/sessions" -Body @{ role = $ProbeRole } -AllowStatus @(200, 201, 409) | Out-Null
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -Body @{
        role = $ProbeRole
        task_id = $ProbeTaskId
        force = $false
        only_idle = $false
      } -AllowStatus @(200) | Out-Null
      $probeSessionRecoveryCount += 1
      $manualDispatchIssued = $true
      $manualDispatchReason = "probe_session_recreated_after_runner_failure"
      Add-StabilityFallbackEvent -Type "probe_session_recreate" -Detail ("role={0} task={1} attempt={2}" -f $ProbeRole, $ProbeTaskId, $probeSessionRecoveryCount)
    }

    $fallbackPass = (
      (
        $manualDispatchReason -eq "fallback_without_passive_reminder" -or
        $manualDispatchReason -eq "probe_session_recreated_after_runner_failure"
      ) -and
      $evidence.dispatch_pass -and
      $evidence.progress_pass
    )
    if ($evidence.pass -or $fallbackPass) {
      return [pscustomobject]@{
        pass = $true
        evidence = $evidence
        trace = $trace.ToArray()
        events_raw = $eventsResp.raw
        observation_gap = (-not $evidence.pass)
        manual_dispatch_reason = if ($manualDispatchReason) { $manualDispatchReason } else { $null }
      }
    }

    Start-Sleep -Seconds $PollIntervalSeconds
  }

  return [pscustomobject]@{
    pass = $false
    evidence = $evidence
    trace = $trace.ToArray()
    events_raw = $eventsResp.raw
    observation_gap = $true
    manual_dispatch_reason = if ($manualDispatchReason) { $manualDispatchReason } else { $null }
  }
}

function Suppress-ManagerSessions {
  param(
    [string]$ProjectId,
    [object[]]$SessionItems,
    [string]$Reason
  )

  $items = @($SessionItems)
  if ($items.Count -eq 0) {
    $resp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions" -AllowStatus @(200)
    $items = @($resp.body.items)
  }

  $suppressed = @()
  foreach ($item in $items) {
    if ([string]$item.role -ne "manager") { continue }
    $sessionId = [string]$item.sessionId
    if ([string]::IsNullOrWhiteSpace($sessionId)) { continue }
    $status = ([string]$item.status).Trim().ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($status)) { $status = "unknown" }
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/sessions/$sessionId/dismiss" -AllowStatus @(200, 404, 409) | Out-Null
    Add-StabilityFallbackEvent -Type "manager_suppress" -Detail ("reason={0} session={1} status={2}" -f $Reason, $sessionId, $status)
    Write-Host ("manager session suppressed: session={0} status={1} reason={2}" -f $sessionId, $status, $Reason)
    $suppressed += [pscustomobject]@{
      session_id = $sessionId
      status = $status
      reason = $Reason
    }
  }

  return @($suppressed)
}

 $outDir = $null
try {
Write-Host "== Preflight =="
$health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz"
if ($health.body.status -ne "ok") {
  throw "healthz is not ok"
}

if ($providerSettingsPatch) {
  Write-Host "== Apply runtime provider settings override =="
  $script:settingsIsolationApplyAudit = Invoke-E2ESettingsIsolationApply -BaseUrl $BaseUrl -Plan $script:settingsIsolationPlan
}

Write-Host "== Reset target project if exists =="
$projects = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects"
$exists = $false
if ($projects.body.items) {
  $exists = @($projects.body.items | Where-Object { $_.projectId -eq $projectId }).Count -gt 0
}
if ($exists) {
  Remove-ProjectWithRetry -BaseUrl $BaseUrl -ProjectId $projectId | Out-Null
}

Write-Host "== Reset workspace (full clean) before run =="
Reset-WorkspaceDirectory -WorkspaceRoot $workspace
Ensure-Dir -Path $workspace

Write-Host "== Upsert agents =="
$agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents"
$known = @{}
foreach ($a in @($agentList.body.items)) { $known[$a.agentId] = $true }

foreach ($role in $roleList) {
  $roleConfig = Get-ResolvedRoleModelConfig -RoleId $role
  $payload = @{
    agent_id = $role
    display_name = $role
    prompt = (Build-AgentPrompt -Role $role)
    provider_id = [string]$roleConfig.provider_id
    default_model_params = @{
      model = [string]$roleConfig.model
      effort = [string]$roleConfig.effort
    }
    model_selection_enabled = $true
  }
  if ($known.ContainsKey($role)) {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$role" -Body $payload | Out-Null
  } else {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -Body $payload -AllowStatus @(201) | Out-Null
  }
}

Write-Host "== Create project (auto-dispatch disabled initially) =="
$createBody = @{
  project_id = $projectId
  name = $projectName
  workspace_path = $workspace
  agent_ids = $roleList
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  auto_dispatch_enabled = $false
  auto_dispatch_remaining = 0
  reminder_mode = "fixed_interval"
}
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects" -Body $createBody -AllowStatus @(201) | Out-Null

$postCreateSessions = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/sessions" -AllowStatus @(200)
$managerSession = @($postCreateSessions.body.items | Where-Object { [string]$_.role -eq "manager" } | Select-Object -First 1)[0]
if ($managerSession -and -not [string]::IsNullOrWhiteSpace([string]$managerSession.sessionId)) {
  Write-Host "== Dismiss manager session (E2E isolation) =="
  Suppress-ManagerSessions -ProjectId $projectId -SessionItems @($postCreateSessions.body.items) -Reason "post_project_create" | Out-Null
}

Write-Host "== Patch routing model config =="
$agentModelConfigs = @{}
foreach ($role in $roleList) {
  $roleConfig = Get-ResolvedRoleModelConfig -RoleId $role
  $agentModelConfigs[$role] = [ordered]@{
    provider_id = [string]$roleConfig.provider_id
    model = [string]$roleConfig.model
    effort = [string]$roleConfig.effort
  }
}
$routingPatch = @{
  agent_ids = $roleList
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  agent_model_configs = $agentModelConfigs
}
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/routing-config" -Body $routingPatch | Out-Null

Write-Host "== Patch task-assign routing =="
$assignPatch = @{ task_assign_route_table = $taskAssignRouteTable }
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/task-assign-routing" -Body $assignPatch | Out-Null

Write-Host "== Create role sessions =="
foreach ($role in $roleList) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/sessions" -Body @{ role = $role } -AllowStatus @(200, 201, 409) | Out-Null
}
$sessionsVerify = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/sessions" -AllowStatus @(200)
foreach ($item in @($sessionsVerify.body.items)) {
  $expectedProvider = [string](Get-ResolvedRoleModelConfig -RoleId ([string]$item.role)).provider_id
  $sessionProvider = ([string]$item.provider).Trim().ToLower()
  if ($sessionProvider -ne $expectedProvider) {
    throw "Session provider must be $expectedProvider. session_id=$($item.sessionId) role=$($item.role) provider=$sessionProvider"
  }
}

Write-Host "== Seed dependency chain with reminder probe =="
$rootTaskId = "$projectId-root"
$taskAId = [string]$seedTasks.task_a.task_id
$taskBId = [string]$seedTasks.task_b_placeholder.task_id
$taskB1Id = [string]$seedTasks.task_b1_child.task_id
$taskCId = [string]$seedTasks.task_c.task_id
$probeTaskId = [string]$reminderProbe.probe_task_id
$gateTaskId = [string]$reminderProbe.gate_task_id
$probeRole = [string]$roleByRef[[string]$reminderProbe.blocked_role_ref]
if ([string]::IsNullOrWhiteSpace($probeRole)) {
  throw "Unknown reminder probe role ref: $($reminderProbe.blocked_role_ref)"
}

$taskBodies = @(
  (New-TaskCreateBody -TaskId $gateTaskId -TaskKind "EXECUTION" -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title "Reminder gate task" -OwnerRole "manager" -Priority 110 -Dependencies @() -Content "E2E manager-owned gate task. The baseline script marks it DONE after reminder redispatch is observed."),
  (New-TaskCreateBody -TaskId $probeTaskId -TaskKind "EXECUTION" -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title "Reminder probe task for role $probeRole" -OwnerRole $probeRole -Priority 105 -Dependencies @() -WriteSet @("docs/e2e/standard_reminder_probe.md") -Acceptance @("Create docs/e2e/standard_reminder_probe.md with reminder status and completion timestamp.") -Artifacts @("docs/e2e/standard_reminder_probe.md") -Content "Create docs/e2e/standard_reminder_probe.md with a short status note mentioning reminder probe done, then report this task DONE."),
  (New-TaskCreateBody -TaskId $taskAId -TaskKind ([string]$seedTasks.task_a.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_a.title) -OwnerRole $roleA -Priority ([int]$seedTasks.task_a.priority) -Dependencies @($seedTasks.task_a.dependencies) -Content ([string]$seedTasks.task_a.content)),
  (New-TaskCreateBody -TaskId $taskBId -TaskKind ([string]$seedTasks.task_b_placeholder.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_b_placeholder.title) -OwnerRole $roleA -Priority ([int]$seedTasks.task_b_placeholder.priority) -Dependencies @($seedTasks.task_b_placeholder.dependencies) -Content ([string]$seedTasks.task_b_placeholder.content)),
  (New-TaskCreateBody -TaskId $taskB1Id -TaskKind ([string]$seedTasks.task_b1_child.task_kind) -ParentTaskId $taskBId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_b1_child.title) -OwnerRole $roleB -Priority ([int]$seedTasks.task_b1_child.priority) -Dependencies @($seedTasks.task_b1_child.dependencies) -Content ([string]$seedTasks.task_b1_child.content)),
  (New-TaskCreateBody -TaskId $taskCId -TaskKind ([string]$seedTasks.task_c.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_c.title) -OwnerRole $roleC -Priority ([int]$seedTasks.task_c.priority) -Dependencies @($seedTasks.task_c.dependencies) -Content ([string]$seedTasks.task_c.content))
)
foreach ($body in $taskBodies) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -Body $body -AllowStatus @(201) | Out-Null
}

Write-Host "== Pre-gate validation before releasing reminder gate =="
if ($SetupOnly) {
  Write-Host "setup-only: skip pre-gate orchestrator dispatch validation"
  $preGate = @{
    taskB1 = @{
      skipped = $true
      reason = "setup_only"
    }
    taskC = @{
      skipped = $true
      reason = "setup_only"
    }
  }
} else {
  $preGateB1 = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleB; task_id = $taskB1Id; force = $false; only_idle = $false } -AllowStatus @(200)
  $preGateC = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleC; task_id = $taskCId; force = $false; only_idle = $false } -AllowStatus @(200)
  $preGate = @{ taskB1 = $preGateB1.body; taskC = $preGateC.body }
}

$stampPre = Get-Date -Format "yyyyMMdd_HHmmss"
$preCheckDir = Join-Path $artifactsBase "$stampPre-precheck"
Ensure-Dir -Path $preCheckDir
($preGate | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $preCheckDir "pre_gate_checks.json") -Encoding UTF8

$reminderProbeResult = $null
if (-not $SetupOnly) {
  Write-Host "== Wait for reminder probe trigger and redispatch =="
  $reminderProbeResult = Wait-ForReminderProbe -ProjectId $projectId -ProbeRole $probeRole -ProbeTaskId $probeTaskId -TimeoutMinutes 6 -PollIntervalSeconds ([Math]::Max(5, $PollSeconds))
  if (-not $reminderProbeResult.pass) {
    throw "Reminder probe did not reach trigger -> message redispatch -> progress for task '$probeTaskId'"
  }

  Write-Host "== Release reminder gate and enable auto dispatch =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -Body @{
    action_type = "TASK_REPORT"
    from_agent = "manager"
    from_session_id = "manager-system"
    results = @(
      @{ task_id = $gateTaskId; outcome = "DONE"; summary = "Reminder probe passed; release main dependency chain." }
    )
  } -AllowStatus @(200, 201) | Out-Null

  Write-Host "== Kick role A and enable baseline loop =="
  $kickMessage = @{
    from_agent = "manager"
    from_session_id = "manager-system"
    to = @{ agent = $roleA }
    message_type = "MANAGER_MESSAGE"
    task_id = $taskAId
    content = "Start from task A. Follow dependency chain and report progress with TeamTools."
  }
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/messages/send" -Body $kickMessage -AllowStatus @(201) | Out-Null

  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/orchestrator/settings" -Body @{
    auto_dispatch_enabled = $true
    auto_dispatch_remaining = $AutoDispatchBudget
    reminder_mode = "fixed_interval"
  } | Out-Null

  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{
    role = $roleA
    force = $false
    only_idle = $false
  } -AllowStatus @(200) | Out-Null

  Suppress-ManagerSessions -ProjectId $projectId -SessionItems @() -Reason "post_auto_dispatch_enable" | Out-Null
}

Write-Host "== Monitor run =="
$start = Get-Date
$finalReason = ""
$pass = $false
$topupCount = 0
$totalBudgetGranted = if ($SetupOnly) { 0 } else { $AutoDispatchBudget }
$topupLog = @()
$noRunningStreak = 0

if ($SetupOnly) {
  $pass = $true
  $finalReason = "setup_only"
} else {
  while ($true) {
    $settingsNow = Invoke-ApiJsonWithRetry -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/orchestrator/settings" -AllowStatus @(200, 500) -RetryOnStatus @(500) -MaxAttempts 6 -InitialDelayMs 300 -RetryOnRequestFailure
    $sessionsNow = Invoke-ApiJsonWithRetry -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/sessions" -AllowStatus @(200, 500) -RetryOnStatus @(500) -MaxAttempts 6 -InitialDelayMs 300 -RetryOnRequestFailure
    $managerSuppressed = Suppress-ManagerSessions -ProjectId $projectId -SessionItems @($sessionsNow.body.items) -Reason "monitor_loop"
    if (@($managerSuppressed).Count -gt 0) {
      $sessionsNow = Invoke-ApiJsonWithRetry -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/sessions" -AllowStatus @(200, 500) -RetryOnStatus @(500) -MaxAttempts 6 -InitialDelayMs 300 -RetryOnRequestFailure
    }
    $treeNow = Invoke-ApiJsonWithRetry -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/task-tree" -AllowStatus @(200, 500) -RetryOnStatus @(500) -MaxAttempts 6 -InitialDelayMs 300 -RetryOnRequestFailure

    $remaining = [int]$settingsNow.body.auto_dispatch_remaining
    $nodes = @($treeNow.body.nodes)
    $executionNodes = @($nodes | Where-Object { $_.task_kind -eq "EXECUTION" })
    $terminalStates = @("DONE", "CANCELED")
    $openExec = @($executionNodes | Where-Object { $terminalStates -notcontains $_.state })
    $running = @($sessionsNow.body.items | Where-Object { $_.status -eq "running" -and [string]$_.role -ne "manager" })
    $managerRunning = @($sessionsNow.body.items | Where-Object { $_.status -eq "running" -and [string]$_.role -eq "manager" })
    Write-Host ("remaining={0} exec={1} open_exec={2} running={3} manager_running={4}" -f $remaining, $executionNodes.Count, $openExec.Count, $running.Count, $managerRunning.Count)
    if ($openExec.Count -gt 0 -and $running.Count -eq 0) {
      $noRunningStreak += 1
    } else {
      $noRunningStreak = 0
    }

    if (-not $strictMode) {
      foreach ($s in $running) {
        $sessionToken = if ($s.sessionId) { $s.sessionId } else { $null }
        if (-not $sessionToken -or -not $s.lastActiveAt) { continue }
        $last = [datetime]::Parse($s.lastActiveAt)
        if (((Get-Date).ToUniversalTime() - $last.ToUniversalTime()).TotalMinutes -gt 15) {
          Add-StabilityFallbackEvent -Type "repair" -Detail ("role={0} session={1}" -f [string]$s.role, [string]$sessionToken)
          Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/sessions/$sessionToken/repair" -Body @{ target_status = "idle" } -AllowStatus @(200, 404, 409) | Out-Null
          Add-StabilityFallbackEvent -Type "dispatch_nudge" -Detail ("reason=repair role={0}" -f [string]$s.role)
          Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $s.role; force = $false; only_idle = $false } -AllowStatus @(200) | Out-Null
        }
      }
    }

    if ($openExec.Count -eq 0 -and $running.Count -eq 0) {
      $pass = $true
      $finalReason = "closed_loop"
      break
    }
    if ((-not $strictMode) -and $remaining -le 0 -and $openExec.Count -gt 0) {
      if ($topupCount -ge $MaxTopups) {
        $finalReason = "max_topups_reached"
        break
      }
      if (($totalBudgetGranted + $AutoTopupStep) -gt $MaxTotalBudget) {
        $finalReason = "max_total_budget_reached"
        break
      }
      $newRemaining = [Math]::Max(0, $remaining) + $AutoTopupStep
      Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/orchestrator/settings" -Body @{
        auto_dispatch_enabled = $true
        auto_dispatch_remaining = $newRemaining
      } | Out-Null
      $topupCount += 1
      $totalBudgetGranted += $AutoTopupStep
      $entry = [pscustomobject]@{
        at = (Get-Date).ToString("o")
        previous_remaining = $remaining
        new_remaining = $newRemaining
        topup_count = $topupCount
        total_budget_granted = $totalBudgetGranted
      }
      $topupLog += $entry
      Add-StabilityFallbackEvent -Type "topup" -Detail ("remaining={0}-> {1}" -f $remaining, $newRemaining)
      Write-Host ("topup applied: count={0} new_remaining={1} total_budget_granted={2}" -f $topupCount, $newRemaining, $totalBudgetGranted)
      Start-Sleep -Seconds $PollSeconds
      continue
    }
    if ((-not $strictMode) -and $openExec.Count -gt 0 -and $noRunningStreak -ge 3) {
      $nudgeRoles = @(
        $openExec |
          ForEach-Object {
            if ($_.owner_role) { [string]$_.owner_role } else { [string]$_.ownerRole }
          } |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_ -ne "manager" } |
          Select-Object -Unique
      )
      $nudgeResults = @()
      foreach ($nudgeRole in $nudgeRoles) {
        $dispatchResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{
          role = $nudgeRole
          force = $false
          only_idle = $false
        } -AllowStatus @(200, 500)
        $ok = ([int]$dispatchResp.status -eq 200)
        $nudgeResults += [pscustomobject]@{
          role = $nudgeRole
          success = $ok
          status = [int]$dispatchResp.status
        }
      }
      $nudgeSummary = if ($nudgeResults.Count -gt 0) {
        (($nudgeResults | ForEach-Object { "{0}:{1}" -f $_.role, $(if ($_.success) { "ok" } else { "skip" }) }) -join ",")
      } else {
        "no_non_manager_open_roles"
      }
      Add-StabilityFallbackEvent -Type "dispatch_nudge" -Detail ("reason=idle_streak streak={0} targets={1}" -f $noRunningStreak, $nudgeSummary)
      Write-Host ("dispatch nudge attempted after idle streak={0} targets={1}" -f $noRunningStreak, $nudgeSummary)
      $noRunningStreak = 0
      Start-Sleep -Seconds $PollSeconds
      continue
    }
    if (((Get-Date) - $start).TotalMinutes -gt $MaxMinutes) {
      $finalReason = "timeout"
      break
    }

    Start-Sleep -Seconds $PollSeconds
  }
}

Write-Host "== Export logs and analyze =="
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$outDir = Join-Path $artifactsBase $stamp
$script:stabilityOutDir = $outDir
Ensure-Dir -Path $outDir

& (Join-Path $scriptDir "export-core-logs.ps1") -BaseUrl $BaseUrl -ProjectId $projectId -OutDir $outDir
Copy-Item -LiteralPath (Join-Path $preCheckDir "pre_gate_checks.json") -Destination (Join-Path $outDir "pre_gate_checks.json") -Force
$topupJson = if (@($topupLog).Count -eq 0) { "[]" } else { ($topupLog | ConvertTo-Json -Depth 20) }
Set-Content -LiteralPath (Join-Path $outDir "topup_log.json") -Value $topupJson -Encoding UTF8

$reminderEvidenceOut = if ($reminderProbeResult) {
  [pscustomobject]@{
    pass = $reminderProbeResult.pass
    evidence = $reminderProbeResult.evidence
    trace = $reminderProbeResult.trace
  }
} else {
  [pscustomobject]@{
    pass = $false
    skipped = $true
    reason = "setup_only"
  }
}
($reminderEvidenceOut | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "reminder_probe.json") -Encoding UTF8

$preAnalysisExitCode = if ($pass) { 0 } else { 2 }
Write-StabilityMetrics -OutDir $outDir -CaseId $script:stabilityCaseId -StartTime $start -FinalPass $pass -FinalReason $finalReason -ExitCode $preAnalysisExitCode | Out-Null

$analysisExit = 0
if (-not $SetupOnly) {
  if ($strictMode) {
    $analysisExit = 0
  } else {
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "analyze-core-logs.ps1") -ArtifactsDir $outDir -ScenarioPath $ScenarioPath -FinalReasonHint $finalReason -WorkspaceRoot $workspace
      $analysisExit = if ($LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
    } catch {
      $analysisExit = 1
    }
  }
}

$finalSettings = Invoke-ApiJsonWithRetry -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/orchestrator/settings" -AllowStatus @(200, 500) -RetryOnStatus @(500) -MaxAttempts 8 -InitialDelayMs 300 -RetryOnRequestFailure
$finalSessions = Invoke-ApiJsonWithRetry -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/sessions" -AllowStatus @(200, 500) -RetryOnStatus @(500) -MaxAttempts 8 -InitialDelayMs 300 -RetryOnRequestFailure
$finalTree = Invoke-ApiJsonWithRetry -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/task-tree" -AllowStatus @(200, 500) -RetryOnStatus @(500) -MaxAttempts 8 -InitialDelayMs 300 -RetryOnRequestFailure
$providerMatrixOut = [ordered]@{
  mode = [string]$resolvedMatrix.mode
  forced_provider_id = $resolvedMatrix.forced_provider_id
  providers = @($resolvedMatrix.providers)
  by_role_key = $resolvedMatrix.by_role_key
}
$providerSessionAudit = Build-ProviderSessionAudit -SessionsBody $finalSessions.body
$providerActivitySummary = Build-ProjectProviderActivitySummary -SessionAudit $providerSessionAudit
Write-Utf8NoBom -Path (Join-Path $outDir "provider_matrix_resolved.json") -Content (($providerMatrixOut | ConvertTo-Json -Depth 20))
Write-Utf8NoBom -Path (Join-Path $outDir "provider_session_audit.json") -Content (($providerSessionAudit | ConvertTo-Json -Depth 20))
Write-Utf8NoBom -Path (Join-Path $outDir "provider_activity_summary.json") -Content (($providerActivitySummary | ConvertTo-Json -Depth 20))
$finalRemaining = [int]$finalSettings.body.auto_dispatch_remaining
$consumed = $totalBudgetGranted - $finalRemaining
$runningCount = @($finalSessions.body.items | Where-Object { $_.status -eq "running" }).Count
$openExecCount = @(@($finalTree.body.nodes) | Where-Object { $_.task_kind -eq "EXECUTION" -and @("DONE", "CANCELED") -notcontains $_.state }).Count
$stabilityMetrics = Write-StabilityMetrics -OutDir $outDir -CaseId $script:stabilityCaseId -StartTime $start -FinalPass $pass -FinalReason $finalReason -ExitCode $(if ($pass -and $analysisExit -eq 0) { 0 } else { 2 })

$summary = @()
$summary += "# E2E Standard Run Summary"
$summary += ""
$summary += "- project_id: $projectId"
$summary += "- workspace: $workspace"
$summary += "- scenario: $($scenario.scenario_id)"
$summary += "- provider_mode: $providerModeLabel"
$summary += "- providers_resolved: $(@($resolvedMatrix.providers) -join ",")"
$summary += "- started_at: $($start.ToString("o"))"
$summary += "- ended_at: $((Get-Date).ToString("o"))"
$summary += "- final_reason: $finalReason"
$summary += "- pass_runtime: $pass"
$summary += "- pass_analysis: $($analysisExit -eq 0)"
$summary += "- strict_observe: $strictMode"
$summary += "- reminder_probe_pass: $(if ($reminderProbeResult) { [bool]$reminderProbeResult.pass } else { $false })"
$summary += "- reminder_probe_observation_gap: $(if ($reminderProbeResult) { [bool]$reminderProbeResult.observation_gap } else { $false })"
$summary += "- reminder_probe_dispatch_mode: $(if ($reminderProbeResult -and $reminderProbeResult.manual_dispatch_reason) { [string]$reminderProbeResult.manual_dispatch_reason } else { 'none' })"
$summary += "- auto_dispatch_budget_initial: $AutoDispatchBudget"
$summary += "- auto_dispatch_budget_granted_total: $totalBudgetGranted"
$summary += "- auto_dispatch_budget_remaining: $finalRemaining"
$summary += "- auto_dispatch_budget_consumed: $consumed"
$summary += "- auto_dispatch_topup_step: $AutoTopupStep"
$summary += "- auto_dispatch_topup_count: $topupCount"
$summary += "- auto_dispatch_topup_max: $MaxTopups"
$summary += "- auto_dispatch_total_budget_max: $MaxTotalBudget"
$summary += "- toolcall_failed_count: $($stabilityMetrics.toolcall_failed_count)"
$summary += "- timeout_recovered_count: $($stabilityMetrics.timeout_recovered_count)"
$summary += "- running_sessions_final: $runningCount"
$summary += "- open_execution_tasks_final: $openExecCount"
$summary += "- provider_session_audit_pass: $($providerSessionAudit.all_sessions_match)"
$summary += "- provider_activity_pass: $($providerActivitySummary.overall_pass)"
$summary += "- artifacts_dir: $outDir"
Write-Utf8NoBom -Path (Join-Path $outDir "run_summary.md") -Content ($summary -join [Environment]::NewLine)
} finally {
  $restoreError = $null
  try {
    $script:settingsIsolationRestoreAudit = Invoke-E2ESettingsIsolationRestore -BaseUrl $BaseUrl -Plan $script:settingsIsolationPlan
  } catch {
    $restoreError = $_
    $script:settingsIsolationRestoreAudit = Get-E2ESettingsIsolationAuditPayload -Plan $script:settingsIsolationPlan
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$outDir) -and (Test-Path -LiteralPath $outDir)) {
    Write-Utf8NoBom -Path (Join-Path $outDir "settings_isolation_audit.json") -Content (((Get-E2ESettingsIsolationAuditPayload -Plan $script:settingsIsolationPlan) | ConvertTo-Json -Depth 20))
  }
  if ($restoreError) {
    throw $restoreError
  }
}

Write-Host "== Done =="
Write-Host "artifacts=$outDir"
Write-Host "final_reason=$finalReason"
Write-Host "runtime_pass=$pass"
Write-Host "analysis_pass=$($analysisExit -eq 0)"

if (-not $pass -or $analysisExit -ne 0) {
  exit 2
}
