param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$ScenarioPath = "",
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

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\a-self-decompose-chain.json"
}

if (-not (Test-Path -LiteralPath $ScenarioPath)) {
  throw "Scenario file not found: $ScenarioPath"
}

$scenario = Get-Content -LiteralPath $ScenarioPath -Raw | ConvertFrom-Json
$projectId = [string]$scenario.project_id
$projectName = [string]$scenario.project_name
$seedTasks = $scenario.seed_tasks
$roles = $scenario.roles
$routeTable = $scenario.route_table
$taskAssignRouteTable = $scenario.task_assign_route_table
$routeDiscussRounds = $scenario.route_discuss_rounds
$modelCfg = $scenario.agent_model
$reminderProbe = $scenario.reminder_probe
$providerIdRaw = if ($modelCfg.provider_id) { [string]$modelCfg.provider_id } else { [string]$modelCfg.tool }
$providerId = $providerIdRaw.Trim().ToLower()
if ([string]::IsNullOrWhiteSpace($providerId)) {
  $providerId = "minimax"
}
if ($providerId -ne "minimax") {
  throw "This E2E case requires MiniMax provider. scenario.agent_model.provider_id='$providerId'"
}

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

$workspace = $WorkspaceRoot
$artifactsBase = Join-Path $workspace "docs\e2e"
$strictMode = $StrictObserve.IsPresent

function Build-AgentPrompt {
  param([string]$Role)
  if ($Role -eq $roleA) {
    return @(
      "You are role A (lead orchestrator).",
      "Execute assigned tasks and coordinate dependency progress.",
      "Do not bypass task dependencies.",
      "Use TeamTools report scripts to update progress and completion."
    ) -join "`n"
  }
  return @(
    "You are implementation role $Role.",
    "Only execute assigned tasks and report through TeamTools.",
    "Use report_in_progress during work, report_task_done when complete, report_task_block when blocked."
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
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -Body @{
        role = $ProbeRole
        task_id = $ProbeTaskId
        force = $false
        only_idle = $false
      } -AllowStatus @(200) | Out-Null
      $manualDispatchIssued = $true
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
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/projects/$projectId" | Out-Null
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

Write-Host "== Patch routing model config =="
$agentModelConfigs = @{}
foreach ($role in $roleList) {
  $agentModelConfigs[$role] = @{
    provider_id = $providerId
    model = [string]$modelCfg.model
    effort = [string]$modelCfg.effort
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
  $sessionProvider = [string]$item.provider
  if ($sessionProvider.Trim().ToLower() -ne "minimax") {
    throw "Session provider must be minimax. session_id=$($item.sessionId) role=$($item.role) provider=$sessionProvider"
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
  (New-TaskCreateBody -TaskId $probeTaskId -TaskKind "EXECUTION" -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title "Reminder probe task for role $probeRole" -OwnerRole $probeRole -Priority 105 -Dependencies @() -Content "Create docs/e2e/standard_reminder_probe.md with a short status note mentioning reminder probe done, then report this task DONE."),
  (New-TaskCreateBody -TaskId $taskAId -TaskKind ([string]$seedTasks.task_a.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_a.title) -OwnerRole $roleA -Priority ([int]$seedTasks.task_a.priority) -Dependencies @($seedTasks.task_a.dependencies) -Content ([string]$seedTasks.task_a.content)),
  (New-TaskCreateBody -TaskId $taskBId -TaskKind ([string]$seedTasks.task_b_placeholder.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_b_placeholder.title) -OwnerRole $roleA -Priority ([int]$seedTasks.task_b_placeholder.priority) -Dependencies @($seedTasks.task_b_placeholder.dependencies) -Content ([string]$seedTasks.task_b_placeholder.content)),
  (New-TaskCreateBody -TaskId $taskB1Id -TaskKind ([string]$seedTasks.task_b1_child.task_kind) -ParentTaskId $taskBId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_b1_child.title) -OwnerRole $roleB -Priority ([int]$seedTasks.task_b1_child.priority) -Dependencies @($seedTasks.task_b1_child.dependencies) -Content ([string]$seedTasks.task_b1_child.content)),
  (New-TaskCreateBody -TaskId $taskCId -TaskKind ([string]$seedTasks.task_c.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId -Title ([string]$seedTasks.task_c.title) -OwnerRole $roleC -Priority ([int]$seedTasks.task_c.priority) -Dependencies @($seedTasks.task_c.dependencies) -Content ([string]$seedTasks.task_c.content))
)
foreach ($body in $taskBodies) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -Body $body -AllowStatus @(201) | Out-Null
}

Write-Host "== Pre-gate validation before releasing reminder gate =="
$preGateB1 = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleB; task_id = $taskB1Id; force = $false; only_idle = $false } -AllowStatus @(200)
$preGateC = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleC; task_id = $taskCId; force = $false; only_idle = $false } -AllowStatus @(200)
$preGate = @{ taskB1 = $preGateB1.body; taskC = $preGateC.body }

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
    $settingsNow = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/orchestrator/settings"
    $sessionsNow = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/sessions"
    $treeNow = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/task-tree"

    $remaining = [int]$settingsNow.body.auto_dispatch_remaining
    $nodes = @($treeNow.body.nodes)
    $executionNodes = @($nodes | Where-Object { $_.task_kind -eq "EXECUTION" })
    $terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
    $openExec = @($executionNodes | Where-Object { $terminalStates -notcontains $_.state })
    $running = @($sessionsNow.body.items | Where-Object { $_.status -eq "running" })
    Write-Host ("remaining={0} exec={1} open_exec={2} running={3}" -f $remaining, $executionNodes.Count, $openExec.Count, $running.Count)
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
          Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/sessions/$sessionToken/repair" -Body @{ target_status = "idle" } -AllowStatus @(200, 404, 409) | Out-Null
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
      Write-Host ("topup applied: count={0} new_remaining={1} total_budget_granted={2}" -f $topupCount, $newRemaining, $totalBudgetGranted)
      Start-Sleep -Seconds $PollSeconds
      continue
    }
    if ((-not $strictMode) -and $openExec.Count -gt 0 -and $noRunningStreak -ge 3) {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ force = $false; only_idle = $false } -AllowStatus @(200) | Out-Null
      Write-Host ("dispatch nudge applied after idle streak={0}" -f $noRunningStreak)
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

$analysisExit = 0
if (-not $SetupOnly) {
  if ($strictMode) {
    $analysisExit = 0
  } else {
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "analyze-core-logs.ps1") -ArtifactsDir $outDir -ScenarioPath $ScenarioPath -FinalReasonHint $finalReason
      $analysisExit = if ($LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
    } catch {
      $analysisExit = 1
    }
  }
}

$finalSettings = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/orchestrator/settings"
$finalSessions = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/sessions"
$finalTree = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/task-tree"
$finalRemaining = [int]$finalSettings.body.auto_dispatch_remaining
$consumed = $totalBudgetGranted - $finalRemaining
$runningCount = @($finalSessions.body.items | Where-Object { $_.status -eq "running" }).Count
$openExecCount = @(@($finalTree.body.nodes) | Where-Object { $_.task_kind -eq "EXECUTION" -and @("DONE", "BLOCKED_DEP", "CANCELED") -notcontains $_.state }).Count

$summary = @()
$summary += "# E2E Standard Run Summary"
$summary += ""
$summary += "- project_id: $projectId"
$summary += "- workspace: $workspace"
$summary += "- scenario: $($scenario.scenario_id)"
$summary += "- started_at: $($start.ToString("o"))"
$summary += "- ended_at: $((Get-Date).ToString("o"))"
$summary += "- final_reason: $finalReason"
$summary += "- pass_runtime: $pass"
$summary += "- pass_analysis: $($analysisExit -eq 0)"
$summary += "- strict_observe: $strictMode"
$summary += "- reminder_probe_pass: $(if ($reminderProbeResult) { [bool]$reminderProbeResult.pass } else { $false })"
$summary += "- auto_dispatch_budget_initial: $AutoDispatchBudget"
$summary += "- auto_dispatch_budget_granted_total: $totalBudgetGranted"
$summary += "- auto_dispatch_budget_remaining: $finalRemaining"
$summary += "- auto_dispatch_budget_consumed: $consumed"
$summary += "- auto_dispatch_topup_step: $AutoTopupStep"
$summary += "- auto_dispatch_topup_count: $topupCount"
$summary += "- auto_dispatch_topup_max: $MaxTopups"
$summary += "- auto_dispatch_total_budget_max: $MaxTotalBudget"
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
