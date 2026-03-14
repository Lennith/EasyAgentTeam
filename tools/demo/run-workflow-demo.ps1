param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$TemplatePath = "",
  [string]$WorkspaceRoot = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $repoRoot "E2ETest\scripts\invoke-api.ps1")

if (-not $TemplatePath) {
  $TemplatePath = Join-Path $repoRoot "docs\demos\templates\workflow-mode-demo.json"
}
if (-not (Test-Path -LiteralPath $TemplatePath)) {
  throw "Template file not found: $TemplatePath"
}

$template = Get-Content -LiteralPath $TemplatePath -Raw | ConvertFrom-Json
$teamId = [string]$template.team_id
$teamName = [string]$template.team_name
$templateId = [string]$template.template_id
$workflowName = [string]$template.workflow_name
$workspace = if ($WorkspaceRoot) { $WorkspaceRoot } else { [string]$template.workspace_path }
$runId = "{0}_{1}" -f [string]$template.run_id_prefix, (Get-Date -Format "yyyyMMddHHmmss")
$agents = @($template.agents)
$agentIds = @($agents | ForEach-Object { [string]$_.agent_id })
$routeTable = $template.route_table
$taskAssignRouteTable = $template.task_assign_route_table
$routeDiscussRounds = $template.route_discuss_rounds
$tasks = @($template.tasks)
$dispatchRole = [string]$template.dispatch_target.role
$dispatchTaskId = [string]$template.dispatch_target.task_id
$sessionByRole = @{}

if ([string]::IsNullOrWhiteSpace($templateId)) {
  throw "template_id is required in template."
}
if ([string]::IsNullOrWhiteSpace($workspace)) {
  throw "workspace_path is required in template."
}

Write-Host "== Workflow demo: preflight =="
$health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz" -AllowStatus @(200)
if ([string]$health.body.status -ne "ok") {
  throw "healthz is not ok"
}

Write-Host "== Reset workspace =="
Reset-WorkspaceDirectory -WorkspaceRoot $workspace
Ensure-Dir -Path $workspace

Write-Host "== Upsert agents =="
$agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents" -AllowStatus @(200)
$knownAgentIds = @{}
foreach ($row in @($agentList.body.items)) {
  $id = [string]$row.agentId
  if (-not [string]::IsNullOrWhiteSpace($id)) {
    $knownAgentIds[$id] = $true
  }
}

foreach ($agent in $agents) {
  $agentId = [string]$agent.agent_id
  $payload = @{
    agent_id = $agentId
    display_name = [string]$agent.display_name
    prompt = [string]$agent.prompt
    provider_id = [string]$agent.provider_id
    default_model_params = @{
      model = [string]$agent.default_model_params.model
      effort = [string]$agent.default_model_params.effort
    }
    model_selection_enabled = $true
  }
  if ($knownAgentIds.ContainsKey($agentId)) {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$agentId" -Body $payload -AllowStatus @(200) | Out-Null
  } else {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -Body $payload -AllowStatus @(201) | Out-Null
  }
}

$agentModelConfigs = @{}
foreach ($agent in $agents) {
  $agentModelConfigs[[string]$agent.agent_id] = @{
    provider_id = [string]$agent.provider_id
    model = [string]$agent.default_model_params.model
    effort = [string]$agent.default_model_params.effort
  }
}

if (-not [string]::IsNullOrWhiteSpace($teamId)) {
  Write-Host "== Upsert demo team =="
  $teamPayload = @{
    team_id = $teamId
    name = if ([string]::IsNullOrWhiteSpace($teamName)) { $teamId } else { $teamName }
    description = "Official workflow demo team"
    agent_ids = $agentIds
    route_table = $routeTable
    task_assign_route_table = $taskAssignRouteTable
    route_discuss_rounds = $routeDiscussRounds
    agent_model_configs = $agentModelConfigs
  }
  $teamResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/teams/$teamId" -AllowStatus @(200, 404)
  if ([int]$teamResp.status -eq 200) {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method PUT -Path "/api/teams/$teamId" -AllowStatus @(200) -Body $teamPayload | Out-Null
  } else {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/teams" -AllowStatus @(201) -Body $teamPayload | Out-Null
  }
}

Write-Host "== Upsert workflow template =="
$templateTasks = @()
foreach ($task in $tasks) {
  $templateTasks += @{
    task_id = [string]$task.task_id
    title = [string]$task.title
    owner_role = [string]$task.owner_role
    dependencies = @($task.dependencies | ForEach-Object { [string]$_ })
    acceptance = @($task.acceptance | ForEach-Object { [string]$_ })
    artifacts = @($task.artifacts | ForEach-Object { [string]$_ })
  }
}

$templatePayload = @{
  template_id = $templateId
  name = $workflowName
  description = "Official workflow mode demo template"
  tasks = $templateTasks
  route_table = $routeTable
  task_assign_route_table = $taskAssignRouteTable
  route_discuss_rounds = $routeDiscussRounds
  default_variables = @{}
}

$templateResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-templates/$templateId" -AllowStatus @(200, 404)
if ([int]$templateResp.status -eq 200) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/workflow-templates/$templateId" -AllowStatus @(200) -Body @{
    name = [string]$templatePayload.name
    description = [string]$templatePayload.description
    tasks = $templatePayload.tasks
    route_table = $templatePayload.route_table
    task_assign_route_table = $templatePayload.task_assign_route_table
    route_discuss_rounds = $templatePayload.route_discuss_rounds
  } | Out-Null
} else {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-templates" -AllowStatus @(201) -Body $templatePayload | Out-Null
}

Write-Host "== Create workflow run =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs" -AllowStatus @(201) -Body @{
  run_id = $runId
  template_id = $templateId
  team_id = $teamId
  name = "$workflowName run"
  description = "Official workflow mode demo run"
  workspace_path = $workspace
  auto_dispatch_enabled = $false
  auto_dispatch_remaining = 0
  auto_start = $false
} | Out-Null

Write-Host "== Register workflow sessions =="
foreach ($role in $agentIds) {
  $sessionId = "demo_${role}_session"
  $sessionByRole[$role] = $sessionId
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/sessions" -AllowStatus @(200, 201, 409) -Body @{
    role = $role
    session_id = $sessionId
    status = "idle"
    provider_id = "minimax"
  } | Out-Null
}

Write-Host "== Start workflow run =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/start" -AllowStatus @(200) | Out-Null

Write-Host "== Trigger one workflow dispatch =="
$dispatchResponse = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/orchestrator/dispatch" -AllowStatus @(200) -Body @{
  role = $dispatchRole
  task_id = $dispatchTaskId
  force = $false
  only_idle = $false
}

# Demo run uses explicit TASK_REPORT to guarantee deterministic done state.
Write-Host "== Mark workflow tasks done (deterministic evidence) =="
foreach ($task in $tasks) {
  $taskId = [string]$task.task_id
  $ownerRole = [string]$task.owner_role
  $sessionId = [string]$sessionByRole[$ownerRole]
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/task-actions" -AllowStatus @(200, 201) -Body @{
    action_type = "TASK_REPORT"
    from_agent = $ownerRole
    from_session_id = $sessionId
    results = @(
      @{
        task_id = $taskId
        outcome = "DONE"
        summary = "Workflow demo task completed for observability evidence."
      }
    )
  } | Out-Null
}

Write-Host "== Collect evidence =="
$statusResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/status" -AllowStatus @(200)
$runtimeResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/task-runtime" -AllowStatus @(200)
$treeResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/task-tree-runtime" -AllowStatus @(200)
$timelineResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/agent-io/timeline?limit=200" -AllowStatus @(200)
$eventsPath = Join-Path $repoRoot "data\workflows\runs\$runId\events.jsonl"
$eventsRaw = ""
$eventsItems = @()
if (Test-Path -LiteralPath $eventsPath) {
  $eventsRaw = Get-Content -LiteralPath $eventsPath -Raw
  foreach ($line in (Get-Content -LiteralPath $eventsPath)) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try { $eventsItems += ($trimmed | ConvertFrom-Json) } catch {}
  }
}

$taskStates = @{}
foreach ($row in @($runtimeResp.body.tasks)) {
  $taskId = [string]$row.taskId
  if ([string]::IsNullOrWhiteSpace($taskId)) {
    $taskId = [string]$row.task_id
  }
  if ([string]::IsNullOrWhiteSpace($taskId)) {
    continue
  }
  $taskStates[$taskId] = [string]$row.state
}

$allDone = $true
foreach ($task in $tasks) {
  $taskId = [string]$task.task_id
  if (-not $taskStates.ContainsKey($taskId) -or [string]$taskStates[$taskId] -ne "DONE") {
    $allDone = $false
    break
  }
}

$dispatchEventCount = @($eventsItems | Where-Object { [string]$_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" }).Count
$reportAppliedCount = @($eventsItems | Where-Object { [string]$_.eventType -eq "TASK_REPORT_APPLIED" }).Count

$outDir = Join-Path $workspace "docs\demo\workflow"
Ensure-Dir -Path $outDir

($dispatchResponse.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "dispatch_response.json") -Encoding UTF8
($statusResp.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "workflow_status.json") -Encoding UTF8
($runtimeResp.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "task_runtime.json") -Encoding UTF8
($treeResp.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "task_tree_runtime.json") -Encoding UTF8
($timelineResp.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "timeline.json") -Encoding UTF8
$eventsRaw | Set-Content -LiteralPath (Join-Path $outDir "events.jsonl") -Encoding UTF8

$summary = @()
$summary += "# Workflow Mode Demo Run Summary"
$summary += ""
$summary += "- team_id: $teamId"
$summary += "- run_id: $runId"
$summary += "- template_id: $templateId"
$summary += "- workspace: $workspace"
$summary += "- dispatch_role: $dispatchRole"
$summary += "- dispatch_task_id: $dispatchTaskId"
$summary += "- all_template_tasks_done: $allDone"
$summary += "- dispatch_event_count: $dispatchEventCount"
$summary += "- task_report_applied_count: $reportAppliedCount"
$summary += "- evidence_runtime: docs/demo/workflow/task_runtime.json"
$summary += "- evidence_task_tree: docs/demo/workflow/task_tree_runtime.json"
$summary += "- evidence_timeline: docs/demo/workflow/timeline.json"
$summary += "- evidence_events: docs/demo/workflow/events.jsonl"
[System.IO.File]::WriteAllLines((Join-Path $outDir "run_summary.md"), $summary, [System.Text.UTF8Encoding]::new($false))

$pass = ($allDone -and $dispatchEventCount -ge 1 -and $reportAppliedCount -ge 1)
Write-Host "== Workflow demo done =="
Write-Host "run_id=$runId"
Write-Host "workspace=$workspace"
Write-Host "summary=$outDir\\run_summary.md"
Write-Host "pass=$pass"

if (-not $pass) {
  exit 2
}
