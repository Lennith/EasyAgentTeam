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
  $TemplatePath = Join-Path $repoRoot "docs\demos\templates\project-mode-demo.json"
}
if (-not (Test-Path -LiteralPath $TemplatePath)) {
  throw "Template file not found: $TemplatePath"
}

$template = Get-Content -LiteralPath $TemplatePath -Raw | ConvertFrom-Json
$teamId = [string]$template.team_id
$teamName = [string]$template.team_name
$projectId = [string]$template.project_id
$projectName = [string]$template.project_name
$workspace = if ($WorkspaceRoot) { $WorkspaceRoot } else { [string]$template.workspace_path }
$agents = @($template.agents)
$agentIds = @($agents | ForEach-Object { [string]$_.agent_id })
$routeTable = $template.route_table
$taskAssignRouteTable = $template.task_assign_route_table
$routeDiscussRounds = $template.route_discuss_rounds
$seedTasks = @($template.seed_tasks)
$dispatchRole = [string]$template.dispatch_target.role
$dispatchTaskId = [string]$template.dispatch_target.task_id
$rootTaskId = "$projectId-root"

if ([string]::IsNullOrWhiteSpace($projectId)) {
  throw "project_id is required in template."
}
if ([string]::IsNullOrWhiteSpace($workspace)) {
  throw "workspace_path is required in template."
}

Write-Host "== Project demo: preflight =="
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
    description = "Official project demo team"
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

Write-Host "== Reset target project if exists =="
$projects = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects" -AllowStatus @(200)
$exists = @($projects.body.items | Where-Object { [string]$_.projectId -eq $projectId }).Count -gt 0
if ($exists) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/projects/$projectId" -AllowStatus @(200) | Out-Null
}

Write-Host "== Create demo project =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects" -AllowStatus @(201) -Body @{
  project_id = $projectId
  name = $projectName
  workspace_path = $workspace
  team_id = $teamId
  agent_ids = $agentIds
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  auto_dispatch_enabled = $false
  auto_dispatch_remaining = 0
  reminder_mode = "fixed_interval"
} | Out-Null

Write-Host "== Patch routing config =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/routing-config" -AllowStatus @(200) -Body @{
  agent_ids = $agentIds
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  agent_model_configs = $agentModelConfigs
} | Out-Null
Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$projectId/task-assign-routing" -AllowStatus @(200) -Body @{
  task_assign_route_table = $taskAssignRouteTable
} | Out-Null

Write-Host "== Register sessions =="
foreach ($agentId in $agentIds) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/sessions" -AllowStatus @(200, 201, 409) -Body @{
    role = $agentId
  } | Out-Null
}

Write-Host "== Seed tasks =="
foreach ($task in $seedTasks) {
  $taskId = [string]$task.task_id
  $content = [string]$task.content
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(201) -Body @{
    action_type = "TASK_CREATE"
    from_agent = "manager"
    from_session_id = "manager-system"
    task_id = $taskId
    task_kind = [string]$task.task_kind
    parent_task_id = $rootTaskId
    root_task_id = $rootTaskId
    title = [string]$task.title
    owner_role = [string]$task.owner_role
    priority = [int]$task.priority
    dependencies = @($task.dependencies | ForEach-Object { [string]$_ })
    content = $content
  } | Out-Null
}

Write-Host "== Trigger one dispatch =="
$dispatchResponse = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -AllowStatus @(200) -Body @{
  role = $dispatchRole
  task_id = $dispatchTaskId
  force = $false
  only_idle = $false
}

# Demo run uses explicit TASK_REPORT to guarantee deterministic done state.
Write-Host "== Mark task done (deterministic evidence) =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$projectId/task-actions" -AllowStatus @(200, 201) -Body @{
  action_type = "TASK_REPORT"
  from_agent = $dispatchRole
  from_session_id = "${dispatchRole}_demo_session"
  results = @(
    @{
      task_id = $dispatchTaskId
      outcome = "DONE"
      summary = "Project demo completed for observability evidence."
    }
  )
} | Out-Null

Write-Host "== Collect evidence =="
$taskTree = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/task-tree" -AllowStatus @(200)
$timeline = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$projectId/agent-io/timeline?limit=200" -AllowStatus @(200)
$events = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $projectId

$dispatchEventCount = @($events.items | Where-Object { [string]$_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" }).Count
$reportAppliedCount = @($events.items | Where-Object { [string]$_.eventType -eq "TASK_REPORT_APPLIED" }).Count
$doneCount = @($taskTree.body.nodes | Where-Object { [string]$_.task_id -eq $dispatchTaskId -and [string]$_.state -eq "DONE" }).Count

$outDir = Join-Path $workspace "docs\demo\project"
Ensure-Dir -Path $outDir

($dispatchResponse.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "dispatch_response.json") -Encoding UTF8
($taskTree.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "task_tree.json") -Encoding UTF8
($timeline.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $outDir "timeline.json") -Encoding UTF8
$events.raw | Set-Content -LiteralPath (Join-Path $outDir "events.ndjson") -Encoding UTF8

$summary = @()
$summary += "# Project Mode Demo Run Summary"
$summary += ""
$summary += "- team_id: $teamId"
$summary += "- project_id: $projectId"
$summary += "- workspace: $workspace"
$summary += "- dispatch_role: $dispatchRole"
$summary += "- dispatch_task_id: $dispatchTaskId"
$summary += "- done_count_for_dispatch_task: $doneCount"
$summary += "- dispatch_event_count: $dispatchEventCount"
$summary += "- task_report_applied_count: $reportAppliedCount"
$summary += "- evidence_task_tree: docs/demo/project/task_tree.json"
$summary += "- evidence_timeline: docs/demo/project/timeline.json"
$summary += "- evidence_events: docs/demo/project/events.ndjson"
[System.IO.File]::WriteAllLines((Join-Path $outDir "run_summary.md"), $summary, [System.Text.UTF8Encoding]::new($false))

$pass = ($doneCount -ge 1 -and $dispatchEventCount -ge 1 -and $reportAppliedCount -ge 1)
Write-Host "== Project demo done =="
Write-Host "workspace=$workspace"
Write-Host "summary=$outDir\\run_summary.md"
Write-Host "pass=$pass"

if (-not $pass) {
  exit 2
}
