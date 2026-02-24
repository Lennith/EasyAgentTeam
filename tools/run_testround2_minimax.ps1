$ErrorActionPreference = "Stop"

$base = "http://127.0.0.1:3000"
$projectId = "testround2_minimax_v1"
$workspace = "D:\AgentWorkSpace\TestTeam\TestRound2"
$outDir = Join-Path $workspace "docs\test_round2"
$maxMinutes = 70
$pollSeconds = 60

function Invoke-Json {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null,
    [int[]]$AllowStatus = @(200, 201)
  )
  $uri = "$base$Path"
  $json = $null
  if ($null -ne $Body) { $json = $Body | ConvertTo-Json -Depth 100 }
  try {
    if ($null -ne $json) {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method $Method -ContentType "application/json; charset=utf-8" -Body $json
    } else {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method $Method
    }
    $status = [int]$resp.StatusCode
    if ($AllowStatus -notcontains $status) {
      throw "Unexpected status $status for $Method $Path`n$($resp.Content)"
    }
    $rawContent = if ($resp.Content -is [byte[]]) {
      [System.Text.Encoding]::UTF8.GetString($resp.Content)
    } else {
      [string]$resp.Content
    }
    $bodyObj = $null
    if ($rawContent -and $rawContent.Trim().Length -gt 0) {
      try {
        $bodyObj = $rawContent | ConvertFrom-Json
      } catch {
        $bodyObj = $null
      }
    }
    return [pscustomobject]@{ status = $status; body = $bodyObj; raw = $rawContent }
  } catch {
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $content = $reader.ReadToEnd()
      $reader.Close()
      if ($AllowStatus -contains $status) {
        $bodyObj = $null
        if ($content -and $content.Trim().Length -gt 0) {
          try { $bodyObj = $content | ConvertFrom-Json } catch {}
        }
        return [pscustomobject]@{ status = $status; body = $bodyObj; raw = $content }
      }
      throw "HTTP $status on $Method $Path`n$content"
    }
    throw
  }
}

function Invoke-EventsNdjson([string]$ProjectId) {
  $uri = "$base/api/projects/$ProjectId/events"
  $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method GET
  $raw = if ($resp.Content -is [byte[]]) {
    [System.Text.Encoding]::UTF8.GetString($resp.Content)
  } else {
    [string]$resp.Content
  }
  $items = @()
  foreach ($line in ($raw -split "`r?`n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try {
      $items += ($trimmed | ConvertFrom-Json)
    } catch {}
  }
  return [pscustomobject]@{ raw = $raw; items = $items }
}

function Ensure-Dir([string]$path) {
  if (!(Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path | Out-Null }
}

Write-Host "== Phase 0: Preflight =="
$health = Invoke-Json -Method GET -Path "/healthz"
if ($health.body.status -ne "ok") { throw "healthz not ok" }
$settings = Invoke-Json -Method GET -Path "/api/settings"
if (-not $settings.body.minimaxApiKey -or -not $settings.body.minimaxApiBase -or -not $settings.body.minimaxModel) {
  throw "MiniMax settings incomplete in /api/settings"
}

Write-Host "== Phase 1: Reset project + workspace =="
$projects = Invoke-Json -Method GET -Path "/api/projects"
$exists = $false
if ($projects.body.items) {
  $exists = @($projects.body.items | Where-Object { $_.projectId -eq $projectId }).Count -gt 0
}
if ($exists) {
  Invoke-Json -Method DELETE -Path "/api/projects/$projectId" | Out-Null
}
Ensure-Dir $workspace
Get-ChildItem -LiteralPath $workspace -Force | Remove-Item -Recurse -Force
Ensure-Dir $workspace

Write-Host "== Phase 2: Register/patch agents =="
$agentPrompts = @{
  "tr2_pm_owner" = (
    @(
      "You are tr2_pm_owner (Product Owner)."
      "Responsibilities: convert user request into task goals and acceptance criteria."
      "Use task-actions to create/assign tasks with dependencies and close loop with reports."
      "Execution rules: use TeamTools V4 only; periodic report_in_progress; completion with report_task_done; blockers with report_task_block."
      "Use discuss scripts for clarifications; do not use retired handoff/report endpoints."
    ) -join "`n"
  )
  "tr2_eng_manager" = (
    @(
      "You are tr2_eng_manager (Engineering Manager)."
      "Break PM goals into executable implementation and QA tasks with dependency order."
      "Monitor reports, unblock risks, and push closure."
      "Use TeamTools V4 scripts only; keep tasks concise and actionable."
    ) -join "`n"
  )
  "tr2_dev_impl" = (
    @(
      "You are tr2_dev_impl (Implementation Engineer)."
      "Implement assigned tasks in workspace and keep progress.md updated for each active task."
      "Report in-progress/done/blocked using TeamTools scripts."
      "Before report_task_done/report_task_block, ensure progress.md includes current task_id."
      "If requirements are unclear, use discuss_request to ask manager/pm."
    ) -join "`n"
  )
  "tr2_qa_guard" = (
    @(
      "You are tr2_qa_guard (QA Guard)."
      "Validate outputs against acceptance criteria, collect evidence and known limitations."
      "Report QA outcomes via task reports."
      "Use discuss for clarifications; use report_task_done only when evidence is attached and checks are complete."
    ) -join "`n"
  )
}
$display = @{
  "tr2_pm_owner" = "TR2 PM Owner"
  "tr2_eng_manager" = "TR2 Engineering Manager"
  "tr2_dev_impl" = "TR2 Developer"
  "tr2_qa_guard" = "TR2 QA Guard"
}
$agents = Invoke-Json -Method GET -Path "/api/agents"
$existingIds = @{}
foreach ($a in @($agents.body.items)) { $existingIds[$a.agentId] = $true }
foreach ($role in $agentPrompts.Keys) {
  $payload = @{
    agent_id = $role
    display_name = $display[$role]
    prompt = $agentPrompts[$role]
    default_cli_tool = "minimax"
    default_model_params = @{ model = "MiniMax-M2.5"; effort = "high" }
    model_selection_enabled = $true
  }
  if ($existingIds.ContainsKey($role)) {
    Invoke-Json -Method PATCH -Path "/api/agents/$role" -Body $payload | Out-Null
  } else {
    Invoke-Json -Method POST -Path "/api/agents" -Body $payload -AllowStatus @(201) | Out-Null
  }
}

Write-Host "== Phase 3: Create project =="
$routeTable = @{
  tr2_pm_owner = @("tr2_eng_manager", "tr2_dev_impl", "tr2_qa_guard")
  tr2_eng_manager = @("tr2_pm_owner", "tr2_dev_impl", "tr2_qa_guard")
  tr2_dev_impl = @("tr2_eng_manager", "tr2_pm_owner")
  tr2_qa_guard = @("tr2_eng_manager", "tr2_pm_owner")
}
$routeDiscussRounds = @{
  tr2_pm_owner = @{ tr2_eng_manager = 3; tr2_dev_impl = 3; tr2_qa_guard = 3 }
  tr2_eng_manager = @{ tr2_pm_owner = 3; tr2_dev_impl = 3; tr2_qa_guard = 3 }
  tr2_dev_impl = @{ tr2_eng_manager = 3; tr2_pm_owner = 3 }
  tr2_qa_guard = @{ tr2_eng_manager = 3; tr2_pm_owner = 3 }
}
$createProjectPayload = @{
  project_id = $projectId
  name = "TestRound2 MiniMax"
  workspace_path = $workspace
  agent_ids = @("tr2_pm_owner", "tr2_eng_manager", "tr2_dev_impl", "tr2_qa_guard")
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  auto_dispatch_enabled = $true
  auto_dispatch_remaining = 30
}
Invoke-Json -Method POST -Path "/api/projects" -Body $createProjectPayload -AllowStatus @(201) | Out-Null

Write-Host "== Phase 4: Patch model config + task assign routing =="
$agentModelConfigs = @{
  tr2_pm_owner = @{ tool = "minimax"; model = "MiniMax-M2.5"; effort = "high" }
  tr2_eng_manager = @{ tool = "minimax"; model = "MiniMax-M2.5"; effort = "high" }
  tr2_dev_impl = @{ tool = "minimax"; model = "MiniMax-M2.5"; effort = "high" }
  tr2_qa_guard = @{ tool = "minimax"; model = "MiniMax-M2.5"; effort = "high" }
}
$routingPatch = @{
  agent_ids = @("tr2_pm_owner", "tr2_eng_manager", "tr2_dev_impl", "tr2_qa_guard")
  route_table = $routeTable
  route_discuss_rounds = $routeDiscussRounds
  agent_model_configs = $agentModelConfigs
}
Invoke-Json -Method PATCH -Path "/api/projects/$projectId/routing-config" -Body $routingPatch | Out-Null
$taskAssignRouting = @{
  task_assign_route_table = @{
    tr2_pm_owner = @("tr2_eng_manager", "tr2_dev_impl", "tr2_qa_guard")
    tr2_eng_manager = @("tr2_dev_impl", "tr2_qa_guard")
    tr2_dev_impl = @()
    tr2_qa_guard = @()
  }
}
Invoke-Json -Method PATCH -Path "/api/projects/$projectId/task-assign-routing" -Body $taskAssignRouting | Out-Null
Invoke-Json -Method PATCH -Path "/api/projects/$projectId/orchestrator/settings" -Body @{ auto_dispatch_remaining = 30; auto_dispatch_enabled = $true } | Out-Null

Write-Host "== Phase 5: Create sessions =="
$roles = @("tr2_pm_owner", "tr2_eng_manager", "tr2_dev_impl", "tr2_qa_guard")
foreach ($role in $roles) {
  Invoke-Json -Method POST -Path "/api/projects/$projectId/sessions" -Body @{ role = $role } -AllowStatus @(200, 201, 409) | Out-Null
}

Write-Host "== Phase 6: Inject user requirement =="
$requirement = @(
  "Please implement a task-tree visualization PoC based on current backend APIs:"
  "1) Fetch from /api/projects/:id/task-tree and render a readable tree view."
  "2) Support focus node mode and dependency edge markers."
  "3) Output implementation notes and usage documentation."
  "4) Provide final acceptance result and known limitations."
  "Requirement: keep structure clear and report each stage via task system."
) -join "`n"
Invoke-Json -Method POST -Path "/api/projects/$projectId/messages/send" -Body @{
  from_agent = "user"
  from_session_id = "user-console"
  to = @{ agent = "tr2_pm_owner" }
  message_type = "MANAGER_MESSAGE"
  content = $requirement
} -AllowStatus @(201) | Out-Null

Write-Host "== Phase 7: Kick initial dispatch =="
Invoke-Json -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = "tr2_pm_owner"; force = $false; only_idle = $false } -AllowStatus @(200) | Out-Null

Write-Host "== Monitoring loop =="
$start = Get-Date
$sentGuidance = @{}
$loopCount = 0
$finished = $false
$pass = $false
$finalReason = ""

while (-not $finished) {
  $loopCount++
  $now = Get-Date
  if (($now - $start).TotalMinutes -gt $maxMinutes) {
    $finished = $true
    $finalReason = "timeout_${maxMinutes}m"
    break
  }

  $settingsNow = Invoke-Json -Method GET -Path "/api/projects/$projectId/orchestrator/settings"
  $sessionsNow = Invoke-Json -Method GET -Path "/api/projects/$projectId/sessions"
  $taskTreeNow = Invoke-Json -Method GET -Path "/api/projects/$projectId/task-tree"
  $eventsNow = Invoke-EventsNdjson -ProjectId $projectId

  $remaining = [int]$settingsNow.body.auto_dispatch_remaining
  $nodes = @($taskTreeNow.body.nodes)
  $terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
  $nonTerminal = @($nodes | Where-Object { $terminalStates -notcontains $_.state })
  $running = @($sessionsNow.body.items | Where-Object { $_.status -eq "running" })

  foreach ($s in $running) {
    $token = if ($s.sessionId) { $s.sessionId } else { $null }
    if (-not $token) { continue }
    $last = [datetime]::Parse($s.lastActiveAt)
    if (((Get-Date).ToUniversalTime() - $last.ToUniversalTime()).TotalMinutes -gt 15) {
      Invoke-Json -Method POST -Path "/api/projects/$projectId/sessions/$token/repair" -Body @{ target_status = "idle" } -AllowStatus @(200, 409, 404) | Out-Null
      Invoke-Json -Method POST -Path "/api/projects/$projectId/orchestrator/dispatch" -Body @{ role = $s.role; force = $false; only_idle = $false } -AllowStatus @(200) | Out-Null
    }
  }

  $rejectEvents = @($eventsNow.items | Where-Object { $_.eventType -eq "TASK_ACTION_REJECTED" })
  $hotCodes = @("TASK_PROGRESS_REQUIRED", "TASK_RESULT_INVALID_TARGET")
  foreach ($code in $hotCodes) {
    $count = @($rejectEvents | Where-Object { $_.payload.error_code -eq $code -or $_.payload.errorCode -eq $code }).Count
    if ($count -ge 3 -and -not $sentGuidance.ContainsKey($code)) {
      $msg = if ($code -eq "TASK_PROGRESS_REQUIRED") {
        "System notice: TASK_REPORT rejected. Update progress.md with current task_id then retry report."
      } else {
        "System notice: TASK_REPORT target mismatch. Check task_id owner mapping then retry report."
      }
      Invoke-Json -Method POST -Path "/api/projects/$projectId/messages/send" -Body @{
        from_agent = "manager"
        from_session_id = "manager-system"
        to = @{ agent = "tr2_dev_impl" }
        message_type = "MANAGER_MESSAGE"
        content = $msg
      } -AllowStatus @(201, 409, 404) | Out-Null
      $sentGuidance[$code] = $true
    }
  }

  Write-Host ("loop={0} remaining={1} nodes={2} nonTerminal={3} running={4}" -f $loopCount, $remaining, $nodes.Count, $nonTerminal.Count, $running.Count)

  if ($nodes.Count -gt 0 -and $nonTerminal.Count -eq 0 -and $running.Count -eq 0) {
    $finished = $true
    $pass = $true
    $finalReason = "all_tasks_terminal_and_sessions_not_running"
    break
  }

  if ($remaining -le 0) {
    $finished = $true
    $finalReason = "auto_dispatch_budget_exhausted"
    break
  }

  Start-Sleep -Seconds $pollSeconds
}

Write-Host "== Phase 8: Collect artifacts =="
Ensure-Dir $outDir
$eventsFinal = Invoke-EventsNdjson -ProjectId $projectId
$timelineFinal = Invoke-Json -Method GET -Path "/api/projects/$projectId/agent-io/timeline?limit=500"
$taskTreeFinal = Invoke-Json -Method GET -Path "/api/projects/$projectId/task-tree"
$sessionsFinal = Invoke-Json -Method GET -Path "/api/projects/$projectId/sessions"
$orchestratorFinal = Invoke-Json -Method GET -Path "/api/projects/$projectId/orchestrator/settings"

$eventsPath = Join-Path $outDir "events.ndjson"
$timelinePath = Join-Path $outDir "timeline.json"
$taskTreePath = Join-Path $outDir "task_tree_final.json"
$sessionsPath = Join-Path $outDir "sessions_final.json"
$orchestratorPath = Join-Path $outDir "orchestrator_settings_final.json"
$summaryPath = Join-Path $outDir "run_summary.md"

$ndjson = @()
foreach ($e in @($eventsFinal.items)) { $ndjson += ($e | ConvertTo-Json -Depth 50 -Compress) }
[System.IO.File]::WriteAllLines($eventsPath, $ndjson, [System.Text.UTF8Encoding]::new($false))
($timelineFinal.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $timelinePath -Encoding utf8
($taskTreeFinal.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $taskTreePath -Encoding utf8
($sessionsFinal.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $sessionsPath -Encoding utf8
($orchestratorFinal.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $orchestratorPath -Encoding utf8

$finalRemaining = [int]$orchestratorFinal.body.auto_dispatch_remaining
$spent = 30 - $finalRemaining
$finalNodes = @($taskTreeFinal.body.nodes)
$terminalStates = @("DONE", "BLOCKED_DEP", "CANCELED")
$openNodes = @($finalNodes | Where-Object { $terminalStates -notcontains $_.state })
$runningFinal = @($sessionsFinal.body.items | Where-Object { $_.status -eq "running" })
$blockedFinal = @($sessionsFinal.body.items | Where-Object { $_.status -eq "blocked" })

$summary = @()
$summary += "# TestRound2 MiniMax Run Summary"
$summary += ""
$summary += "- project_id: $projectId"
$summary += "- workspace: $workspace"
$summary += "- started_at: $($start.ToString('o'))"
$summary += "- ended_at: $((Get-Date).ToString('o'))"
$summary += "- auto_dispatch_budget_initial: 30"
$summary += "- auto_dispatch_remaining_final: $finalRemaining"
$summary += "- rounds_consumed: $spent"
$summary += "- final_reason: $finalReason"
$summary += "- pass: $pass"
$summary += ""
$summary += "## Task Closure"
$summary += "- total_nodes: $($finalNodes.Count)"
$summary += "- open_nodes: $($openNodes.Count)"
$summary += "- terminal_nodes: $($finalNodes.Count - $openNodes.Count)"
$summary += ""
$summary += "## Session Status"
$summary += "- running_sessions: $($runningFinal.Count)"
$summary += "- blocked_sessions: $($blockedFinal.Count)"
$summary += "- total_sessions: $($sessionsFinal.body.total)"
$summary += ""
$summary += "## Notes"
$summary += "- Review events.ndjson and timeline.json for full execution trace."
$summary += "- If pass=false and remaining=0, run considered not passed under fixed budget policy."
[System.IO.File]::WriteAllLines($summaryPath, $summary, [System.Text.UTF8Encoding]::new($false))

Write-Host "== Completed =="
Write-Host "Summary: $summaryPath"
Write-Host "Final reason: $finalReason"
Write-Host "Pass: $pass"

