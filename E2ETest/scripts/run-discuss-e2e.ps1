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

$scenario = Get-Content -LiteralPath $ScenarioPath | ConvertFrom-Json
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
  auto_dispatch_remaining = $AutoDispatchBudget
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
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/task-assign-routing" -Body @{
  task_assign_route_table = $taskAssignRouteTable
} | Out-Null

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

$rootTaskId = "$projectId-root"
$taskLeadId = [string]$seedTasks.task_lead_plan.task_id
$taskBId = [string]$seedTasks.task_design_b.task_id
$taskCId = [string]$seedTasks.task_design_c.task_id
$taskDId = [string]$seedTasks.task_design_d.task_id
$taskAlignId = [string]$seedTasks.task_alignment.task_id
$taskFinalId = [string]$seedTasks.task_final.task_id

Write-Host "== Seed discuss framework task tree =="
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

$createLeadRes = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(201) -Body (
  New-TaskCreateBody -TaskId $taskLeadId -TaskKind ([string]$seedTasks.task_lead_plan.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId `
    -Title ([string]$seedTasks.task_lead_plan.title) -OwnerRole $roleLead -Priority ([int]$seedTasks.task_lead_plan.priority) `
    -Dependencies @($seedTasks.task_lead_plan.dependencies) -Content ([string]$seedTasks.task_lead_plan.content)
)

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

Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(201) -Body (
  New-TaskCreateBody -TaskId $taskBId -TaskKind ([string]$seedTasks.task_design_b.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId `
    -Title ([string]$seedTasks.task_design_b.title) -OwnerRole $roleB -Priority ([int]$seedTasks.task_design_b.priority) `
    -Dependencies @($seedTasks.task_design_b.dependencies) -Content ([string]$seedTasks.task_design_b.content)
) | Out-Null
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(201) -Body (
  New-TaskCreateBody -TaskId $taskCId -TaskKind ([string]$seedTasks.task_design_c.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId `
    -Title ([string]$seedTasks.task_design_c.title) -OwnerRole $roleC -Priority ([int]$seedTasks.task_design_c.priority) `
    -Dependencies @($seedTasks.task_design_c.dependencies) -Content ([string]$seedTasks.task_design_c.content)
) | Out-Null
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(201) -Body (
  New-TaskCreateBody -TaskId $taskDId -TaskKind ([string]$seedTasks.task_design_d.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId `
    -Title ([string]$seedTasks.task_design_d.title) -OwnerRole $roleD -Priority ([int]$seedTasks.task_design_d.priority) `
    -Dependencies @($seedTasks.task_design_d.dependencies) -Content ([string]$seedTasks.task_design_d.content)
) | Out-Null
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(201) -Body (
  New-TaskCreateBody -TaskId $taskAlignId -TaskKind ([string]$seedTasks.task_alignment.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId `
    -Title ([string]$seedTasks.task_alignment.title) -OwnerRole $roleLead -Priority ([int]$seedTasks.task_alignment.priority) `
    -Dependencies @($seedTasks.task_alignment.dependencies) -Content ([string]$seedTasks.task_alignment.content)
) | Out-Null
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(201) -Body (
  New-TaskCreateBody -TaskId $taskFinalId -TaskKind ([string]$seedTasks.task_final.task_kind) -ParentTaskId $rootTaskId -RootTaskId $rootTaskId `
    -Title ([string]$seedTasks.task_final.title) -OwnerRole $roleLead -Priority ([int]$seedTasks.task_final.priority) `
    -Dependencies @($seedTasks.task_final.dependencies) -Content ([string]$seedTasks.task_final.content)
) | Out-Null

Write-Host "== Pre-gate validation before enabling auto dispatch =="
$preGateB = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleB; task_id = $taskBId; force = $false; only_idle = $false } -AllowStatus @(200)
$preGateC = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleC; task_id = $taskCId; force = $false; only_idle = $false } -AllowStatus @(200)
$preGateD = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $roleD; task_id = $taskDId; force = $false; only_idle = $false } -AllowStatus @(200)
$preGate = @{
  invalidParentDependencyCreate = @{
    status = $invalidParentDependencyCreate.status
    body = $invalidParentDependencyCreate.body
  }
  taskDesignB = $preGateB.body
  taskDesignC = $preGateC.body
  taskDesignD = $preGateD.body
}

$stampPre = Get-Date -Format "yyyyMMdd_HHmmss"
$preCheckDir = Join-Path $artifactsBase "$stampPre-precheck"
Ensure-Dir -Path $preCheckDir
($preGate | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $preCheckDir "pre_gate_checks.json") -Encoding UTF8

Write-Host "== Kick TeamLeader with explicit discuss objective =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/messages/send" -Body @{
  from_agent = "manager"
  from_session_id = "manager-system"
  to = @{ agent = $roleLead }
  message_type = "MANAGER_MESSAGE"
  task_id = $taskLeadId
  content = "Coordinate three architecture drafts (B/C/D), run cross-review with discuss flow, then publish final consensus design."
} -AllowStatus @(201) | Out-Null

Write-Host "== Enable auto dispatch budget =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/orchestrator/settings" -Body @{
  auto_dispatch_enabled = $true
  auto_dispatch_remaining = $AutoDispatchBudget
} | Out-Null

Write-Host "== Kick first dispatch for TeamLeader =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{
  role = $roleLead
  force = $false
  only_idle = $false
} -AllowStatus @(200) | Out-Null

Write-Host "== Monitor run =="
$start = Get-Date
$finalReason = ""
$pass = $false
$topupCount = 0
$totalBudgetGranted = $AutoDispatchBudget
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

    foreach ($s in $running) {
      $sessionToken = if ($s.sessionId) { $s.sessionId } else { $null }
      if (-not $sessionToken -or -not $s.lastActiveAt) { continue }
      $last = [datetime]::Parse($s.lastActiveAt)
      if (((Get-Date).ToUniversalTime() - $last.ToUniversalTime()).TotalMinutes -gt 15) {
        Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/sessions/$sessionToken/repair" -Body @{ target_status = "idle" } -AllowStatus @(200, 404, 409) | Out-Null
        Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $s.role; force = $false; only_idle = $false } -AllowStatus @(200) | Out-Null
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
      Write-Host ("topup applied: count={0} new_remaining={1} total_budget_granted={2}" -f $topupCount, $newRemaining, $totalBudgetGranted)
      Start-Sleep -Seconds $PollSeconds
      continue
    }
    if ($openExec.Count -gt 0 -and $noRunningStreak -ge 3) {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{
        force = $false
        only_idle = $false
      } -AllowStatus @(200) | Out-Null
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
$topupLogPath = Join-Path $outDir "topup_log.json"
$topupJson = if (@($topupLog).Count -eq 0) { "[]" } else { ($topupLog | ConvertTo-Json -Depth 20) }
Set-Content -LiteralPath $topupLogPath -Value $topupJson -Encoding UTF8

$analysisExit = 0
if (-not $SetupOnly) {
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptDir "analyze-discuss-logs.ps1") -ArtifactsDir $outDir -ScenarioPath $ScenarioPath -FinalReasonHint $finalReason
    $analysisExit = if ($LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
  } catch {
    $analysisExit = 1
  }
}

$finalSettings = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/orchestrator/settings"
$finalSessions = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/sessions"
$finalTree = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/task-tree"
$finalRemaining = [int]$finalSettings.body.auto_dispatch_remaining
$consumed = $totalBudgetGranted - $finalRemaining
$runningCount = @($finalSessions.body.items | Where-Object { $_.status -eq "running" }).Count
$openExecCount = @(@($finalTree.body.nodes) | Where-Object { $_.task_kind -eq "EXECUTION" -and @("DONE","BLOCKED_DEP","CANCELED") -notcontains $_.state }).Count

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
