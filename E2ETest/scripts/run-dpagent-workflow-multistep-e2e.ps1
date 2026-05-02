param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$ScenarioPath = "",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\DPAgentWorkflowMultiStepLong",
  [string]$ProviderId = "dpagent",
  [int]$MaxMinutes = 120,
  [int]$PollSeconds = 10,
  [int]$StaleRedispatchPolls = 6
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $scriptDir "invoke-api.ps1")

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\dpagent-workflow-multistep-long.json"
}
if (-not (Test-Path -LiteralPath $ScenarioPath)) {
  throw "Scenario file not found: $ScenarioPath"
}

$scenario = Get-Content -LiteralPath $ScenarioPath -Encoding UTF8 -Raw | ConvertFrom-Json
$workspace = $WorkspaceRoot
$runStamp = Get-Date -Format "yyyyMMddHHmmss"
$runIdPrefix = if ($scenario.run_id_prefix) { [string]$scenario.run_id_prefix } else { "e2e_dpagent_workflow_multistep_long_run" }
$runId = "${runIdPrefix}_${runStamp}"
$templateId = [string]$scenario.template_id
$roles = $scenario.roles
$phaseTasks = @($scenario.phase_tasks)
$artifactsBase = Join-Path $workspace "docs\e2e"
$deadline = (Get-Date).AddMinutes($MaxMinutes)

function Ensure-ScenarioDir {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function New-MultistepArtifactDir {
  param([string]$BaseDir)
  Ensure-ScenarioDir -Path $BaseDir
  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $path = Join-Path $BaseDir $stamp
  Ensure-ScenarioDir -Path $path
  return $path
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

function Resolve-RoleKey {
  param([string]$RoleId)
  foreach ($prop in $roles.PSObject.Properties) {
    if ([string]$prop.Value -eq $RoleId) { return [string]$prop.Name }
  }
  return $RoleId
}

function Resolve-RoleModelConfig {
  param([string]$RoleId)
  $roleKey = Resolve-RoleKey -RoleId $RoleId
  $config = $scenario.agent_model_matrix.$roleKey
  if (-not $config) {
    return [pscustomobject]@{ provider_id = $ProviderId; model = "dpagent-backend-default"; effort = "medium" }
  }
  return $config
}

function New-AgentPrompt {
  param([string]$RoleId)
  return @"
You are $RoleId in a DPAgent multi-step E2E workflow.
Follow the active workflow task exactly.
Write every requested artifact before reporting DONE.
Every artifact must include the marker named in the task acceptance criteria.
Use TeamTool task_report_in_progress when starting substantial work and task_report_done when the active task is complete.
Do not create extra tasks unless the active task explicitly asks for it.
Do not finish by natural language only; TeamTool report is required.
"@
}

function Get-TaskRuntimeById {
  param([object]$Runtime, [string]$TaskId)
  return @($Runtime.tasks | Where-Object { [string]$_.taskId -eq $TaskId } | Select-Object -First 1)[0]
}

function Get-RunningSessionCount {
  param([object]$Sessions)
  return @($Sessions.items | Where-Object { [string]$_.status -eq "running" }).Count
}

function Invoke-DispatchTask {
  param([object]$Task, [bool]$Force = $false)
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/orchestrator/dispatch" -AllowStatus @(200) -Body @{
    role = [string]$Task.owner_role
    task_id = [string]$Task.task_id
    force = $Force
    only_idle = $false
  } | Out-Null
}

function Wait-TaskDone {
  param([object]$Task)
  $taskId = [string]$Task.task_id
  $lastState = ""
  $sameStatePolls = 0
  $dispatchCount = 0
  Invoke-DispatchTask -Task $Task
  $dispatchCount += 1

  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    $runtimeResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/task-runtime" -AllowStatus @(200)
    $sessionsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/sessions" -AllowStatus @(200)
    $runtimeTask = Get-TaskRuntimeById -Runtime $runtimeResp.body -TaskId $taskId
    if (-not $runtimeTask) { throw "task not found in runtime: $taskId" }
    $state = [string]$runtimeTask.state
    $running = Get-RunningSessionCount -Sessions $sessionsResp.body
    Write-Host ("task={0} state={1} running={2} dispatches={3}" -f $taskId, $state, $running, $dispatchCount)

    if ($state -eq "DONE") {
      return [pscustomobject]@{ task_id = $taskId; state = $state; dispatch_count = $dispatchCount }
    }
    if ($state -eq "CANCELED") {
      throw "task canceled: $taskId"
    }
    if ($state -eq $lastState) { $sameStatePolls += 1 } else { $sameStatePolls = 0 }
    $lastState = $state

    if ($running -eq 0 -and ($state -eq "READY" -or $state -eq "DISPATCHED" -or $state -eq "IN_PROGRESS") -and $sameStatePolls -ge $StaleRedispatchPolls) {
      Write-Host ("redispatch task={0} after stale polls={1}" -f $taskId, $sameStatePolls)
      Invoke-DispatchTask -Task $Task
      $dispatchCount += 1
      $sameStatePolls = 0
    }
  }
  throw "timeout waiting for task DONE: $taskId"
}

function Test-ArtifactMarker {
  param([string]$RelativePath, [string]$Marker)
  $rootPath = Join-Path $workspace $RelativePath
  if (Test-Path -LiteralPath $rootPath) {
    $content = Get-Content -LiteralPath $rootPath -Raw
    if ($content.Contains($Marker)) {
      return [pscustomobject]@{ path = $rootPath; exists = $true; contains_marker = $true; location = "workspace" }
    }
    return [pscustomobject]@{ path = $rootPath; exists = $true; contains_marker = $false; location = "workspace" }
  }
  $matches = @(Get-ChildItem -LiteralPath (Join-Path $workspace "Agents") -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName.Replace("/", "\").EndsWith($RelativePath.Replace("/", "\")) })
  foreach ($match in $matches) {
    $content = Get-Content -LiteralPath $match.FullName -Raw
    if ($content.Contains($Marker)) {
      return [pscustomobject]@{ path = $match.FullName; exists = $true; contains_marker = $true; location = "agent_workspace" }
    }
  }
  return [pscustomobject]@{ path = $rootPath; exists = $false; contains_marker = $false; location = "missing" }
}

try {
  Write-Host "== Preflight =="
  $health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz" -AllowStatus @(200)
  if ($health.body.status -ne "ok") { throw "healthz is not ok" }

  Write-Host "== Reset workflow and workspace =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/workflow-templates/$templateId" -AllowStatus @(200, 404) | Out-Null
  Reset-WorkspaceDirectory -WorkspaceRoot $workspace
  Ensure-ScenarioDir -Path $workspace

  Write-Host "== Upsert role agents =="
  $agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents" -AllowStatus @(200)
  foreach ($prop in $roles.PSObject.Properties) {
    $roleId = [string]$prop.Value
    $known = @($agentList.body.items | Where-Object { [string]$_.agentId -eq $roleId }).Count -gt 0
    $roleConfig = Resolve-RoleModelConfig -RoleId $roleId
    $payload = @{
      agent_id = $roleId
      display_name = $roleId
      prompt = (New-AgentPrompt -RoleId $roleId)
      provider_id = [string]$roleConfig.provider_id
      default_model_params = @{ model = [string]$roleConfig.model; effort = [string]$roleConfig.effort }
      model_selection_enabled = $true
    }
    if ($known) {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$roleId" -Body $payload -AllowStatus @(200) | Out-Null
    } else {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -Body $payload -AllowStatus @(201) | Out-Null
    }
  }

  Write-Host "== Create workflow template and run =="
  $templateTasks = @()
  foreach ($task in $phaseTasks) {
    $templateTasks += @{
      task_id = [string]$task.task_id
      title = [string]$task.title
      owner_role = [string]$task.owner_role
      dependencies = @($task.dependencies | ForEach-Object { [string]$_ })
      acceptance = @($task.acceptance | ForEach-Object { [string]$_ })
      artifacts = @($task.artifacts | ForEach-Object { [string]$_ })
    }
  }
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-templates" -AllowStatus @(201) -Body @{
    template_id = $templateId
    name = [string]$scenario.workflow_name
    description = [string]$scenario.primary_goal
    tasks = $templateTasks
    route_table = $scenario.route_table
    task_assign_route_table = $scenario.task_assign_route_table
    route_discuss_rounds = $scenario.route_discuss_rounds
    default_variables = @{}
  } | Out-Null

  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs" -AllowStatus @(201) -Body @{
    run_id = $runId
    template_id = $templateId
    name = "$($scenario.workflow_name) $runStamp"
    description = [string]$scenario.primary_goal
    workspace_path = $workspace
    auto_dispatch_enabled = $false
    auto_dispatch_remaining = 0
    auto_start = $true
  } | Out-Null

  Write-Host "== Register sessions =="
  foreach ($prop in $roles.PSObject.Properties) {
    $roleId = [string]$prop.Value
    $roleConfig = Resolve-RoleModelConfig -RoleId $roleId
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/sessions" -AllowStatus @(200, 201) -Body @{
      role = $roleId
      session_id = "${roleId}_session"
      status = "idle"
      provider_id = [string]$roleConfig.provider_id
    } | Out-Null
  }
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/workflow-runs/$runId/orchestrator/settings" -AllowStatus @(200) -Body @{
    auto_dispatch_enabled = $false
    auto_dispatch_remaining = 0
  } | Out-Null

  Write-Host "== Execute ordered phases =="
  $taskResults = @()
  foreach ($task in $phaseTasks) {
    $taskResults += Wait-TaskDone -Task $task
  }

  Write-Host "== Wait for run finish =="
  $finalStatus = $null
  while ((Get-Date) -lt $deadline) {
    $statusResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/status" -AllowStatus @(200)
    $finalStatus = $statusResp.body
    Write-Host ("run_status={0}" -f [string]$finalStatus.status)
    if ([string]$finalStatus.status -eq "finished") { break }
    Start-Sleep -Seconds $PollSeconds
  }

  $outDir = New-MultistepArtifactDir -BaseDir $artifactsBase
  $eventsPath = Join-Path $repoRoot "data\workflows\runs\$runId\events.jsonl"
  $events = @(Read-JsonlObjects -Path $eventsPath)
  $sessions = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/sessions" -AllowStatus @(200)
  $runtime = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/task-runtime" -AllowStatus @(200)

  $artifactChecks = @()
  foreach ($task in $phaseTasks) {
    $marker = [string]$task.marker
    foreach ($artifact in @($task.artifacts)) {
      $artifactChecks += Test-ArtifactMarker -RelativePath ([string]$artifact) -Marker $marker
    }
  }

  $providerEvents = @($events | Where-Object { $_.eventType -eq "PROVIDER_OBSERVATION_RECORDED" -and [string]$_.payload.providerId -eq $ProviderId })
  $summary = [ordered]@{
    scenario_id = [string]$scenario.scenario_id
    run_id = $runId
    template_id = $templateId
    provider_id = $ProviderId
    run_status = [string]$finalStatus.status
    started_at = $runtime.body.updatedAt
    task_count = $phaseTasks.Count
    done_task_count = @($runtime.body.tasks | Where-Object { [string]$_.state -eq "DONE" }).Count
    open_task_count = @($runtime.body.tasks | Where-Object { [string]$_.state -ne "DONE" -and [string]$_.state -ne "CANCELED" }).Count
    session_provider_mismatches = @($sessions.body.items | Where-Object { [string]$_.provider -ne $ProviderId } | ForEach-Object { [string]$_.role })
    provider_observation_count = $providerEvents.Count
    provider_thread_started_count = @($providerEvents | Where-Object { [string]$_.payload.kind -eq "thread_started" }).Count
    provider_run_completed_count = @($providerEvents | Where-Object { [string]$_.payload.kind -eq "run_completed" }).Count
    team_tool_report_done_count = @($providerEvents | Where-Object { [string]$_.payload.kind -eq "tool_call" -and [string]$_.payload.details.tool_name -eq "task_report_done" }).Count
    task_report_applied_count = @($events | Where-Object { $_.eventType -eq "TASK_REPORT_APPLIED" }).Count
    artifact_checks = $artifactChecks
    task_results = $taskResults
  }
  $summaryPath = Join-Path $outDir "dpagent-workflow-multistep-summary.json"
  $summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

  $artifactPass = @($artifactChecks | Where-Object { -not $_.exists -or -not $_.contains_marker }).Count -eq 0
  $providerPass = $summary.provider_thread_started_count -ge $phaseTasks.Count -and $summary.provider_run_completed_count -ge $phaseTasks.Count
  $pass = (
    $summary.run_status -eq "finished" -and
    $summary.done_task_count -ge $phaseTasks.Count -and
    $summary.open_task_count -eq 0 -and
    @($summary.session_provider_mismatches).Count -eq 0 -and
    $summary.team_tool_report_done_count -ge $phaseTasks.Count -and
    $summary.task_report_applied_count -ge $phaseTasks.Count -and
    $artifactPass -and
    $providerPass
  )

  Write-Host "artifacts=$outDir"
  Write-Host "summary=$summaryPath"
  Write-Host "multistep_pass=$pass"
  if (-not $pass) {
    $summary | ConvertTo-Json -Depth 12 | Write-Host
    exit 1
  }
  exit 0
} catch {
  Write-Host ("script_exception_message=" + $_.Exception.Message)
  Write-Host ("script_exception_stack=" + $_.ScriptStackTrace)
  exit 2
}
