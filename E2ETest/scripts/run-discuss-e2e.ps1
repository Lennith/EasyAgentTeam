param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$ScenarioPath = "",
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
$modelCfg = $scenario.agent_model
$providerIdRaw = if ($modelCfg.provider_id) { [string]$modelCfg.provider_id } else { [string]$modelCfg.tool }
$providerId = $providerIdRaw.Trim().ToLower()
if ([string]::IsNullOrWhiteSpace($providerId)) {
  $providerId = "minimax"
}
if ($providerId -ne "minimax") {
  throw "This E2E case requires MiniMax provider. scenario.agent_model.provider_id='$providerId'"
}

$roleLead = [string]$roles.LEAD
$roleB = [string]$roles.B
$roleC = [string]$roles.C
$roleD = [string]$roles.D
$roleList = @($roleLead, $roleB, $roleC, $roleD)

$workspace = $WorkspaceRoot
$artifactsBase = Join-Path $workspace "docs\e2e"
$scriptRunStart = Get-Date
$script:stabilityFallbackEvents = @()
$script:stabilityOutDir = $null
$script:stabilityCaseId = "discuss"
$finalReason = "not_started"
$pass = $false
$analysisExit = 1

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
  Write-StabilityMetrics -OutDir $trapOutDir -CaseId $script:stabilityCaseId -StartTime $scriptRunStart -FinalPass $false -FinalReason $finalReason -ExitCode 2
  exit 2
}

function Build-AgentPrompt {
  param([string]$Role)
  if ($Role -eq $roleLead) {
    return @(
      "You are TeamLeader for architecture framework design.",
      "Coordinate three architect agents and converge to one final design.",
      "Use task + discuss flow only. Do not write every design by yourself.",
      "Require B/C/D each to provide their design draft before final alignment."
    ) -join "`n"
  }
  return @(
    "You are architect role $Role.",
    "Write one architecture design proposal and share it via task report + discuss.",
    "Cross-review peers when asked and resolve conflicts with TeamLeader.",
    "Use TeamTools report/discuss tools only."
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

Write-Host "== Preflight =="
$health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz"
if ($health.body.status -ne "ok") {
  throw "healthz is not ok"
}

Write-Host "== Reset workspace (full clean) before run =="
Reset-WorkspaceDirectory -WorkspaceRoot $workspace
Ensure-Dir -Path $workspace

Write-Host "== Reset target project if exists =="
$projects = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects"
$exists = $false
if ($projects.body.items) {
  $exists = @($projects.body.items | Where-Object { $_.projectId -eq $projectId }).Count -gt 0
}
if ($exists) {
  Remove-ProjectWithRetry -BaseUrl $BaseUrl -ProjectId $projectId | Out-Null
}

Write-Host "== Upsert agents =="
$agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents"
$known = @{}
foreach ($a in @($agentList.body.items)) { $known[$a.agentId] = $true }

foreach ($role in $roleList) {
  $payload = @{
    agent_id = $role
    display_name = $role
    prompt = (Build-AgentPrompt -Role $role)
    provider_id = $providerId
    default_model_params = @{
      model = [string]$modelCfg.model
      effort = [string]$modelCfg.effort
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

Write-Host "== Patch routing model config =="
$agentModelConfigs = @{}
foreach ($role in $roleList) {
  $agentModelConfigs[$role] = @{
    provider_id = $providerId
    model = [string]$modelCfg.model
    effort = [string]$modelCfg.effort
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
  $sessionProvider = [string]$item.provider
  if ($sessionProvider.Trim().ToLower() -ne "minimax") {
    throw "Session provider must be minimax. session_id=$($item.sessionId) role=$($item.role) provider=$sessionProvider"
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
    $treeNow = Invoke-ApiJsonWithRetry -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/task-tree" -AllowStatus @(200, 500) -RetryOnStatus @(500) -MaxAttempts 6 -InitialDelayMs 300 -RetryOnRequestFailure

    $remaining = [int]$settingsNow.body.auto_dispatch_remaining
    $nodes = @($treeNow.body.nodes)
    $executionNodes = @($nodes | Where-Object { $_.task_kind -eq "EXECUTION" })
    $terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
    $openExec = @($executionNodes | Where-Object { $terminalStates -notcontains $_.state })
    $running = @($sessionsNow.body.items | Where-Object { $_.status -eq "running" })
    $activeRoles = New-Object System.Collections.Generic.HashSet[string]
    foreach ($session in @($sessionsNow.body.items)) {
      if (-not [string]::IsNullOrWhiteSpace([string]$session.role)) {
        $null = $activeRoles.Add([string]$session.role)
      }
    }
    Write-Host ("remaining={0} exec={1} open_exec={2} running={3}" -f $remaining, $executionNodes.Count, $openExec.Count, $running.Count)
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
      $nudgeApplied = Invoke-BestEffortDispatch -ProjectId $projectId -Body @{ force = $false; only_idle = $false } -Reason ("idle_streak:{0}" -f $noRunningStreak)
      Add-StabilityFallbackEvent -Type "dispatch_nudge" -Detail ("reason=idle_streak streak={0} success={1}" -f $noRunningStreak, $nudgeApplied)
      Write-Host ("dispatch nudge attempted after idle streak={0} success={1}" -f $noRunningStreak, $nudgeApplied)
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
$summary += "- artifacts_dir: $outDir"
[System.IO.File]::WriteAllLines((Join-Path $outDir "run_summary.md"), $summary, [System.Text.UTF8Encoding]::new($false))

Write-Host "== Done =="
Write-Host "artifacts=$outDir"
Write-Host "final_reason=$finalReason"
Write-Host "runtime_pass=$pass"
Write-Host "analysis_pass=$($analysisExit -eq 0)"

if (-not $pass -or $analysisExit -ne 0) {
  exit 2
}
