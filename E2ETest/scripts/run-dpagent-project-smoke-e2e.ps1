param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\DPAgentProjectSmokeLite",
  [string]$ProjectId = "e2e_dpagent_project_lite_v1",
  [string]$ProviderId = "dpagent",
  [int]$MaxMinutes = 15,
  [int]$PollSeconds = 5
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $scriptDir "invoke-api.ps1")

$role = "dpagent_smoke_worker"
$taskId = "task-dpagent-project-smoke"
$rootTaskId = "$ProjectId-root"
$workspace = $WorkspaceRoot
$artifactsBase = Join-Path $workspace "docs\e2e"

function New-SmokeTaskCreateBody {
  return @{
    action_type = "TASK_CREATE"
    from_agent = "manager"
    from_session_id = "manager-system"
    task_id = $taskId
    task_kind = "EXECUTION"
    parent_task_id = $rootTaskId
    root_task_id = $rootTaskId
    title = "DPAgent project smoke task"
    owner_role = $role
    priority = 100
    dependencies = @()
    write_set = @("docs/e2e/dpagent_project_smoke.md")
    acceptance = @("docs/e2e/dpagent_project_smoke.md contains DPAGENT_PROJECT_SMOKE_DONE")
    artifacts = @("docs/e2e/dpagent_project_smoke.md")
    content = "Create docs/e2e/dpagent_project_smoke.md containing exactly DPAGENT_PROJECT_SMOKE_DONE, then call task_report_done for this task. Do not create extra tasks and do not start discussions."
  }
}

function Read-JsonlObjects {
  param([string]$Path)
  $items = @()
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try { $items += ($trimmed | ConvertFrom-Json) } catch {}
  }
  return @($items)
}

function New-SmokeArtifactDir {
  param([string]$BaseDir)
  Ensure-Dir -Path $BaseDir
  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $path = Join-Path $BaseDir $stamp
  Ensure-Dir -Path $path
  return $path
}

try {
  Write-Host "== Preflight =="
  $health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz" -AllowStatus @(200)
  if ($health.body.status -ne "ok") { throw "healthz is not ok" }

  Write-Host "== Reset project and workspace =="
  $projects = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects" -AllowStatus @(200)
  if (@($projects.body.items | Where-Object { $_.projectId -eq $ProjectId }).Count -gt 0) {
    Remove-ProjectWithRetry -BaseUrl $BaseUrl -ProjectId $ProjectId | Out-Null
  }
  Reset-WorkspaceDirectory -WorkspaceRoot $workspace
  Ensure-Dir -Path $workspace

  Write-Host "== Upsert DPAgent smoke agent =="
  $agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents" -AllowStatus @(200)
  $known = @($agentList.body.items | Where-Object { [string]$_.agentId -eq $role }).Count -gt 0
  $agentPayload = @{
    agent_id = $role
    display_name = $role
    prompt = "You are the DPAgent E2E smoke worker. Follow the assigned task exactly. Use TeamTool task_report_done when finished. Do not create extra tasks."
    provider_id = $ProviderId
    default_model_params = @{ model = "dpagent-backend-default"; effort = "medium" }
    model_selection_enabled = $true
  }
  if ($known) {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$role" -Body $agentPayload -AllowStatus @(200) | Out-Null
  } else {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -Body $agentPayload -AllowStatus @(201) | Out-Null
  }

  Write-Host "== Create project and role session =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects" -AllowStatus @(201) -Body @{
    project_id = $ProjectId
    name = "E2E DPAgent Project Lite"
    workspace_path = $workspace
    agent_ids = @($role)
    route_table = @{ $role = @() }
    route_discuss_rounds = @{ $role = @{} }
    auto_dispatch_enabled = $false
    auto_dispatch_remaining = 0
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$ProjectId/routing-config" -AllowStatus @(200) -Body @{
    agent_ids = @($role)
    route_table = @{ $role = @() }
    route_discuss_rounds = @{ $role = @{} }
    agent_model_configs = @{ $role = @{ provider_id = $ProviderId; model = "dpagent-config"; effort = "medium" } }
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$ProjectId/orchestrator/settings" -AllowStatus @(200) -Body @{
    auto_dispatch_enabled = $false
    auto_dispatch_remaining = 0
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/sessions" -AllowStatus @(200, 201, 409) -Body @{ role = $role } | Out-Null

  Write-Host "== Create and dispatch smoke task =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/task-actions" -AllowStatus @(201) -Body (New-SmokeTaskCreateBody) | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/orchestrator/dispatch" -AllowStatus @(200) -Body @{ role = $role; task_id = $taskId; force = $false; only_idle = $false } | Out-Null

  Write-Host "== Wait for completion =="
  $deadline = (Get-Date).AddMinutes($MaxMinutes)
  $finalDetail = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    $detail = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/tasks/$taskId/detail" -AllowStatus @(200)
    $finalDetail = $detail.body
    $state = [string]$detail.body.task.state
    Write-Host "task_state=$state"
    if ($state -eq "DONE") { break }
  }

  $outDir = New-SmokeArtifactDir -BaseDir $artifactsBase
  $eventsPath = Join-Path $repoRoot "data\projects\$ProjectId\collab\events.jsonl"
  $agentOutputPath = Join-Path $repoRoot "data\projects\$ProjectId\collab\audit\agent_output.jsonl"
  $events = @(Read-JsonlObjects -Path $eventsPath)
  $agentOutput = @(Read-JsonlObjects -Path $agentOutputPath)
  $artifactFile = Join-Path $workspace "docs\e2e\dpagent_project_smoke.md"
  $artifactContent = if (Test-Path -LiteralPath $artifactFile) { Get-Content -LiteralPath $artifactFile -Raw } else { "" }
  $sessions = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions" -AllowStatus @(200)
  $session = @($sessions.body.items | Where-Object { [string]$_.role -eq $role } | Select-Object -First 1)[0]

  $summary = [ordered]@{
    project_id = $ProjectId
    provider_id = $ProviderId
    task_state = [string]$finalDetail.task.state
    session_provider = if ($session) { [string]$session.provider } else { "" }
    run_started_count = @($events | Where-Object { $_.eventType -eq "CODEX_RUN_STARTED" }).Count
    run_finished_count = @($events | Where-Object { $_.eventType -eq "CODEX_RUN_FINISHED" }).Count
    team_tool_report_done_count = @($events | Where-Object { $_.eventType -eq "TEAM_TOOL_CALLED" -and [string]$_.payload.tool -eq "task_report_done" }).Count
    task_report_applied_count = @($events | Where-Object { $_.eventType -eq "TASK_REPORT_APPLIED" }).Count
    agent_output_line_count = $agentOutput.Count
    artifact_exists = (Test-Path -LiteralPath $artifactFile)
    artifact_contains_marker = $artifactContent.Contains("DPAGENT_PROJECT_SMOKE_DONE")
  }
  $summaryPath = Join-Path $outDir "dpagent-project-smoke-summary.json"
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

  $pass = (
    $summary.task_state -eq "DONE" -and
    $summary.session_provider -eq "dpagent" -and
    $summary.run_started_count -gt 0 -and
    $summary.run_finished_count -gt 0 -and
    $summary.team_tool_report_done_count -gt 0 -and
    $summary.task_report_applied_count -gt 0 -and
    $summary.agent_output_line_count -gt 0 -and
    $summary.artifact_contains_marker
  )

  Write-Host "artifacts=$outDir"
  Write-Host "summary=$summaryPath"
  Write-Host "project_smoke_pass=$pass"
  if (-not $pass) {
    $summary | ConvertTo-Json -Depth 8 | Write-Host
    exit 1
  }
  exit 0
} catch {
  Write-Host ("script_exception_message=" + $_.Exception.Message)
  Write-Host ("script_exception_stack=" + $_.ScriptStackTrace)
  exit 2
}
