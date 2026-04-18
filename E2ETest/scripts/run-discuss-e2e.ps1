param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$ScenarioPath = "",
  [ValidateSet("", "codex", "minimax")]
  [string]$ProviderId = "",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestTeamDiscuss",
  [int]$AutoDispatchBudget = 30,
  [int]$MaxMinutes = 75,
  [int]$PollSeconds = 30,
  [int]$AutoTopupStep = 30,
  [int]$MaxTopups = 10,
  [int]$MaxTotalBudget = 330,
  [switch]$SetupOnly
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $scriptDir "invoke-api.ps1")
. (Join-Path $scriptDir "e2e-provider-matrix.ps1")
. (Join-Path $scriptDir "e2e-settings-isolation.ps1")

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\team-discuss-framework.json"
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

$roleLead = [string]$roles.LEAD
$roleB = [string]$roles.B
$roleC = [string]$roles.C
$roleD = [string]$roles.D
$roleList = @($roleLead, $roleB, $roleC, $roleD)
$roleByRef = @{
  LEAD = $roleLead
  B = $roleB
  C = $roleC
  D = $roleD
}
$resolvedMatrix = Resolve-E2ERoleModelMatrix -Scenario $scenario -RoleByKey $roleByRef -ForcedProviderId $ProviderId
$providerModeLabel = if ($resolvedMatrix.mode -eq "forced_provider") { [string]$resolvedMatrix.forced_provider_id } else { "mixed" }
Assert-E2EMixedProviderBaseline -ResolvedMatrix $resolvedMatrix -CaseId "discuss"

$workspace = $WorkspaceRoot
$artifactsBase = Join-Path $workspace "docs\e2e"
$scriptRunStart = Get-Date
$script:stabilityFallbackEvents = @()
$script:stabilityOutDir = $null
$script:stabilityCaseId = "discuss"
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
  $leadOwnedTaskIds = @(
    [string]$seedTasks.task_lead_plan.task_id,
    [string]$seedTasks.task_alignment.task_id,
    [string]$seedTasks.task_final.task_id
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  $roleOwnedTaskId = switch ($Role) {
    $roleLead { [string]$seedTasks.task_lead_plan.task_id }
    $roleB { [string]$seedTasks.task_design_b.task_id }
    $roleC { [string]$seedTasks.task_design_c.task_id }
    $roleD { [string]$seedTasks.task_design_d.task_id }
    default { "" }
  }
  $leadOwnedTaskText = $leadOwnedTaskIds -join ", "
  $teamToolNameRules = if ($providerId -eq "codex") {
    @(
      "Use TeamTool through the exact Codex MCP aliases exposed in this runtime, for example mcp__teamtool__task_report_in_progress, mcp__teamtool__task_report_done, mcp__teamtool__discuss_request, mcp__teamtool__discuss_reply, mcp__teamtool__discuss_close.",
      "Do not fall back to shell or local scripts for TeamTool actions."
    )
  } else {
    @(
      "Use canonical TeamTool names only: task_report_in_progress, task_report_done, task_report_block, discuss_request, discuss_reply, discuss_close.",
      "Do not prepend mcp__teamtool__ to TeamTool names in this runtime.",
      "Tool names starting with mcp__teamtool__ are invalid in this runtime and will fail."
    )
  }
  $teamToolNameText = $teamToolNameRules -join "`n"
  if ($Role -eq $roleLead) {
    return @(
      "You are TeamLeader for architecture framework design.",
      "Coordinate three architect agents and converge to one final design.",
      "Use task + discuss flow only. Do not write every design by yourself.",
      "Require B/C/D each to provide their design draft before final alignment.",
      "Your lead-owned task ids are: $leadOwnedTaskText.",
      "Your local progress file absolute path is $roleProgressPath.",
      "Use task_report_* only for your own lead-owned tasks. Collect B/C/D input through discuss threads instead of asking them to report progress on your task ids.",
      "This E2E scenario already pre-creates the execution tasks task-discuss-arch-b, task-discuss-arch-c, task-discuss-arch-d, task-discuss-alignment, and task-discuss-final-consensus.",
      "Do not call task_create_assign to recreate those pre-seeded task ids. Use the existing tasks plus discuss_request/discuss_reply to coordinate the work.",
      "Whenever you call task_report_in_progress or task_report_done, include task_report_path=$roleProgressPath using that absolute path. Never use ./progress.md or another relative path in TeamTool calls.",
      "When task-discuss-alignment has explicit review replies from B, C, and D on the existing alignment discuss threads, stop waiting and close alignment in the same run unless one of those replies contains a substantive unresolved objection.",
      "After task-discuss-alignment is DONE, immediately continue to task-discuss-final-consensus and publish the final consensus artifact instead of waiting for another reminder.",
      "If a manager message says that all required alignment replies are already routed, treat that as actionable evidence to verify the existing threads and close alignment rather than re-reporting the same blocker.",
      "When using lock_manage, lock_key must be a TeamWorkSpace-relative path such as docs/e2e/discuss-collaboration-framework.md. Never pass an absolute path or an Agents/... local path as lock_key.",
      $teamToolNameText,
      "If a TeamTool call fails, recover using next_action and do not describe the tool as unavailable."
    ) -join "`n"
  }
  return @(
    "You are architect role $Role.",
    "Your owned execution task id is $roleOwnedTaskId.",
    "Your local progress file absolute path is $roleProgressPath.",
    "Write one architecture design proposal for your owned task and share it via task report + discuss.",
    "Your owned draft task is DONE once you have delivered the draft to TeamLeader and submitted task_report_done for $roleOwnedTaskId.",
    "Later cross-review, corrections, and alignment replies happen through discuss flow. They do not keep $roleOwnedTaskId open unless you still have substantive unfinished draft work.",
    "If TeamLeader asks for draft corrections, update the draft artifact and reply in discuss. If $roleOwnedTaskId is not DONE yet, submit task_report_done once; if it is already DONE, continue in discuss only and do not resend an identical DONE report.",
    "Cross-review peers when asked and resolve conflicts with TeamLeader.",
    "Use TeamTools report/discuss tools only.",
    "Only call task_report_* on tasks you own or create. In this scenario that means your owned execution task ($roleOwnedTaskId) or a child task you explicitly create.",
    "When TeamLeader asks for input on lead-owned task ids ($leadOwnedTaskText), reply with discuss_reply or discuss_close only. Update ./progress.md locally, but do not call task_report_* on those lead-owned task ids.",
    "When the current inbox/discuss context is task-discuss-lead-plan or another lead-owned task, treat that context as coordination only. Your task_report_* calls must explicitly set task_id to $roleOwnedTaskId.",
    "In that lead-owned discuss context, do not omit task_id in task_report_* calls. Omitting task_id still counts as reporting the wrong task in this E2E run.",
    "For task_report_done in this E2E run, always include both task_id=$roleOwnedTaskId and task_report_path=$roleProgressPath. Do not rely on inferred progress text, and never use a relative task_report_path.",
    "When using lock_manage for shared docs, lock_key must stay workspace-relative, for example docs/e2e/arch-c-collaboration-draft.md. Never pass an absolute path or a path under Agents/$Role as lock_key.",
    "If task_report_* on a foreign task is rejected with TASK_RESULT_INVALID_TARGET, stop retrying that task id and continue through discuss flow.",
    $teamToolNameText,
    "If a TeamTool call fails, recover using next_action and do not describe the tool as unavailable."
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
    [string]$Content
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

  $triggerEvents = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED" -and
      [string]$_.payload.role -eq $ProbeRole
    })
  $triggerEvents = @($triggerEvents | Sort-Object { [datetime]$_.createdAt })
  $firstTriggerAt = if ($triggerEvents.Count -gt 0) { [datetime]$triggerEvents[0].createdAt } else { $null }
  $dispatchEvents = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" -and
      [string]$_.taskId -eq $ProbeTaskId -and
      ($null -eq $firstTriggerAt -or [datetime]$_.createdAt -ge $firstTriggerAt)
    })
  $redispatchEvents = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH" -and
      [string]$_.payload.role -eq $ProbeRole -and
      [string]$_.payload.outcome -eq "dispatched"
    })
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
    reminder_trigger_count = $triggerEvents.Count
    message_dispatch_count = $dispatchEvents.Count
    redispatch_count = $redispatchEvents.Count
    report_applied_count = $reportEvents.Count
    probe_state = $probeState
    probe_terminal = $probeTerminal
    trigger_pass = ($triggerEvents.Count -ge 1)
    dispatch_pass = ($dispatchEvents.Count -ge 1 -or $redispatchEvents.Count -ge 1)
    progress_pass = ($reportEvents.Count -ge 1 -or $probeTerminal)
    pass = ($triggerEvents.Count -ge 1 -and ($dispatchEvents.Count -ge 1 -or $redispatchEvents.Count -ge 1) -and ($reportEvents.Count -ge 1 -or $probeTerminal))
    trigger_events = $triggerEvents
    dispatch_events = $dispatchEvents
    redispatch_events = $redispatchEvents
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
  $manualDispatchIssued = $false
  $trace = New-Object System.Collections.Generic.List[object]

  while ((Get-Date) -lt $deadline) {
    $eventsResp = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $ProjectId
    $treeResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/task-tree" -AllowStatus @(200)
    $sessionsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions" -AllowStatus @(200)
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
      })

    if ($evidence.trigger_pass -and -not $manualDispatchIssued) {
      $dispatchResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -Body @{
        role = $ProbeRole
        task_id = $ProbeTaskId
        force = $false
        only_idle = $false
      } -AllowStatus @(200, 500)
      if ([int]$dispatchResp.status -eq 200) {
        $manualDispatchIssued = $true
      }
    }

    if ($evidence.pass) {
      return [pscustomobject]@{
        pass = $true
        evidence = $evidence
        trace = $trace.ToArray()
        events_raw = $eventsResp.raw
      }
    }

    Start-Sleep -Seconds $PollIntervalSeconds
  }

  return [pscustomobject]@{
    pass = $false
    evidence = $evidence
    trace = $trace.ToArray()
    events_raw = $eventsResp.raw
  }
}

function Wait-ForProbeInProgressAndRecycleSession {
  param(
    [string]$ProjectId,
    [string]$ProbeRole,
    [string]$ProbeTaskId,
    [int]$TimeoutMinutes,
    [int]$PollIntervalSeconds
  )

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  while ((Get-Date) -lt $deadline) {
    $treeResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/task-tree" -AllowStatus @(200)
    $sessionsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions" -AllowStatus @(200)
    $probeNode = @($treeResp.body.nodes | Where-Object { [string]$_.task_id -eq $ProbeTaskId } | Select-Object -First 1)[0]
    $probeSession = @($sessionsResp.body.items | Where-Object { [string]$_.role -eq $ProbeRole } | Select-Object -First 1)[0]
    $probeState = if ($probeNode) { [string]$probeNode.state } else { "" }

    if ($probeState -eq "DONE" -or $probeState -eq "CANCELED") {
      throw "Probe task '$ProbeTaskId' became terminal before session recycle. state=$probeState"
    }

    if ($probeState -eq "IN_PROGRESS") {
      if (-not $probeSession -or [string]::IsNullOrWhiteSpace([string]$probeSession.sessionId)) {
        throw "Active probe session for role '$ProbeRole' not found while recycling reminder probe."
      }

      $oldSessionId = [string]$probeSession.sessionId
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/sessions/$oldSessionId/dismiss" -AllowStatus @(200) | Out-Null
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/sessions" -Body @{ role = $ProbeRole } -AllowStatus @(200, 201) | Out-Null
      $refreshedSessions = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions" -AllowStatus @(200)
      $newSession = @($refreshedSessions.body.items | Where-Object { [string]$_.role -eq $ProbeRole } | Select-Object -First 1)[0]
      return [pscustomobject]@{
        recycled = $true
        previous_session_id = $oldSessionId
        new_session_id = if ($newSession) { [string]$newSession.sessionId } else { $null }
        probe_state = $probeState
      }
    }

    Start-Sleep -Seconds $PollIntervalSeconds
  }

  throw "Probe task '$ProbeTaskId' did not reach IN_PROGRESS before recycle timeout."
}

function Invoke-BestEffortDispatch {
  param(
    [string]$ProjectId,
    [hashtable]$Body,
    [string]$Reason
  )

  $dispatchResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -Body $Body -AllowStatus @(200, 500)
  if ([int]$dispatchResp.status -ne 200) {
    $detail = ""
    if ($dispatchResp.body) {
      try {
        $detail = ($dispatchResp.body | ConvertTo-Json -Depth 6 -Compress)
      } catch {
        $detail = [string]$dispatchResp.body
      }
    }
    Write-Warning ("dispatch nudge skipped: reason={0} status={1} detail={2}" -f $Reason, [int]$dispatchResp.status, $detail)
    return $false
  }

  return $true
}

function Get-DiscussAlignmentReplyEvidence {
  param(
    [object[]]$Events,
    [string]$LeadRole,
    [string]$AlignmentTaskId,
    [string[]]$ReviewerRoles
  )

  $replyByRole = @{}
  $threadPrefix = "{0}-" -f $AlignmentTaskId
  $sortedEvents = @($Events | Sort-Object { [datetime]$_.createdAt })
  foreach ($evt in $sortedEvents) {
    if ([string]$evt.eventType -ne "USER_MESSAGE_RECEIVED") { continue }
    $payload = $evt.payload
    if (-not $payload) { continue }
    if ([string]$payload.toRole -ne $LeadRole) { continue }
    $messageType = [string]$payload.messageType
    if ($messageType -ne "TASK_DISCUSS_REPLY" -and $messageType -ne "TASK_DISCUSS_CLOSED") { continue }
    $threadId = ""
    if ($payload.discuss -and $payload.discuss.threadId) {
      $threadId = [string]$payload.discuss.threadId
    }
    if ([string]::IsNullOrWhiteSpace($threadId) -or -not $threadId.StartsWith($threadPrefix)) { continue }
    $fromRole = [string]$payload.fromAgent
    if ([string]::IsNullOrWhiteSpace($fromRole) -or ($ReviewerRoles -notcontains $fromRole)) { continue }
    $replyByRole[$fromRole] = [ordered]@{
      from_role = $fromRole
      thread_id = $threadId
      request_id = [string]$payload.requestId
      message_type = $messageType
      created_at = [string]$evt.createdAt
      content = [string]$payload.content
    }
  }

  $replyItems = @()
  foreach ($role in $ReviewerRoles) {
    if ($replyByRole.ContainsKey($role)) {
      $replyItems += $replyByRole[$role]
    }
  }

  $missingRoles = @($ReviewerRoles | Where-Object { -not $replyByRole.ContainsKey($_) })
  $signature = @(
    $replyItems |
      ForEach-Object { [string]$_.request_id } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Sort-Object
  ) -join "|"

  return [pscustomobject]@{
    all_replies_present = ($missingRoles.Count -eq 0)
    missing_roles = @($missingRoles)
    replies = @($replyItems)
    signature = $signature
  }
}

function Send-DiscussManagerDispatchMessage {
  param(
    [string]$ProjectId,
    [string]$ToRole,
    [string]$TaskId,
    [string]$Content,
    [string]$Reason
  )

  $messageResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/messages/send" -Body @{
    from_agent = "manager"
    from_session_id = "manager-system"
    to = @{ agent = $ToRole }
    message_type = "MANAGER_MESSAGE"
    task_id = $TaskId
    content = $Content
  } -AllowStatus @(201, 400, 403, 404, 409)

  if ([int]$messageResp.status -ne 201 -or -not $messageResp.body) {
    $detail = ""
    if ($messageResp.body) {
      try {
        $detail = ($messageResp.body | ConvertTo-Json -Depth 10 -Compress)
      } catch {
        $detail = [string]$messageResp.body
      }
    }
    Write-Warning ("manager dispatch message skipped: reason={0} status={1} detail={2}" -f $Reason, [int]$messageResp.status, $detail)
    return $false
  }

  $messageId = [string]$messageResp.body.messageId
  if ([string]::IsNullOrWhiteSpace($messageId)) {
    Write-Warning ("manager dispatch message skipped: reason={0} missing_message_id" -f $Reason)
    return $false
  }

  $dispatchResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch-message" -Body @{
    message_id = $messageId
    only_idle = $false
    force = $false
  } -AllowStatus @(200, 400, 404, 409, 500)

  if ([int]$dispatchResp.status -ne 200) {
    $detail = ""
    if ($dispatchResp.body) {
      try {
        $detail = ($dispatchResp.body | ConvertTo-Json -Depth 10 -Compress)
      } catch {
        $detail = [string]$dispatchResp.body
      }
    }
    Write-Warning ("manager dispatch message dispatch skipped: reason={0} status={1} detail={2}" -f $Reason, [int]$dispatchResp.status, $detail)
    return $false
  }

  Add-StabilityFallbackEvent -Type "manager_dispatch_message" -Detail ("reason={0} task={1} message_id={2}" -f $Reason, $TaskId, $messageId)
  Write-Host ("manager dispatch message sent: reason={0} task={1} message_id={2}" -f $Reason, $TaskId, $messageId)
  return $true
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
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects" -Body @{
  project_id = $projectId
  name = $projectName
  workspace_path = $workspace
  agent_ids = $roleList
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  auto_dispatch_enabled = $false
  auto_dispatch_remaining = 0
  reminder_mode = "fixed_interval"
} -AllowStatus @(201) | Out-Null

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
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/routing-config" -Body @{
  agent_ids = $roleList
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  agent_model_configs = $agentModelConfigs
} | Out-Null

Write-Host "== Patch task-assign routing =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/task-assign-routing" -Body @{
  task_assign_route_table = $taskAssignRouteTable
} | Out-Null

$rootTaskId = "$projectId-root"
$taskLeadId = [string]$seedTasks.task_lead_plan.task_id
$taskBId = [string]$seedTasks.task_design_b.task_id
$taskCId = [string]$seedTasks.task_design_c.task_id
$taskDId = [string]$seedTasks.task_design_d.task_id
$taskAlignId = [string]$seedTasks.task_alignment.task_id
$taskFinalId = [string]$seedTasks.task_final.task_id

Write-Host "== Seed discuss framework task tree =="
$taskBodies = @(
  (New-TaskCreateBody -TaskId $taskLeadId -TaskKind ([string]$seedTasks.task_lead_plan.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_lead_plan.title) -OwnerRole $roleLead -Priority ([int]$seedTasks.task_lead_plan.priority) -Dependencies @($seedTasks.task_lead_plan.dependencies) -Content ([string]$seedTasks.task_lead_plan.content)),
  (New-TaskCreateBody -TaskId $taskBId -TaskKind ([string]$seedTasks.task_design_b.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_design_b.title) -OwnerRole $roleB -Priority ([int]$seedTasks.task_design_b.priority) -Dependencies @($seedTasks.task_design_b.dependencies) -Content ([string]$seedTasks.task_design_b.content)),
  (New-TaskCreateBody -TaskId $taskCId -TaskKind ([string]$seedTasks.task_design_c.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_design_c.title) -OwnerRole $roleC -Priority ([int]$seedTasks.task_design_c.priority) -Dependencies @($seedTasks.task_design_c.dependencies) -Content ([string]$seedTasks.task_design_c.content)),
  (New-TaskCreateBody -TaskId $taskDId -TaskKind ([string]$seedTasks.task_design_d.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_design_d.title) -OwnerRole $roleD -Priority ([int]$seedTasks.task_design_d.priority) -Dependencies @($seedTasks.task_design_d.dependencies) -Content ([string]$seedTasks.task_design_d.content)),
  (New-TaskCreateBody -TaskId $taskAlignId -TaskKind ([string]$seedTasks.task_alignment.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_alignment.title) -OwnerRole $roleLead -Priority ([int]$seedTasks.task_alignment.priority) -Dependencies @($seedTasks.task_alignment.dependencies) -Content ([string]$seedTasks.task_alignment.content)),
  (New-TaskCreateBody -TaskId $taskFinalId -TaskKind ([string]$seedTasks.task_final.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_final.title) -OwnerRole $roleLead -Priority ([int]$seedTasks.task_final.priority) -Dependencies @($seedTasks.task_final.dependencies) -Content ([string]$seedTasks.task_final.content))
)
foreach ($body in $taskBodies) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(201) -Body $body | Out-Null
}

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

Write-Host "== Negative check: dependency cannot include parent task =="
$invalidParentDependencyCreate = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(409) -Body @{
  action_type = "TASK_CREATE"
  from_agent = "manager"
  from_session_id = "manager-system"
  task_id = "task-discuss-invalid-parent-dep"
  task_kind = "EXECUTION"
  parent_task_id = $taskLeadId
  root_task_id = $rootTaskId
  title = "Invalid parent dependency probe"
  owner_role = $roleD
  priority = 1
  dependencies = @($taskLeadId)
  content = "This should be rejected by dependency gate."
}
if ($invalidParentDependencyCreate.status -ne 409) {
  $errorCode = ""
  if ($invalidParentDependencyCreate.body) {
    if ($invalidParentDependencyCreate.body.error_code) { $errorCode = [string]$invalidParentDependencyCreate.body.error_code }
    elseif ($invalidParentDependencyCreate.body.code) { $errorCode = [string]$invalidParentDependencyCreate.body.code }
    elseif ($invalidParentDependencyCreate.body.error) { $errorCode = [string]$invalidParentDependencyCreate.body.error }
  }
  throw ("Invalid parent dependency probe failed. expected status=409, got status={0} code={1} raw={2}" -f $invalidParentDependencyCreate.status, $errorCode, $invalidParentDependencyCreate.raw)
}

Write-Host "== Pre-dispatch dependency validation =="
$preGateB = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleB; task_id = $taskBId; force = $false; only_idle = $false } -AllowStatus @(200)
$preGateC = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleC; task_id = $taskCId; force = $false; only_idle = $false } -AllowStatus @(200)
$preGateD = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleD; task_id = $taskDId; force = $false; only_idle = $false } -AllowStatus @(200)
$preGate = @{
  invalidParentDependencyCreate = @{ status = $invalidParentDependencyCreate.status; body = $invalidParentDependencyCreate.body }
  taskDesignB = $preGateB.body
  taskDesignC = $preGateC.body
  taskDesignD = $preGateD.body
}

$stampPre = Get-Date -Format "yyyyMMdd_HHmmss"
$preCheckDir = Join-Path $artifactsBase "$stampPre-precheck"
Ensure-Dir -Path $preCheckDir
($preGate | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $preCheckDir "pre_gate_checks.json") -Encoding UTF8

if (-not $SetupOnly) {
  Write-Host "== Kick TeamLeader and enable auto dispatch =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/messages/send" -Body @{
    from_agent = "manager"
    from_session_id = "manager-system"
    to = @{ agent = $roleLead }
    message_type = "MANAGER_MESSAGE"
    task_id = $taskLeadId
    content = "Coordinate three architecture drafts (B/C/D), run cross-review with discuss flow, then publish final consensus design."
  } -AllowStatus @(201) | Out-Null

  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/orchestrator/settings" -Body @{
    auto_dispatch_enabled = $true
    auto_dispatch_remaining = $AutoDispatchBudget
    reminder_mode = "fixed_interval"
  } | Out-Null

  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{
    role = $roleLead
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
$alignmentConvergenceNudgeSignature = ""
$finalConsensusNudgeIssued = $false

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
    $terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
    $openExec = @($executionNodes | Where-Object { $terminalStates -notcontains $_.state })
    $running = @($sessionsNow.body.items | Where-Object { $_.status -eq "running" -and [string]$_.role -ne "manager" })
    $managerRunning = @($sessionsNow.body.items | Where-Object { $_.status -eq "running" -and [string]$_.role -eq "manager" })
    $activeRoles = New-Object System.Collections.Generic.HashSet[string]
    foreach ($session in @($sessionsNow.body.items)) {
      if (-not [string]::IsNullOrWhiteSpace([string]$session.role)) {
        $null = $activeRoles.Add([string]$session.role)
      }
    }
    Write-Host ("remaining={0} exec={1} open_exec={2} running={3} manager_running={4}" -f $remaining, $executionNodes.Count, $openExec.Count, $running.Count, $managerRunning.Count)
    if ($openExec.Count -gt 0 -and $running.Count -eq 0) {
      $noRunningStreak += 1
    } else {
      $noRunningStreak = 0
    }

    foreach ($s in $running) {
      $sessionToken = if ($s.sessionId) { $s.sessionId } else { $null }
      if (-not $sessionToken -or -not $s.lastActiveAt) { continue }
      $last = [datetime]::Parse($s.lastActiveAt)
      if (((Get-Date).ToUniversalTime() - $last.ToUniversalTime()).TotalMinutes -gt 15) {
        Add-StabilityFallbackEvent -Type "repair" -Detail ("role={0} session={1}" -f [string]$s.role, [string]$sessionToken)
        Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/sessions/$sessionToken/repair" -Body @{ target_status = "idle" } -AllowStatus @(200, 404, 409) | Out-Null
        Add-StabilityFallbackEvent -Type "dispatch_nudge" -Detail ("reason=repair role={0}" -f [string]$s.role)
        $null = Invoke-BestEffortDispatch -ProjectId $projectId -Body @{ role = $s.role; force = $false; only_idle = $false } -Reason ("repair:{0}" -f [string]$s.role)
      }
    }

    $recreatedRoles = @()
    foreach ($node in $openExec) {
      $ownerRole = if ($node.owner_role) { [string]$node.owner_role } else { [string]$node.ownerRole }
      if ([string]::IsNullOrWhiteSpace($ownerRole) -or $activeRoles.Contains($ownerRole)) {
        continue
      }
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/sessions" -Body @{ role = $ownerRole } -AllowStatus @(200, 201, 409) | Out-Null
      $null = $activeRoles.Add($ownerRole)
      $recreatedRoles += $ownerRole
    }
    if ($recreatedRoles.Count -gt 0) {
      Write-Host ("recreated sessions for open roles: {0}" -f (($recreatedRoles | Select-Object -Unique) -join ","))
      Start-Sleep -Seconds ([Math]::Max(2, [Math]::Min($PollSeconds, 5)))
      continue
    }

    $nodeMap = Get-NodeByIdMap -Nodes $nodes
    $alignmentNode = if ($nodeMap.ContainsKey($taskAlignId)) { $nodeMap[$taskAlignId] } else { $null }
    $finalConsensusNode = if ($nodeMap.ContainsKey($taskFinalId)) { $nodeMap[$taskFinalId] } else { $null }
    if ($openExec.Count -gt 0 -and $running.Count -eq 0) {
      $eventsNow = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $projectId
      $alignmentEvidence = Get-DiscussAlignmentReplyEvidence -Events $eventsNow.items -LeadRole $roleLead -AlignmentTaskId $taskAlignId -ReviewerRoles @($roleB, $roleC, $roleD)

      $alignmentNeedsClosure = (
        $alignmentNode -and
        [string]$alignmentNode.state -ne "DONE" -and
        $alignmentEvidence.all_replies_present -and
        -not [string]::IsNullOrWhiteSpace([string]$alignmentEvidence.signature) -and
        [string]$alignmentEvidence.signature -ne $alignmentConvergenceNudgeSignature
      )
      if ($alignmentNeedsClosure) {
        $alignmentReplySummary = @(
          $alignmentEvidence.replies |
            ForEach-Object { "{0} reply on {1} at {2}" -f [string]$_.from_role, [string]$_.thread_id, [string]$_.created_at }
        ) -join "; "
        $alignmentMessage = @(
          "E2E convergence nudge: the required alignment review replies are already routed to you.",
          "Current evidence: $alignmentReplySummary.",
          "Do not wait for another reminder or duplicate reply.",
          "Re-read the existing alignment threads and close task-discuss-alignment now unless one of those replies contains a substantive unresolved objection.",
          "If alignment closes cleanly, continue into task-discuss-final-consensus in the same run or the next immediate run."
        ) -join " "
        $alignmentNudgeApplied = Send-DiscussManagerDispatchMessage -ProjectId $projectId -ToRole $roleLead -TaskId $taskAlignId -Content $alignmentMessage -Reason "alignment_convergence"
        if ($alignmentNudgeApplied) {
          $alignmentConvergenceNudgeSignature = [string]$alignmentEvidence.signature
          $noRunningStreak = 0
          Start-Sleep -Seconds $PollSeconds
          continue
        }
      }

      $finalNeedsNudge = (
        $finalConsensusNode -and
        [string]$alignmentNode.state -eq "DONE" -and
        [string]$finalConsensusNode.state -ne "DONE" -and
        -not $finalConsensusNudgeIssued
      )
      if ($finalNeedsNudge) {
        $finalMessage = @(
          "E2E convergence nudge: task-discuss-alignment is already DONE.",
          "Proceed to task-discuss-final-consensus now, publish the final consensus artifact, and report task-discuss-final-consensus DONE when the artifact is complete.",
          "Do not wait for a fresh reminder if no substantive blocker remains."
        ) -join " "
        $finalNudgeApplied = Send-DiscussManagerDispatchMessage -ProjectId $projectId -ToRole $roleLead -TaskId $taskFinalId -Content $finalMessage -Reason "final_consensus_convergence"
        if ($finalNudgeApplied) {
          $finalConsensusNudgeIssued = $true
          $noRunningStreak = 0
          Start-Sleep -Seconds $PollSeconds
          continue
        }
      }
    }

    if ($openExec.Count -eq 0 -and $running.Count -eq 0) {
      $pass = $true
      $finalReason = "closed_loop"
      break
    }
    if ($remaining -le 0 -and $openExec.Count -gt 0) {
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
    if ($openExec.Count -gt 0 -and $noRunningStreak -ge 3) {
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
        $nudgeApplied = Invoke-BestEffortDispatch -ProjectId $projectId -Body @{ role = $nudgeRole; force = $false; only_idle = $false } -Reason ("idle_streak:{0}:{1}" -f $noRunningStreak, $nudgeRole)
        $nudgeResults += [pscustomobject]@{
          role = $nudgeRole
          success = $nudgeApplied
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

$analysisExit = 0
if (-not $SetupOnly) {
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "analyze-discuss-logs.ps1") -ArtifactsDir $outDir -ScenarioPath $ScenarioPath -FinalReasonHint $finalReason
    $analysisExit = if ($LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
  } catch {
    $analysisExit = 1
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
$openExecCount = @(@($finalTree.body.nodes) | Where-Object { $_.task_kind -eq "EXECUTION" -and @("DONE","BLOCKED_DEP","CANCELED") -notcontains $_.state }).Count
$stabilityMetrics = Write-StabilityMetrics -OutDir $outDir -CaseId $script:stabilityCaseId -StartTime $start -FinalPass $pass -FinalReason $finalReason -ExitCode $(if ($pass -and $analysisExit -eq 0) { 0 } else { 2 })

$summary = @()
$summary += "# E2E Discuss Run Summary"
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
[System.IO.File]::WriteAllLines((Join-Path $outDir "run_summary.md"), $summary, [System.Text.UTF8Encoding]::new($false))
} finally {
  $restoreError = $null
  try {
    $script:settingsIsolationRestoreAudit = Invoke-E2ESettingsIsolationRestore -BaseUrl $BaseUrl -Plan $script:settingsIsolationPlan
  } catch {
    $restoreError = $_
    $script:settingsIsolationRestoreAudit = Get-E2ESettingsIsolationAuditPayload -Plan $script:settingsIsolationPlan
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$outDir) -and (Test-Path -LiteralPath $outDir)) {
    [System.IO.File]::WriteAllLines((Join-Path $outDir "settings_isolation_audit.json"), @(((Get-E2ESettingsIsolationAuditPayload -Plan $script:settingsIsolationPlan) | ConvertTo-Json -Depth 20)), [System.Text.UTF8Encoding]::new($false))
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
