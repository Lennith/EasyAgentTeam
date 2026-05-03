param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$ScenarioPath = "",
  [string]$SourceConfigPath = "D:/MinimaxTest/config.yaml",
  [string]$DpAgentRoot = "D:/work/MiniMaxAgentNodeJs",
  [string]$WorkspaceRoot = "D:/AgentWorkSpace/TestTeam/DPAgentSessionIsolation",
  [string]$RunId = "",
  [int]$MaxMinutes = 30,
  [int]$PollSeconds = 5
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $scriptDir "invoke-api.ps1")

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\dpagent-session-isolation-minimal.json"
}

$dpagentWrapper = Join-Path $scriptDir "dpagent-dev-wrapper.cmd"
$syncHelper = Join-Path $scriptDir "sync-dpagent-dev-config.mjs"

function Test-DpAgentBackendReady {
  param([string]$Url)
  try {
    $resp = Invoke-WebRequest -Uri "$Url/api/auth/status" -UseBasicParsing -TimeoutSec 3
    return ([int]$resp.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Resolve-DpAgentBackendLaunch {
  param([string]$Root)
  $serverEntry = Join-Path $Root "src\web\server\index.ts"
  $tsxEntry = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
  if ((Test-Path -LiteralPath $serverEntry) -and (Test-Path -LiteralPath $tsxEntry)) {
    return [pscustomobject]@{
      Mode = "dev-server"
      FilePath = (Get-Command node.exe -ErrorAction Stop).Source
      Arguments = @($tsxEntry, $serverEntry)
    }
  }
  $distEntry = Join-Path $Root "dist\cli\minimax-agent.js"
  if (Test-Path -LiteralPath $distEntry) {
    return [pscustomobject]@{
      Mode = "dist-cli"
      FilePath = (Get-Command node.exe -ErrorAction Stop).Source
      Arguments = @($distEntry, "--no-open")
    }
  }
  throw "DPAgent backend source and dist entry are both unavailable under $Root."
}

function Start-DpAgentBackendIfNeeded {
  param(
    [string]$Root,
    [string]$Workspace
  )
  $url = "http://localhost:53721"
  $handle = [pscustomobject]@{ StartedByScript = $false; Process = $null; Url = $url; StdoutPath = ""; StderrPath = "" }
  if (Test-DpAgentBackendReady -Url $url) {
    Write-Host "DPAgent backend is already available: $url"
    return $handle
  }

  $launch = Resolve-DpAgentBackendLaunch -Root $Root
  $logDir = Join-Path $Workspace "docs\e2e\dpagent-backend"
  Ensure-Dir -Path $logDir
  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $stdoutPath = Join-Path $logDir "dpagent_stdout_$stamp.log"
  $stderrPath = Join-Path $logDir "dpagent_stderr_$stamp.log"
  $previousAllowMissingKey = $env:MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT
  $previousPort = $env:MINIMAX_PORT
  try {
    $env:MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT = "1"
    $env:MINIMAX_PORT = "53721"
    $proc = Start-Process `
      -FilePath $launch.FilePath `
      -ArgumentList $launch.Arguments `
      -WorkingDirectory $Root `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath
  } finally {
    if ($null -eq $previousAllowMissingKey) { Remove-Item Env:\MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT -ErrorAction SilentlyContinue } else { $env:MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT = $previousAllowMissingKey }
    if ($null -eq $previousPort) { Remove-Item Env:\MINIMAX_PORT -ErrorAction SilentlyContinue } else { $env:MINIMAX_PORT = $previousPort }
  }

  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if (Test-DpAgentBackendReady -Url $url) {
      $handle.StartedByScript = $true
      $handle.Process = $proc
      $handle.StdoutPath = $stdoutPath
      $handle.StderrPath = $stderrPath
      Write-Host "DPAgent backend is ready. mode=$($launch.Mode) pid=$($proc.Id)"
      return $handle
    }
    Start-Sleep -Seconds 1
  }
  if ($proc -and -not $proc.HasExited) {
    Stop-ProcessTreeBestEffort -ProcessId $proc.Id | Out-Null
  }
  throw "DPAgent backend bootstrap failed. stdout=$stdoutPath stderr=$stderrPath"
}

function Stop-DpAgentBackendIfStarted {
  param([object]$Handle)
  if ($Handle -and $Handle.StartedByScript -and $Handle.Process -and -not $Handle.Process.HasExited) {
    Write-Host "Stopping DPAgent backend process tree pid=$($Handle.Process.Id)"
    Stop-ProcessTreeBestEffort -ProcessId $Handle.Process.Id | Out-Null
  }
}

function Get-ProviderProfileValue {
  param(
    [object]$SettingsBody,
    [string]$ProviderId,
    [string]$Name
  )
  $providers = $SettingsBody.providers
  if (-not $providers) { return $null }
  $provider = $providers.$ProviderId
  if (-not $provider) { return $null }
  return $provider.$Name
}

function Set-DpAgentCliCommand {
  param(
    [string]$Command
  )
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/settings" -AllowStatus @(200) -Body @{
    providers = @{ dpagent = @{ cliCommand = $Command } }
  } | Out-Null
}

function Get-JsonFile {
  param([string]$Path)
  return (Get-Content -LiteralPath $Path -Encoding UTF8 -Raw | ConvertFrom-Json)
}

function Read-JsonlObjects {
  param([string]$Path)
  $items = @()
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try { $items += ($trimmed | ConvertFrom-Json) } catch {}
  }
  return @($items)
}

function Get-TaskState {
  param(
    [object]$RuntimeBody,
    [string]$TaskId
  )
  $task = @($RuntimeBody.tasks | Where-Object { [string]$_.taskId -eq $TaskId } | Select-Object -First 1)[0]
  if ($task) { return [string]$task.state }
  return "missing"
}

function Wait-WorkflowTaskDone {
  param(
    [string]$RunId,
    [string]$TaskId,
    [datetime]$Deadline
  )
  while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds $PollSeconds
    $runtimeResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$RunId/task-runtime" -AllowStatus @(200)
    $state = Get-TaskState -RuntimeBody $runtimeResp.body -TaskId $TaskId
    Write-Host ("task={0} state={1}" -f $TaskId, $state)
    if ($state -eq "DONE") {
      return $true
    }
    if ($state -eq "BLOCKED_DEP" -or $state -eq "CANCELED") {
      return $false
    }
  }
  return $false
}

function New-RoleAgentPrompt {
  param(
    [string]$Role,
    [string]$Marker
  )
  return @"
ISOLATION_ROLE=$Role
You are $Role for the DPAgent session isolation E2E.
Only complete the active workflow task assigned to this exact role.
Write the requested artifact with marker $Marker, then call task_report_done.
Do not create subtasks, discussions, or reports for any other role.
"@
}

function Build-TaskDefinitions {
  param([object[]]$PhaseTasks)
  $items = @()
  foreach ($task in $PhaseTasks) {
    $items += @{
      task_id = [string]$task.task_id
      title = [string]$task.title
      owner_role = [string]$task.owner_role
      dependencies = @($task.dependencies)
      acceptance = @($task.acceptance)
      artifacts = @($task.artifacts)
    }
  }
  return @($items)
}

function Get-RoleEntries {
  param([object]$Scenario)
  $entries = @()
  foreach ($prop in $Scenario.roles.PSObject.Properties) {
    $entries += [pscustomobject]@{ Key = [string]$prop.Name; Role = [string]$prop.Value }
  }
  return @($entries)
}

function Test-ArtifactMarkers {
  param(
    [string]$Workspace,
    [object[]]$PhaseTasks
  )
  $results = @()
  foreach ($task in $PhaseTasks) {
    $artifact = @($task.artifacts | Select-Object -First 1)[0]
    $path = Join-Path $Workspace ([string]$artifact)
    $content = if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw } else { "" }
    $results += [ordered]@{
      task_id = [string]$task.task_id
      role = [string]$task.owner_role
      artifact = [string]$artifact
      marker = [string]$task.marker
      exists = (Test-Path -LiteralPath $path)
      contains_marker = $content.Contains([string]$task.marker)
    }
  }
  return @($results)
}

function Get-ContextTextForProviderSession {
  param(
    [string]$DpAgentRoot,
    [string]$ProviderSessionId
  )
  $contextDir = Join-Path $DpAgentRoot ("contexts\session\{0}" -f $ProviderSessionId)
  $parts = @()
  foreach ($name in @("events.jsonl", "latest_llm_input_messages.json", "meta.json")) {
    $path = Join-Path $contextDir $name
    if (Test-Path -LiteralPath $path) {
      $parts += (Get-Content -LiteralPath $path -Raw)
    }
  }
  return ($parts -join "`n")
}

function Build-SessionIsolationAudit {
  param(
    [string]$RunId,
    [string]$DpAgentRoot,
    [object[]]$Roles,
    [object[]]$PhaseTasks,
    [string]$Workspace
  )
  $eventsPath = Join-Path $repoRoot "data\workflows\runs\$RunId\events.jsonl"
  $events = @(Read-JsonlObjects -Path $eventsPath)
  $providerEvents = @($events | Where-Object { $_.eventType -eq "PROVIDER_OBSERVATION_RECORDED" -and [string]$_.payload.providerId -eq "dpagent" })
  $launchConfigs = @($providerEvents | Where-Object { [string]$_.payload.kind -eq "launch_config" })
  $threadStarted = @($providerEvents | Where-Object { [string]$_.payload.kind -eq "thread_started" })
  $markersByRole = @{}
  foreach ($task in $PhaseTasks) {
    $markersByRole[[string]$task.owner_role] = "ISOLATION_ROLE=$([string]$task.owner_role)"
  }
  $providerSessionToRoles = @{}
  foreach ($event in $threadStarted) {
    $sid = [string]$event.payload.providerSessionId
    if (-not $providerSessionToRoles.ContainsKey($sid)) {
      $providerSessionToRoles[$sid] = @()
    }
    $providerSessionToRoles[$sid] += [string]$event.payload.role
  }

  $items = @()
  foreach ($roleEntry in $Roles) {
    $role = [string]$roleEntry.Role
    $roleLaunches = @($launchConfigs | Where-Object { [string]$_.payload.role -eq $role })
    $roleThreads = @($threadStarted | Where-Object { [string]$_.payload.role -eq $role })
    $providerSessionIds = @($roleThreads | ForEach-Object { [string]$_.payload.providerSessionId } | Where-Object { $_ } | Select-Object -Unique)
    $markerLeakItems = @()
    foreach ($sid in $providerSessionIds) {
      $text = Get-ContextTextForProviderSession -DpAgentRoot $DpAgentRoot -ProviderSessionId $sid
      $ownMarker = $markersByRole[$role]
      $foreignMarkers = @()
      foreach ($otherRole in $markersByRole.Keys) {
        if ($otherRole -eq $role) { continue }
        $marker = $markersByRole[$otherRole]
        if ($text.Contains($marker)) {
          $foreignMarkers += $marker
        }
      }
      $markerLeakItems += [ordered]@{
        provider_session_id = $sid
        context_exists = (Test-Path -LiteralPath (Join-Path $DpAgentRoot ("contexts\session\{0}" -f $sid)))
        contains_own_role_marker = $text.Contains($ownMarker)
        foreign_role_markers = @($foreignMarkers)
      }
    }
    $items += [ordered]@{
      role = $role
      launch_count = $roleLaunches.Count
      thread_started_count = $roleThreads.Count
      provider_session_ids = @($providerSessionIds)
      marker_checks = @($markerLeakItems)
    }
  }

  $duplicateProviderSessions = @()
  foreach ($sid in $providerSessionToRoles.Keys) {
    $uniqueRoles = @($providerSessionToRoles[$sid] | Select-Object -Unique)
    if ($uniqueRoles.Count -gt 1) {
      $duplicateProviderSessions += [ordered]@{ provider_session_id = $sid; roles = @($uniqueRoles) }
    }
  }
  $artifactChecks = @(Test-ArtifactMarkers -Workspace $Workspace -PhaseTasks $PhaseTasks)
  $expectedRoleCount = $Roles.Count
  $rolesWithOneSession = @($items | Where-Object { $_.provider_session_ids.Count -eq 1 }).Count
  $markerChecks = @($items | ForEach-Object { $_.marker_checks } | ForEach-Object { $_ })
  return [ordered]@{
    run_id = $RunId
    expected_role_count = $expectedRoleCount
    dpagent_provider_observation_count = $providerEvents.Count
    duplicate_provider_sessions_across_roles = @($duplicateProviderSessions)
    roles_with_exactly_one_provider_session = $rolesWithOneSession
    all_roles_have_exactly_one_provider_session = ($rolesWithOneSession -eq $expectedRoleCount)
    all_contexts_have_own_marker = (@($markerChecks | Where-Object { -not $_.contains_own_role_marker }).Count -eq 0)
    no_foreign_role_markers = (@($markerChecks | Where-Object { $_.foreign_role_markers.Count -gt 0 }).Count -eq 0)
    artifacts_all_markers_present = (@($artifactChecks | Where-Object { -not $_.contains_marker }).Count -eq 0)
    roles = @($items)
    artifact_checks = @($artifactChecks)
  }
}

$backendHandle = $null
$previousDpAgentCli = $null
$stamp = Get-Date -Format "yyyyMMddHHmmss"
if (-not $RunId) {
  $RunId = "e2e_dpagent_session_iso_run_$stamp"
}
$workspace = "$WorkspaceRoot-$stamp"

try {
  if (-not (Test-Path -LiteralPath $ScenarioPath)) { throw "Scenario file not found: $ScenarioPath" }
  if (-not (Test-Path -LiteralPath $dpagentWrapper)) { throw "Missing DPAgent wrapper: $dpagentWrapper" }
  if (-not (Test-Path -LiteralPath $syncHelper)) { throw "Missing DPAgent config sync helper: $syncHelper" }

  $scenario = Get-JsonFile -Path $ScenarioPath
  $roles = @(Get-RoleEntries -Scenario $scenario)
  $phaseTasks = @($scenario.phase_tasks)
  Reset-WorkspaceDirectory -WorkspaceRoot $workspace
  Ensure-Dir -Path $workspace

  Write-Host "== Preflight =="
  $health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz" -AllowStatus @(200)
  if ($health.body.status -ne "ok") { throw "healthz is not ok" }
  $syncOutput = & node $syncHelper $SourceConfigPath $DpAgentRoot
  if ($LASTEXITCODE -ne 0) { throw "DPAgent config sync failed." }
  Write-Host "DPAgent config synced."
  $backendHandle = Start-DpAgentBackendIfNeeded -Root $DpAgentRoot -Workspace $workspace

  $beforeSettings = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/settings" -AllowStatus @(200)
  $previousDpAgentCli = [string](Get-ProviderProfileValue -SettingsBody $beforeSettings.body -ProviderId "dpagent" -Name "cliCommand")
  if ([string]::IsNullOrWhiteSpace($previousDpAgentCli)) { $previousDpAgentCli = "dpagent" }
  Set-DpAgentCliCommand -Command $dpagentWrapper

  Write-Host "== Reset workflow run/template and workspace =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$RunId/stop" -AllowStatus @(200, 404, 409) | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/workflow-runs/${RunId}?force=true" -AllowStatus @(200, 404) | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/workflow-templates/$($scenario.template_id)" -AllowStatus @(200, 404) | Out-Null
  Ensure-Dir -Path $workspace

  Write-Host "== Upsert DPAgent isolation agents =="
  $agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents" -AllowStatus @(200)
  foreach ($roleEntry in $roles) {
    $role = [string]$roleEntry.Role
    $task = @($phaseTasks | Where-Object { [string]$_.owner_role -eq $role } | Select-Object -First 1)[0]
    $prompt = New-RoleAgentPrompt -Role $role -Marker ([string]$task.marker)
    $known = @($agentList.body.items | Where-Object { [string]$_.agentId -eq $role }).Count -gt 0
    $payload = @{
      agent_id = $role
      display_name = $role
      prompt = $prompt
      provider_id = "dpagent"
      default_model_params = @{ model = "dpagent-backend-default"; effort = "medium" }
      model_selection_enabled = $true
    }
    if ($known) {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$role" -Body $payload -AllowStatus @(200) | Out-Null
    } else {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -Body $payload -AllowStatus @(201) | Out-Null
    }
  }

  Write-Host "== Create workflow template and run =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-templates" -AllowStatus @(201) -Body @{
    template_id = [string]$scenario.template_id
    name = [string]$scenario.workflow_name
    description = [string]$scenario.primary_goal
    tasks = @(Build-TaskDefinitions -PhaseTasks $phaseTasks)
    route_table = $scenario.route_table
    task_assign_route_table = $scenario.task_assign_route_table
    route_discuss_rounds = $scenario.route_discuss_rounds
    default_variables = @{}
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs" -AllowStatus @(201) -Body @{
    run_id = $RunId
    template_id = [string]$scenario.template_id
    name = [string]$scenario.workflow_name
    description = "DPAgent session isolation minimal run. Each role writes exactly its own marker artifact and reports DONE."
    workspace_path = $workspace
    auto_dispatch_enabled = $false
    auto_dispatch_remaining = 0
    auto_start = $true
  } | Out-Null
  foreach ($roleEntry in $roles) {
    $role = [string]$roleEntry.Role
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$RunId/sessions" -AllowStatus @(200, 201) -Body @{
      role = $role
      session_id = ("{0}_{1}_session" -f $RunId, $role)
      status = "idle"
      provider_id = "dpagent"
    } | Out-Null
  }
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/workflow-runs/$RunId/orchestrator/settings" -AllowStatus @(200) -Body @{
    auto_dispatch_enabled = $false
    auto_dispatch_remaining = 0
  } | Out-Null

  Write-Host "== Dispatch five DPAgent roles =="
  $deadline = (Get-Date).AddMinutes($MaxMinutes)
  foreach ($task in $phaseTasks) {
    $role = [string]$task.owner_role
    $taskId = [string]$task.task_id
    Write-Host ("dispatch role={0} task={1}" -f $role, $taskId)
    $dispatchResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$RunId/orchestrator/dispatch" -AllowStatus @(200, 500) -Body @{
      role = $role
      task_id = $taskId
      force = $false
      only_idle = $false
    }
    if ($dispatchResp.status -eq 500) {
      Write-Warning ("dispatch returned 500 for role={0} task={1}; continuing only if task reaches DONE" -f $role, $taskId)
    }
    if (-not (Wait-WorkflowTaskDone -RunId $RunId -TaskId $taskId -Deadline $deadline)) {
      throw "Task did not reach DONE: $taskId"
    }
  }

  Write-Host "== Build session isolation audit =="
  $auditDir = Join-Path $workspace "docs\e2e"
  Ensure-Dir -Path $auditDir
  $audit = Build-SessionIsolationAudit -RunId $RunId -DpAgentRoot $DpAgentRoot -Roles $roles -PhaseTasks $phaseTasks -Workspace $workspace
  $auditPath = Join-Path $auditDir "dpagent_session_isolation_audit.json"
  $audit | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $auditPath -Encoding UTF8
  $pass = (
    $audit.duplicate_provider_sessions_across_roles.Count -eq 0 -and
    $audit.all_roles_have_exactly_one_provider_session -and
    $audit.all_contexts_have_own_marker -and
    $audit.no_foreign_role_markers -and
    $audit.artifacts_all_markers_present
  )
  Write-Host "audit=$auditPath"
  Write-Host "session_isolation_pass=$pass"
  if (-not $pass) {
    $audit | ConvertTo-Json -Depth 20 | Write-Host
    exit 1
  }
  exit 0
} catch {
  Write-Host ("script_exception_message=" + $_.Exception.Message)
  Write-Host ("script_exception_stack=" + $_.ScriptStackTrace)
  exit 2
} finally {
  if ($previousDpAgentCli) {
    try { Set-DpAgentCliCommand -Command $previousDpAgentCli } catch { Write-Warning ("restore dpagent cliCommand failed: " + $_.Exception.Message) }
  }
  Stop-DpAgentBackendIfStarted -Handle $backendHandle
}
