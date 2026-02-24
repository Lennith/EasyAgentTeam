param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [string]$ProjectId = "e2e_reminder_v1",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestReminder",
  [int]$AutoDispatchBudget = 20,
  [int]$PollSeconds = 10,
  [int]$MaxMinutes = 20
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "invoke-api.ps1")

$role = "e2e_reminder_worker"
$artifactsBase = Join-Path $WorkspaceRoot "docs\e2e"
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$artifactDir = Join-Path $artifactsBase "$stamp-reminder"

function Get-RoleReminderState {
  param([string]$ProjectId, [string]$Role)
  $dataRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) "data\projects\$ProjectId\collab\state\role-reminders.json"
  if (-not (Test-Path -LiteralPath $dataRoot)) {
    return $null
  }
  $state = Get-Content -LiteralPath $dataRoot -Raw | ConvertFrom-Json
  foreach ($item in @($state.roleReminders)) {
    if ($item.role -eq $Role) {
      return $item
    }
  }
  return $null
}

Write-Host "== Reminder E2E Preflight =="
$health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz"
if ($health.body.status -ne "ok") {
  throw "healthz is not ok"
}

Write-Host "== Reset workspace/project =="
Reset-WorkspaceDirectory -WorkspaceRoot $WorkspaceRoot
Ensure-Dir -Path $WorkspaceRoot
$projects = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects"
$exists = @($projects.body.items | Where-Object { $_.projectId -eq $ProjectId }).Count -gt 0
if ($exists) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/projects/$ProjectId" | Out-Null
}

Write-Host "== Upsert agent =="
$agents = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents"
$known = @{}
foreach ($a in @($agents.body.items)) { $known[$a.agentId] = $true }
$agentBody = @{
  agent_id = $role
  display_name = $role
  prompt = "You are reminder E2E worker. Keep reporting task progress."
  default_cli_tool = "minimax"
  default_model_params = @{
    model = "MiniMax-M2.5"
    effort = "high"
  }
  model_selection_enabled = $true
}
if ($known.ContainsKey($role)) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$role" -Body $agentBody | Out-Null
} else {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -Body $agentBody -AllowStatus @(201) | Out-Null
}

Write-Host "== Create project with fixed_interval reminder mode =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects" -Body @{
  project_id = $ProjectId
  name = "Reminder E2E"
  workspace_path = $WorkspaceRoot
  agent_ids = @($role)
  route_table = @{ $role = @() }
  auto_dispatch_enabled = $true
  auto_dispatch_remaining = $AutoDispatchBudget
  reminder_mode = "fixed_interval"
} -AllowStatus @(201) | Out-Null

Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$ProjectId/routing-config" -Body @{
  agent_ids = @($role)
  route_table = @{ $role = @() }
  agent_model_configs = @{
    $role = @{
      tool = "minimax"
      model = "MiniMax-M2.5"
      effort = "high"
    }
  }
} | Out-Null

$settings = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/orchestrator/settings"
if ($settings.body.reminder_mode -ne "fixed_interval") {
  throw "reminder_mode is not fixed_interval"
}

Write-Host "== Create session and stable blocked-open task =="
$sessionRes = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/sessions" -Body @{ role = $role } -AllowStatus @(200, 201)
$sessionToken = [string]$sessionRes.body.session.sessionId
$rootTaskId = "$ProjectId-root"
$blockerTaskId = "task-reminder-blocker"
$taskId = "task-reminder-main"
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/task-actions" -Body @{
  action_type = "TASK_CREATE"
  from_agent = "manager"
  from_session_id = "manager-system"
  task_id = $blockerTaskId
  task_kind = "EXECUTION"
  parent_task_id = $rootTaskId
  root_task_id = $rootTaskId
  title = "Reminder blocker task"
  owner_role = "manager"
  priority = 1
  dependencies = @()
  content = "Keep unresolved so reminder task remains blocked-open."
} -AllowStatus @(201) | Out-Null
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/task-actions" -Body @{
  action_type = "TASK_CREATE"
  from_agent = "manager"
  from_session_id = "manager-system"
  task_id = $taskId
  task_kind = "EXECUTION"
  parent_task_id = $rootTaskId
  root_task_id = $rootTaskId
  title = "Reminder e2e task"
  owner_role = $role
  priority = 1
  dependencies = @($blockerTaskId)
  content = "Blocked-open task used for deterministic reminder checks."
} -AllowStatus @(201) | Out-Null

Write-Host "== Wait for reminder trigger =="
$startedAt = Get-Date
$firstReminderAt = $null
$trace = @()
while ($true) {
  $events = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $ProjectId
  $triggered = @($events.items | Where-Object { $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED" })
  $trace += [pscustomobject]@{
    at = (Get-Date).ToString("o")
    reminder_triggered_count = $triggered.Count
    role_reminder_state = (Get-RoleReminderState -ProjectId $ProjectId -Role $role)
  }
  if ($triggered.Count -ge 1) {
    $firstReminderAt = Get-Date
    break
  }
  if (((Get-Date) - $startedAt).TotalMinutes -ge $MaxMinutes) {
    throw "timeout waiting first reminder trigger"
  }
  Start-Sleep -Seconds $PollSeconds
}

Write-Host "== Manual reset via repair endpoint =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/sessions/$sessionToken/repair" -Body @{ target_status = "idle" } -AllowStatus @(200, 404, 409) | Out-Null

$eventsAfterReset = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $ProjectId
$resetEvents = @($eventsAfterReset.items | Where-Object {
  $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_RESET" -and $_.payload.reason -eq "session_repaired" -and $_.payload.role -eq $role
})
if ($resetEvents.Count -lt 1) {
  throw "missing ORCHESTRATOR_ROLE_REMINDER_RESET(session_repaired) event"
}

Write-Host "== Verify reminder recovers after reset =="
$triggerCountBefore = @($eventsAfterReset.items | Where-Object { $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED" }).Count
$waitRecoverStart = Get-Date
while ($true) {
  $eventsLoop = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $ProjectId
  $triggeredNow = @($eventsLoop.items | Where-Object { $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED" })
  $trace += [pscustomobject]@{
    at = (Get-Date).ToString("o")
    reminder_triggered_count = $triggeredNow.Count
    role_reminder_state = (Get-RoleReminderState -ProjectId $ProjectId -Role $role)
  }
  if ($triggeredNow.Count -gt $triggerCountBefore) {
    break
  }
  if (((Get-Date) - $waitRecoverStart).TotalMinutes -ge $MaxMinutes) {
    throw "timeout waiting reminder recovery after reset"
  }
  Start-Sleep -Seconds $PollSeconds
}

Write-Host "== Export artifacts =="
Ensure-Dir -Path $artifactDir
$eventsFinal = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $ProjectId
$timeline = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/agent-io/timeline?limit=300"
$sessionsFinal = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions"
$settingsFinal = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/orchestrator/settings"
$traceObj = [pscustomobject]@{
  project_id = $ProjectId
  role = $role
  trace = $trace
}
$summary = @(
  "# Reminder E2E Summary",
  "",
  "- project_id: $ProjectId",
  "- role: $role",
  "- first_reminder_detected_at: $($firstReminderAt.ToString("o"))",
  "- reset_reason_checked: session_repaired",
  "- result: PASS"
) -join "`n"

Write-Utf8NoBom -Path (Join-Path $artifactDir "run_summary.md") -Content $summary
Write-Utf8NoBom -Path (Join-Path $artifactDir "events.ndjson") -Content $eventsFinal.raw
Write-Utf8NoBom -Path (Join-Path $artifactDir "timeline.json") -Content ($timeline.body | ConvertTo-Json -Depth 100)
Write-Utf8NoBom -Path (Join-Path $artifactDir "sessions_final.json") -Content ($sessionsFinal.body | ConvertTo-Json -Depth 100)
Write-Utf8NoBom -Path (Join-Path $artifactDir "orchestrator_settings_final.json") -Content ($settingsFinal.body | ConvertTo-Json -Depth 100)
Write-Utf8NoBom -Path (Join-Path $artifactDir "role_reminder_trace.json") -Content ($traceObj | ConvertTo-Json -Depth 100)

Write-Host "artifact_dir=$artifactDir"
Write-Host "== Reminder E2E Passed =="
