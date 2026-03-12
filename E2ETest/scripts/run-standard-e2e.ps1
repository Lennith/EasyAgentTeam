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

$roleA = [string]$roles.A
$roleB = [string]$roles.B
$roleC = [string]$roles.C
$roleD = [string]$roles.D
$roleList = @($roleA, $roleB, $roleC, $roleD)

$workspace = $WorkspaceRoot
$artifactsBase = Join-Path $workspace "docs\e2e"

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
$assignPatch = @{
  task_assign_route_table = $taskAssignRouteTable
}
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

Write-Host "== Seed dependency test task tree (A -> B placeholder -> B1, and C depends on B) =="
$rootTaskId = "$projectId-root"
$taskAId = [string]$seedTasks.task_a.task_id
$taskBId = [string]$seedTasks.task_b_placeholder.task_id
$taskB1Id = [string]$seedTasks.task_b1_child.task_id
$taskCId = [string]$seedTasks.task_c.task_id

$taskABody = @{
  action_type = "TASK_CREATE"
  from_agent = "manager"
  from_session_id = "manager-system"
  task_id = $taskAId
  task_kind = [string]$seedTasks.task_a.task_kind
  parent_task_id = $rootTaskId
  root_task_id = $rootTaskId
  title = [string]$seedTasks.task_a.title
  owner_role = $roleA
  priority = [int]$seedTasks.task_a.priority
  dependencies = @($seedTasks.task_a.dependencies)
  content = [string]$seedTasks.task_a.content
}
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -Body $taskABody -AllowStatus @(201) | Out-Null

$taskBBody = @{
  action_type = "TASK_CREATE"
  from_agent = "manager"
  from_session_id = "manager-system"
  task_id = $taskBId
  task_kind = [string]$seedTasks.task_b_placeholder.task_kind
  parent_task_id = $rootTaskId
  root_task_id = $rootTaskId
  title = [string]$seedTasks.task_b_placeholder.title
  owner_role = $roleA
  priority = [int]$seedTasks.task_b_placeholder.priority
  dependencies = @($seedTasks.task_b_placeholder.dependencies)
  content = [string]$seedTasks.task_b_placeholder.content
}
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -Body $taskBBody -AllowStatus @(201) | Out-Null

$taskB1Body = @{
  action_type = "TASK_CREATE"
  from_agent = "manager"
  from_session_id = "manager-system"
  task_id = $taskB1Id
  task_kind = [string]$seedTasks.task_b1_child.task_kind
  parent_task_id = $taskBId
  root_task_id = $rootTaskId
  title = [string]$seedTasks.task_b1_child.title
  owner_role = $roleB
  priority = [int]$seedTasks.task_b1_child.priority
  dependencies = @($seedTasks.task_b1_child.dependencies)
  content = [string]$seedTasks.task_b1_child.content
}
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -Body $taskB1Body -AllowStatus @(201) | Out-Null

$taskCBody = @{
  action_type = "TASK_CREATE"
  from_agent = "manager"
  from_session_id = "manager-system"
  task_id = $taskCId
  task_kind = [string]$seedTasks.task_c.task_kind
  parent_task_id = $rootTaskId
  root_task_id = $rootTaskId
  title = [string]$seedTasks.task_c.title
  owner_role = $roleC
  priority = [int]$seedTasks.task_c.priority
  dependencies = @($seedTasks.task_c.dependencies)
  content = [string]$seedTasks.task_c.content
}
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -Body $taskCBody -AllowStatus @(201) | Out-Null

Write-Host "== Pre-gate validation before enabling auto dispatch =="
$preGateB1 = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{
  role = $roleB
  task_id = $taskB1Id
  force = $false
  only_idle = $false
} -AllowStatus @(200)
$preGateC = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{
  role = $roleC
  task_id = $taskCId
  force = $false
  only_idle = $false
} -AllowStatus @(200)
$preGate = @{
  taskB1 = $preGateB1.body
  taskC = $preGateC.body
}

Write-Host "== Save pre-gate check =="
$stampPre = Get-Date -Format "yyyyMMdd_HHmmss"
$preCheckDir = Join-Path $artifactsBase "$stampPre-precheck"
Ensure-Dir -Path $preCheckDir
($preGate | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $preCheckDir "pre_gate_checks.json") -Encoding UTF8
Write-Host "pre_gate_checks=$preCheckDir"

Write-Host "== Keep one manager message for A to start work context =="
$kickMessage = @{
  from_agent = "manager"
  from_session_id = "manager-system"
  to = @{ agent = $roleA }
  message_type = "MANAGER_MESSAGE"
  task_id = $taskAId
  content = "Start from task A. Follow dependency chain and report progress with TeamTools."
}
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/messages/send" -Body $kickMessage -AllowStatus @(201) | Out-Null

Write-Host "== Enable auto dispatch budget =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/orchestrator/settings" -Body @{
  auto_dispatch_enabled = $true
  auto_dispatch_remaining = $AutoDispatchBudget
} | Out-Null

Write-Host "== Kick first dispatch for A =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{
  role = $roleA
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
$strictMode = $StrictObserve.IsPresent

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
$openExecCount = @(@($finalTree.body.nodes) | Where-Object { $_.task_kind -eq "EXECUTION" -and @("DONE","BLOCKED_DEP","CANCELED") -notcontains $_.state }).Count

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
