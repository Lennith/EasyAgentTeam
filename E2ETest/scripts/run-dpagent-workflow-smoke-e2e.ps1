param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\DPAgentWorkflowSmokeLite",
  [string]$RunId = "e2e_dpagent_workflow_lite_run_v1",
  [string]$TemplateId = "e2e_dpagent_workflow_lite_template_v1",
  [string]$ProviderId = "dpagent",
  [int]$MaxMinutes = 15,
  [int]$PollSeconds = 5
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $scriptDir "invoke-api.ps1")

$role = "dpagent_workflow_worker"
$sessionId = "dpagent_workflow_worker_session"
$taskId = "wf_dpagent_smoke_phase"
$workspace = $WorkspaceRoot
$artifactsBase = Join-Path $workspace "docs\e2e"

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

  Write-Host "== Reset run/template and workspace =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$RunId/stop" -AllowStatus @(200, 404, 409) | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/workflow-runs/${RunId}?force=true" -AllowStatus @(200, 404) | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/workflow-templates/$TemplateId" -AllowStatus @(200, 404) | Out-Null
  Reset-WorkspaceDirectory -WorkspaceRoot $workspace
  Ensure-Dir -Path $workspace

  Write-Host "== Upsert DPAgent workflow agent =="
  $agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents" -AllowStatus @(200)
  $known = @($agentList.body.items | Where-Object { [string]$_.agentId -eq $role }).Count -gt 0
  $agentPayload = @{
    agent_id = $role
    display_name = $role
    prompt = "You are the DPAgent workflow E2E smoke worker. Complete only the active workflow phase. Use TeamTool task_report_done when finished. Do not create extra workflow tasks."
    provider_id = $ProviderId
    default_model_params = @{ model = "dpagent-backend-default"; effort = "medium" }
    model_selection_enabled = $true
  }
  if ($known) {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$role" -Body $agentPayload -AllowStatus @(200) | Out-Null
  } else {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -Body $agentPayload -AllowStatus @(201) | Out-Null
  }

  Write-Host "== Create workflow template and run =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-templates" -AllowStatus @(201) -Body @{
    template_id = $TemplateId
    name = "E2E DPAgent Workflow Lite Template"
    description = "Single phase DPAgent workflow smoke test."
    tasks = @(@{
      task_id = $taskId
      title = "DPAgent workflow smoke phase"
      owner_role = $role
      dependencies = @()
      acceptance = @("docs/e2e/dpagent_workflow_smoke.md contains DPAGENT_WORKFLOW_SMOKE_DONE")
      artifacts = @("docs/e2e/dpagent_workflow_smoke.md")
    })
    route_table = @{ $role = @() }
    task_assign_route_table = @{ $role = @() }
    route_discuss_rounds = @{ $role = @{} }
    default_variables = @{}
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs" -AllowStatus @(201) -Body @{
    run_id = $RunId
    template_id = $TemplateId
    name = "E2E DPAgent Workflow Lite Run"
    description = "Create docs/e2e/dpagent_workflow_smoke.md containing exactly DPAGENT_WORKFLOW_SMOKE_DONE, then report the active workflow phase DONE. Do not create extra tasks or discussions."
    workspace_path = $workspace
    auto_dispatch_enabled = $false
    auto_dispatch_remaining = 0
    auto_start = $true
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$RunId/sessions" -AllowStatus @(200, 201) -Body @{
    role = $role
    session_id = $sessionId
    status = "idle"
    provider_id = $ProviderId
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/workflow-runs/$RunId/orchestrator/settings" -AllowStatus @(200) -Body @{
    auto_dispatch_enabled = $false
    auto_dispatch_remaining = 0
  } | Out-Null

  Write-Host "== Dispatch workflow phase =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$RunId/orchestrator/dispatch" -AllowStatus @(200) -Body @{
    role = $role
    task_id = $taskId
    force = $false
    only_idle = $false
  } | Out-Null

  Write-Host "== Wait for workflow completion =="
  $deadline = (Get-Date).AddMinutes($MaxMinutes)
  $finalRuntime = $null
  $finalStatus = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    $runtimeResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$RunId/task-runtime" -AllowStatus @(200)
    $statusResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$RunId/status" -AllowStatus @(200)
    $finalRuntime = $runtimeResp.body
    $finalStatus = $statusResp.body
    $task = @($runtimeResp.body.tasks | Where-Object { [string]$_.taskId -eq $taskId } | Select-Object -First 1)[0]
    $taskState = if ($task) { [string]$task.state } else { "missing" }
    Write-Host ("run_status={0} task_state={1}" -f [string]$statusResp.body.status, $taskState)
    if ([string]$statusResp.body.status -eq "finished" -and $taskState -eq "DONE") { break }
  }

  $outDir = New-SmokeArtifactDir -BaseDir $artifactsBase
  $eventsPath = Join-Path $repoRoot "data\workflows\runs\$RunId\events.jsonl"
  $events = @(Read-JsonlObjects -Path $eventsPath)
  $artifactFile = Join-Path $workspace "docs\e2e\dpagent_workflow_smoke.md"
  $artifactContent = if (Test-Path -LiteralPath $artifactFile) { Get-Content -LiteralPath $artifactFile -Raw } else { "" }
  $sessions = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$RunId/sessions" -AllowStatus @(200)
  $session = @($sessions.body.items | Where-Object { [string]$_.role -eq $role } | Select-Object -First 1)[0]
  $taskFinal = @($finalRuntime.tasks | Where-Object { [string]$_.taskId -eq $taskId } | Select-Object -First 1)[0]

  $providerEvents = @($events | Where-Object { $_.eventType -eq "PROVIDER_OBSERVATION_RECORDED" -and [string]$_.payload.providerId -eq $ProviderId })
  $summary = [ordered]@{
    run_id = $RunId
    template_id = $TemplateId
    provider_id = $ProviderId
    run_status = [string]$finalStatus.status
    task_state = if ($taskFinal) { [string]$taskFinal.state } else { "" }
    session_provider = if ($session) { [string]$session.provider } else { "" }
    provider_observation_count = $providerEvents.Count
    provider_thread_started_count = @($providerEvents | Where-Object { [string]$_.payload.kind -eq "thread_started" }).Count
    provider_run_completed_count = @($providerEvents | Where-Object { [string]$_.payload.kind -eq "run_completed" }).Count
    team_tool_report_done_count = @($providerEvents | Where-Object { [string]$_.payload.kind -eq "tool_call" -and [string]$_.payload.details.tool_name -eq "task_report_done" }).Count
    task_report_applied_count = @($events | Where-Object { $_.eventType -eq "TASK_REPORT_APPLIED" }).Count
    artifact_exists = (Test-Path -LiteralPath $artifactFile)
    artifact_contains_marker = $artifactContent.Contains("DPAGENT_WORKFLOW_SMOKE_DONE")
  }
  $summaryPath = Join-Path $outDir "dpagent-workflow-smoke-summary.json"
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

  $pass = (
    $summary.run_status -eq "finished" -and
    $summary.task_state -eq "DONE" -and
    $summary.session_provider -eq "dpagent" -and
    $summary.provider_thread_started_count -gt 0 -and
    $summary.provider_run_completed_count -gt 0 -and
    $summary.team_tool_report_done_count -gt 0 -and
    $summary.task_report_applied_count -gt 0 -and
    $summary.artifact_contains_marker
  )

  Write-Host "artifacts=$outDir"
  Write-Host "summary=$summaryPath"
  Write-Host "workflow_smoke_pass=$pass"
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
