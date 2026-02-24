$ErrorActionPreference = "Stop"

$BaseUrl = "http://127.0.0.1:3000"
$ProjectId = "testround3_minimax_v1"
$ProjectName = "TestRound3 MiniMax Task-Driven"
$Workspace = "D:\AgentWorkSpace\TestTeam\TestRound3"
$OutDir = Join-Path $Workspace "docs\test_round3"
$MaxMinutes = 75
$PollSeconds = 60

function Invoke-ApiJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null,
    [int[]]$AllowStatus = @(200, 201)
  )
  $uri = "$BaseUrl$Path"
  $json = $null
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 100
  }
  try {
    if ($null -ne $json) {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method $Method -ContentType "application/json; charset=utf-8" -Body $json
    } else {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method $Method
    }
    $status = [int]$resp.StatusCode
    if ($AllowStatus -notcontains $status) {
      throw "Unexpected status $status for $Method $Path`n$([string]$resp.Content)"
    }
    $raw = if ($resp.Content -is [byte[]]) {
      [System.Text.Encoding]::UTF8.GetString($resp.Content)
    } else {
      [string]$resp.Content
    }
    $bodyObj = $null
    if ($raw -and $raw.Trim().Length -gt 0) {
      try { $bodyObj = $raw | ConvertFrom-Json } catch {}
    }
    return [pscustomobject]@{ status = $status; body = $bodyObj; raw = $raw }
  } catch {
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $raw = $reader.ReadToEnd()
      $reader.Close()
      if ($AllowStatus -contains $status) {
        $bodyObj = $null
        if ($raw -and $raw.Trim().Length -gt 0) {
          try { $bodyObj = $raw | ConvertFrom-Json } catch {}
        }
        return [pscustomobject]@{ status = $status; body = $bodyObj; raw = $raw }
      }
      throw "HTTP $status on $Method $Path`n$raw"
    }
    throw
  }
}

function Get-EventsNdjson {
  param([Parameter(Mandatory = $true)][string]$ProjectId)
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/projects/$ProjectId/events" -Method Get
  $raw = if ($resp.Content -is [byte[]]) {
    [System.Text.Encoding]::UTF8.GetString($resp.Content)
  } else {
    [string]$resp.Content
  }
  $items = @()
  foreach ($line in ($raw -split "`r?`n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try { $items += ($trimmed | ConvertFrom-Json) } catch {}
  }
  return [pscustomobject]@{ raw = $raw; items = $items }
}

function Ensure-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

Write-Host "== Preflight =="
$health = Invoke-ApiJson -Method GET -Path "/healthz"
if ($health.body.status -ne "ok") {
  throw "healthz is not ok"
}
$settings = Invoke-ApiJson -Method GET -Path "/api/settings"
if (-not $settings.body.minimaxApiKey -or -not $settings.body.minimaxApiBase -or -not $settings.body.minimaxModel) {
  throw "MiniMax settings are incomplete"
}

Write-Host "== Reset project + workspace =="
$projects = Invoke-ApiJson -Method GET -Path "/api/projects"
$exists = $false
if ($projects.body.items) {
  $exists = @($projects.body.items | Where-Object { $_.projectId -eq $ProjectId }).Count -gt 0
}
if ($exists) {
  Invoke-ApiJson -Method DELETE -Path "/api/projects/$ProjectId" | Out-Null
}
Ensure-Dir $Workspace
Get-ChildItem -LiteralPath $Workspace -Force | Remove-Item -Recurse -Force
Ensure-Dir $Workspace

Write-Host "== Upsert agents =="
$agents = @(
  @{
    agent_id = "tr3_pm_owner"
    display_name = "TR3 PM Owner"
    prompt = @(
      "You are tr3_pm_owner (Product Owner)."
      "You own requirement decomposition, task planning, and closure."
      "Strict boundary: do NOT implement product code under src/."
      "You must create/assign tasks first, then coordinate via discuss."
      "Only implementation roles write code artifacts."
    ) -join "`n"
  },
  @{
    agent_id = "tr3_eng_manager"
    display_name = "TR3 Engineering Manager"
    prompt = @(
      "You are tr3_eng_manager (Engineering Manager)."
      "You split tasks, manage dependencies, and supervise dev/qa."
      "Strict boundary: do NOT implement product code under src/."
      "Ensure all execution tasks are assigned to implementation/qa roles."
    ) -join "`n"
  },
  @{
    agent_id = "tr3_dev_impl"
    display_name = "TR3 Dev Impl"
    prompt = @(
      "You are tr3_dev_impl (Implementation Engineer)."
      "You implement assigned tasks and update progress.md."
      "Use report_in_progress / report_task_done / report_task_block properly."
    ) -join "`n"
  },
  @{
    agent_id = "tr3_qa_guard"
    display_name = "TR3 QA Guard"
    prompt = @(
      "You are tr3_qa_guard (QA Guard)."
      "You validate acceptance criteria and report GO/NO_GO evidence."
      "Do not implement product code unless explicitly assigned."
    ) -join "`n"
  }
)

$agentList = Invoke-ApiJson -Method GET -Path "/api/agents"
$known = @{}
foreach ($a in @($agentList.body.items)) { $known[$a.agentId] = $true }
foreach ($agent in $agents) {
  $payload = @{
    agent_id = $agent.agent_id
    display_name = $agent.display_name
    prompt = $agent.prompt
    default_cli_tool = "minimax"
    default_model_params = @{ model = "MiniMax-M2.5"; effort = "high" }
    model_selection_enabled = $true
  }
  if ($known.ContainsKey($agent.agent_id)) {
    Invoke-ApiJson -Method PATCH -Path "/api/agents/$($agent.agent_id)" -Body $payload | Out-Null
  } else {
    Invoke-ApiJson -Method POST -Path "/api/agents" -Body $payload -AllowStatus @(201) | Out-Null
  }
}

Write-Host "== Create project =="
$routeTable = @{
  tr3_pm_owner = @("tr3_eng_manager", "tr3_dev_impl", "tr3_qa_guard")
  tr3_eng_manager = @("tr3_pm_owner", "tr3_dev_impl", "tr3_qa_guard")
  tr3_dev_impl = @("tr3_eng_manager", "tr3_pm_owner")
  tr3_qa_guard = @("tr3_eng_manager", "tr3_pm_owner")
}
$routeDiscussRounds = @{
  tr3_pm_owner = @{ tr3_eng_manager = 3; tr3_dev_impl = 3; tr3_qa_guard = 3 }
  tr3_eng_manager = @{ tr3_pm_owner = 3; tr3_dev_impl = 3; tr3_qa_guard = 3 }
  tr3_dev_impl = @{ tr3_eng_manager = 3; tr3_pm_owner = 3 }
  tr3_qa_guard = @{ tr3_eng_manager = 3; tr3_pm_owner = 3 }
}

$createProjectBody = @{
  project_id = $ProjectId
  name = $ProjectName
  workspace_path = $Workspace
  agent_ids = @("tr3_pm_owner", "tr3_eng_manager", "tr3_dev_impl", "tr3_qa_guard")
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  auto_dispatch_enabled = $true
  auto_dispatch_remaining = 30
}
Invoke-ApiJson -Method POST -Path "/api/projects" -Body $createProjectBody -AllowStatus @(201) | Out-Null

Write-Host "== Patch project model + task assign routes =="
$routingPatch = @{
  agent_ids = @("tr3_pm_owner", "tr3_eng_manager", "tr3_dev_impl", "tr3_qa_guard")
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  agent_model_configs = @{
    tr3_pm_owner = @{ tool = "minimax"; model = "MiniMax-M2.5"; effort = "high" }
    tr3_eng_manager = @{ tool = "minimax"; model = "MiniMax-M2.5"; effort = "high" }
    tr3_dev_impl = @{ tool = "minimax"; model = "MiniMax-M2.5"; effort = "high" }
    tr3_qa_guard = @{ tool = "minimax"; model = "MiniMax-M2.5"; effort = "high" }
  }
}
Invoke-ApiJson -Method PATCH -Path "/api/projects/$ProjectId/routing-config" -Body $routingPatch | Out-Null

$taskAssignPatch = @{
  task_assign_route_table = @{
    tr3_pm_owner = @("tr3_eng_manager", "tr3_dev_impl", "tr3_qa_guard")
    tr3_eng_manager = @("tr3_dev_impl", "tr3_qa_guard")
    tr3_dev_impl = @()
    tr3_qa_guard = @()
  }
}
Invoke-ApiJson -Method PATCH -Path "/api/projects/$ProjectId/task-assign-routing" -Body $taskAssignPatch | Out-Null
Invoke-ApiJson -Method PATCH -Path "/api/projects/$ProjectId/orchestrator/settings" -Body @{ auto_dispatch_enabled = $true; auto_dispatch_remaining = 30 } | Out-Null

Write-Host "== Create role sessions =="
$roles = @("tr3_pm_owner", "tr3_eng_manager", "tr3_dev_impl", "tr3_qa_guard")
foreach ($role in $roles) {
  Invoke-ApiJson -Method POST -Path "/api/projects/$ProjectId/sessions" -Body @{ role = $role } -AllowStatus @(200, 201, 409) | Out-Null
}

Write-Host "== Seed first requirement as TASK_CREATE under PROJECT_ROOT =="
$requirementTaskId = "task-tr3-requirement-001"
$rootTaskId = "$ProjectId-root"
$requirementContent = @(
  "Implement a task-tree visualization PoC based on current backend APIs."
  "Must support: tree rendering, focus node mode, dependency edge markers."
  "Produce implementation notes, usage docs, and acceptance result."
  "Use task-driven workflow end-to-end."
) -join "`n"

$taskCreateBody = @{
  action_type = "TASK_CREATE"
  from_agent = "manager"
  from_session_id = "manager-system"
  task_id = $requirementTaskId
  task_kind = "EXECUTION"
  parent_task_id = $rootTaskId
  root_task_id = $rootTaskId
  title = "Round3 Requirement: Task-Tree Visualization PoC"
  owner_role = "tr3_pm_owner"
  priority = 10
  content = $requirementContent
}
Invoke-ApiJson -Method POST -Path "/api/projects/$ProjectId/task-actions" -Body $taskCreateBody -AllowStatus @(201) | Out-Null

Write-Host "== Kick initial dispatch (PM) =="
Invoke-ApiJson -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -Body @{ role = "tr3_pm_owner"; force = $false; only_idle = $false } -AllowStatus @(200) | Out-Null

Write-Host "== Monitor loop =="
$start = Get-Date
$finalReason = ""
$pass = $false

while ($true) {
  $settingsNow = Invoke-ApiJson -Method GET -Path "/api/projects/$ProjectId/orchestrator/settings"
  $sessionsNow = Invoke-ApiJson -Method GET -Path "/api/projects/$ProjectId/sessions"
  $treeNow = Invoke-ApiJson -Method GET -Path "/api/projects/$ProjectId/task-tree"

  $remaining = [int]$settingsNow.body.auto_dispatch_remaining
  $nodes = @($treeNow.body.nodes)
  $terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
  $openNodes = @($nodes | Where-Object { $terminalStates -notcontains $_.state })
  $running = @($sessionsNow.body.items | Where-Object { $_.status -eq "running" })

  Write-Host ("remaining={0} tasks={1} open={2} running={3}" -f $remaining, $nodes.Count, $openNodes.Count, $running.Count)

  foreach ($s in $running) {
    $token = if ($s.sessionId) { $s.sessionId } else { $null }
    if (-not $token) { continue }
    $last = [datetime]::Parse($s.lastActiveAt)
    if (((Get-Date).ToUniversalTime() - $last.ToUniversalTime()).TotalMinutes -gt 15) {
      Invoke-ApiJson -Method POST -Path "/api/projects/$ProjectId/sessions/$token/repair" -Body @{ target_status = "idle" } -AllowStatus @(200, 404, 409) | Out-Null
      Invoke-ApiJson -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -Body @{ role = $s.role; force = $false; only_idle = $false } -AllowStatus @(200) | Out-Null
    }
  }

  if ($nodes.Count -gt 0 -and $openNodes.Count -eq 0 -and $running.Count -eq 0) {
    $pass = $true
    $finalReason = "all_tasks_terminal"
    break
  }
  if ($remaining -le 0) {
    $finalReason = "budget_exhausted"
    break
  }
  if (((Get-Date) - $start).TotalMinutes -gt $MaxMinutes) {
    $finalReason = "timeout"
    break
  }

  Start-Sleep -Seconds $PollSeconds
}

Write-Host "== Collect artifacts =="
Ensure-Dir $OutDir
$events = Get-EventsNdjson -ProjectId $ProjectId
$timeline = Invoke-ApiJson -Method GET -Path "/api/projects/$ProjectId/agent-io/timeline?limit=500"
$treeFinal = Invoke-ApiJson -Method GET -Path "/api/projects/$ProjectId/task-tree"
$sessionsFinal = Invoke-ApiJson -Method GET -Path "/api/projects/$ProjectId/sessions"
$settingsFinal = Invoke-ApiJson -Method GET -Path "/api/projects/$ProjectId/orchestrator/settings"

$eventsPath = Join-Path $OutDir "events.ndjson"
$timelinePath = Join-Path $OutDir "timeline.json"
$treePath = Join-Path $OutDir "task_tree_final.json"
$sessionsPath = Join-Path $OutDir "sessions_final.json"
$settingsPath = Join-Path $OutDir "orchestrator_settings_final.json"
$summaryPath = Join-Path $OutDir "run_summary.md"

[System.IO.File]::WriteAllText($eventsPath, $events.raw, [System.Text.UTF8Encoding]::new($false))
($timeline.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $timelinePath -Encoding UTF8
($treeFinal.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $treePath -Encoding UTF8
($sessionsFinal.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $sessionsPath -Encoding UTF8
($settingsFinal.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $settingsPath -Encoding UTF8

$finalRemaining = [int]$settingsFinal.body.auto_dispatch_remaining
$consumed = 30 - $finalRemaining
$nodeCount = @($treeFinal.body.nodes).Count
$openCount = @(@($treeFinal.body.nodes) | Where-Object { @("DONE", "BLOCKED_DEP", "CANCELED") -notcontains $_.state }).Count
$runningCount = @(@($sessionsFinal.body.items) | Where-Object { $_.status -eq "running" }).Count

$summary = @()
$summary += "# TestRound3 MiniMax Summary"
$summary += ""
$summary += "- project_id: $ProjectId"
$summary += "- workspace: $Workspace"
$summary += "- started_at: $($start.ToString("o"))"
$summary += "- ended_at: $((Get-Date).ToString("o"))"
$summary += "- budget_initial: 30"
$summary += "- budget_remaining: $finalRemaining"
$summary += "- budget_consumed: $consumed"
$summary += "- final_reason: $finalReason"
$summary += "- pass: $pass"
$summary += "- task_nodes_total: $nodeCount"
$summary += "- task_nodes_open: $openCount"
$summary += "- sessions_running: $runningCount"
[System.IO.File]::WriteAllLines($summaryPath, $summary, [System.Text.UTF8Encoding]::new($false))

Write-Host "== Round3 done =="
Write-Host "summary=$summaryPath"
Write-Host "final_reason=$finalReason"
Write-Host "pass=$pass"
