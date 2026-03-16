param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$ScenarioPath = "",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestWorkflowSpace",
  [int]$AutoDispatchBudget = 30,
  [int]$MaxMinutes = 90,
  [int]$PollSeconds = 5,
  [int]$AutoTopupStep = 30,
  [int]$MaxTopups = 10,
  [int]$MaxTotalBudget = 330,
  [switch]$SetupOnly,
  [bool]$StrictObserve = $true,
  [string]$MiniMaxApiKeyOverride = "",
  [string]$MiniMaxApiBaseOverride = "",
  [switch]$ClearMiniMaxSettings
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $scriptDir "invoke-api.ps1")

if (-not $ScenarioPath) {
  $ScenarioPath = Join-Path $repoRoot "E2ETest\scenarios\workflow-gesture-real-agent.json"
}
if (-not (Test-Path -LiteralPath $ScenarioPath)) {
  throw "Scenario file not found: $ScenarioPath"
}

$scenario = Get-Content -LiteralPath $ScenarioPath -Raw | ConvertFrom-Json
$modelCfg = $scenario.agent_model
$providerIdRaw = if ($modelCfg.provider_id) { [string]$modelCfg.provider_id } else { [string]$modelCfg.tool }
$providerId = $providerIdRaw.Trim().ToLower()
if ([string]::IsNullOrWhiteSpace($providerId)) {
  $providerId = "minimax"
}
if ($providerId -ne "minimax") {
  throw "Workflow E2E requires MiniMax provider. scenario.agent_model.provider_id='$providerId'"
}

$workspace = $WorkspaceRoot
$artifactsBase = Join-Path $workspace "docs\e2e"
$reminderProbe = $scenario.reminder_probe
$skillProbe = $scenario.skill_probe

$roleEntries = @()
$roleByKey = @{}
foreach ($prop in $scenario.roles.PSObject.Properties) {
  $entry = [pscustomobject]@{
    key = [string]$prop.Name
    id = [string]$prop.Value
  }
  $roleEntries += $entry
  $roleByKey[[string]$prop.Name] = [string]$prop.Value
}
$roleList = @($roleEntries | ForEach-Object { $_.id })
$phaseTasks = @($scenario.phase_tasks)
$phaseTaskIds = @($phaseTasks | ForEach-Object { [string]$_.task_id })
$artifactSpecs = @($scenario.artifact_validations)
$codeOutputRequirements = if ($scenario.code_output_requirements) { @($scenario.code_output_requirements) } else { @() }
$reminderProbeTaskId = if ($reminderProbe -and $reminderProbe.probe_task_id) { [string]$reminderProbe.probe_task_id } else { "" }
$reminderGateTaskId = if ($reminderProbe -and $reminderProbe.gate_task_id) { [string]$reminderProbe.gate_task_id } else { "" }
$mainPhaseTasks = @($phaseTasks | Where-Object {
    [string]$_.task_id -ne $reminderProbeTaskId -and
    [string]$_.task_id -ne $reminderGateTaskId
  })
$mainPhaseTaskIds = @($mainPhaseTasks | ForEach-Object { [string]$_.task_id })
if ($mainPhaseTaskIds.Count -eq 0) {
  $mainPhaseTasks = @($phaseTasks)
  $mainPhaseTaskIds = @($phaseTaskIds)
}

$templateId = [string]$scenario.template_id
$workflowName = [string]$scenario.workflow_name
$primaryGoal = [string]$scenario.primary_goal
$rdLeadRole = if ($scenario.roles.rd_lead) { [string]$scenario.roles.rd_lead } else { [string]$roleEntries[0].id }
$rdLeadEntry = @($roleEntries | Where-Object { [string]$_.id -eq $rdLeadRole } | Select-Object -First 1)[0]
$rdLeadRoleKey = if ($rdLeadEntry) { [string]$rdLeadEntry.key } else { "rd_lead" }
$rdLeadWorkflowSessionId = "e2e_gesture_wf_${rdLeadRoleKey}_session"

$runStamp = Get-Date -Format "yyyyMMddHHmmss"
$runId = "e2e_gesture_run_$runStamp"

$script:timings = New-Object System.Collections.Generic.List[object]
$script:warnings = New-Object System.Collections.Generic.List[string]
$script:runtimeSamples = New-Object System.Collections.Generic.List[object]
$script:latestStatus = $null
$script:latestTaskRuntime = $null
$script:latestTaskTree = $null
$script:latestSessions = $null
$script:latestTimeline = $null
$script:runCreateResponse = $null
$script:runStarted = $false
$script:agentChatTranscripts = New-Object System.Collections.Generic.List[object]
$script:workflowRecoveryState = @{}
$script:stabilityFallbackEvents = New-Object System.Collections.Generic.List[object]
$strictMode = [bool]$StrictObserve
$effectiveMiniMaxApiKeyOverride = if ([string]::IsNullOrWhiteSpace($MiniMaxApiKeyOverride)) { [string]$env:E2E_MINIMAX_API_KEY } else { [string]$MiniMaxApiKeyOverride }
$effectiveMiniMaxApiBaseOverride = if ([string]::IsNullOrWhiteSpace($MiniMaxApiBaseOverride)) { [string]$env:E2E_MINIMAX_API_BASE } else { [string]$MiniMaxApiBaseOverride }
$importedSkillId = ""
$skillImportResponse = $null
$skillValidation = [ordered]@{ pass = $false; skipped = $true }
$reminderValidation = [ordered]@{ pass = $false; skipped = $true }

function Add-StabilityFallbackEvent {
  param(
    [string]$Type,
    [string]$Detail
  )
  $script:stabilityFallbackEvents.Add([pscustomobject]@{
      type = $Type
      timestamp = (Get-Date).ToString("o")
      detail = $Detail
    })
}

function Get-StringProp {
  param(
    [object]$Obj,
    [string[]]$Names
  )
  if (-not $Obj) {
    return ""
  }
  foreach ($name in $Names) {
    $p = $Obj.PSObject.Properties[$name]
    if ($p -and $null -ne $p.Value) {
      $v = [string]$p.Value
      if ($v.Trim().Length -gt 0) {
        return $v.Trim()
      }
    }
  }
  return ""
}

function Matches-Prefix {
  param(
    [string]$Value,
    [string[]]$Prefixes
  )
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $false
  }
  foreach ($prefix in $Prefixes) {
    if ($Value.StartsWith($prefix)) {
      return $true
    }
  }
  return $false
}

function Build-AgentPrompt {
  param(
    [string]$RoleKey,
    [string]$RoleId,
    [string]$Goal,
    [string[]]$PhaseIds
  )
  $phaseScope = $PhaseIds -join ", "
  return @(
    "You are role '$RoleId' ($RoleKey) in a workflow E2E run.",
    "Mission goal: $Goal",
    "",
    "Input contract:",
    "- Read workflow task runtime, task tree, and inbox context before acting.",
    "- Respect route_table and dependency constraints.",
    "",
    "Allowed task behaviors:",
    "- TASK_CREATE",
    "- TASK_DISCUSS_REQUEST / TASK_DISCUSS_REPLY / TASK_DISCUSS_CLOSED",
    "- TASK_REPORT",
    "",
    "Subtask creation rules:",
    "- parent_task_id must be one of these high-level phase tasks: $phaseScope",
    "- Each subtask must define title, dependencies, acceptance, and artifacts.",
    "- Never mark downstream tasks/subtasks complete before dependencies are complete.",
    "- Prefer assigning subtasks to yourself or an explicit owner role.",
    "",
    "Output contract:",
    "- Prioritize concrete code artifacts under src/ before supporting docs.",
    "- Produce concrete artifacts in workspace.",
    "- Report completion on the high-level phase task via TASK_REPORT; do not only report subtasks."
  ) -join "`n"
}

function Invoke-TimedApi {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null,
    [int[]]$AllowStatus = @(200, 201)
  )

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $resp = Invoke-ApiJson -BaseUrl $BaseUrl -Method $Method -Path $Path -Body $Body -AllowStatus $AllowStatus
  $sw.Stop()
  $elapsed = [int]$sw.ElapsedMilliseconds

  $script:timings.Add([pscustomobject]@{
      at = (Get-Date).ToString("o")
      method = $Method
      path = $Path
      status = [int]$resp.status
      elapsed_ms = $elapsed
    })

  if ($elapsed -ge 1500) {
    $script:warnings.Add("slow_api: $Method $Path ${elapsed}ms")
  }

  return $resp
}

function Invoke-WorkflowAgentChatTrigger {
  param(
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$SessionId,
    [Parameter(Mandatory = $true)][string]$Prompt,
    [int]$TimeoutSec = 600
  )

  $path = "/api/workflow-runs/$runId/agent-chat"
  $uri = "$BaseUrl$path"
  $payload = @{
    role = $Role
    sessionId = $SessionId
    prompt = $Prompt
  } | ConvertTo-Json -Depth 20

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method POST -ContentType "application/json; charset=utf-8" -Body $payload -TimeoutSec $TimeoutSec
    $sw.Stop()
    $elapsed = [int]$sw.ElapsedMilliseconds
    $status = [int]$resp.StatusCode
    $raw = if ($resp.Content -is [byte[]]) {
      [System.Text.Encoding]::UTF8.GetString($resp.Content)
    } else {
      [string]$resp.Content
    }

    $script:timings.Add([pscustomobject]@{
        at = (Get-Date).ToString("o")
        method = "POST"
        path = $path
        status = $status
        elapsed_ms = $elapsed
      })
    if ($elapsed -ge 1500) {
      $script:warnings.Add("slow_api: POST $path ${elapsed}ms")
    }

    $events = @()
    $currentEvent = ""
    $currentData = @()
    foreach ($line in ($raw -split "`r?`n")) {
      if ([string]::IsNullOrWhiteSpace($line)) {
        if (-not [string]::IsNullOrWhiteSpace($currentEvent) -or $currentData.Count -gt 0) {
          $dataRaw = ($currentData -join "`n").Trim()
          $dataParsed = $null
          if ($dataRaw.Length -gt 0) {
            try { $dataParsed = $dataRaw | ConvertFrom-Json } catch { $dataParsed = $dataRaw }
          }
          $events += [pscustomobject]@{
            event = $currentEvent
            data = $dataParsed
            data_raw = $dataRaw
          }
        }
        $currentEvent = ""
        $currentData = @()
        continue
      }
      if ($line.StartsWith("event:")) {
        $currentEvent = $line.Substring(6).Trim()
        continue
      }
      if ($line.StartsWith("data:")) {
        $currentData += $line.Substring(5).Trim()
        continue
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($currentEvent) -or $currentData.Count -gt 0) {
      $dataRaw = ($currentData -join "`n").Trim()
      $dataParsed = $null
      if ($dataRaw.Length -gt 0) {
        try { $dataParsed = $dataRaw | ConvertFrom-Json } catch { $dataParsed = $dataRaw }
      }
      $events += [pscustomobject]@{
        event = $currentEvent
        data = $dataParsed
        data_raw = $dataRaw
      }
    }

    $errorEvents = @($events | Where-Object { [string]$_.event -eq "error" })
    $hasError = $errorEvents.Count -gt 0

    $record = [pscustomobject]@{
      at = (Get-Date).ToString("o")
      role = $Role
      session_id = $SessionId
      success = (-not $hasError)
      status = $status
      elapsed_ms = $elapsed
      has_error_event = $hasError
      error_events = $errorEvents
      events = $events
      prompt = $Prompt
      raw_sse = $raw
    }
    $script:agentChatTranscripts.Add($record)
    return $record
  } catch {
    $sw.Stop()
    $elapsed = [int]$sw.ElapsedMilliseconds
    $status = 0
    $raw = ""
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $raw = $reader.ReadToEnd()
      $reader.Close()
    } else {
      $raw = $_.Exception.Message
    }

    $script:timings.Add([pscustomobject]@{
        at = (Get-Date).ToString("o")
        method = "POST"
        path = $path
        status = $status
        elapsed_ms = $elapsed
      })
    $script:warnings.Add("agent_chat_trigger_failed: status=$status message=$raw")

    $record = [pscustomobject]@{
      at = (Get-Date).ToString("o")
      role = $Role
      session_id = $SessionId
      success = $false
      status = $status
      elapsed_ms = $elapsed
      has_error_event = $true
      error_events = @()
      events = @()
      prompt = $Prompt
      raw_sse = $raw
    }
    $script:agentChatTranscripts.Add($record)
    return $record
  }
}

function Get-PhaseStates {
  param(
    [object]$TaskRuntime,
    [string[]]$PhaseIds
  )
  $states = [ordered]@{}
  $tasks = if ($TaskRuntime -and $TaskRuntime.tasks) { @($TaskRuntime.tasks) } else { @() }

  foreach ($phaseId in $PhaseIds) {
    $state = "MISSING"
    foreach ($row in $tasks) {
      $tid = Get-StringProp -Obj $row -Names @("taskId", "task_id")
      if ($tid -eq $phaseId) {
        $state = Get-StringProp -Obj $row -Names @("state")
        if ([string]::IsNullOrWhiteSpace($state)) {
          $state = "UNKNOWN"
        }
        break
      }
    }
    $states[$phaseId] = $state
  }

  return $states
}

function Test-PhaseCompletion {
  param(
    [object]$TaskRuntime,
    [string[]]$PhaseIds
  )
  $states = Get-PhaseStates -TaskRuntime $TaskRuntime -PhaseIds $PhaseIds
  $allDone = $true
  foreach ($phaseId in $PhaseIds) {
    if ([string]$states[$phaseId] -ne "DONE") {
      $allDone = $false
      break
    }
  }
  return [pscustomobject]@{
    pass = $allDone
    states = $states
  }
}

function Get-TaskTransitionAt {
  param(
    [object]$TaskRuntimeRow,
    [string]$ToState
  )

  if (-not $TaskRuntimeRow) {
    return $null
  }
  $transitions = if ($TaskRuntimeRow.transitions) { @($TaskRuntimeRow.transitions) } else { @() }
  foreach ($transition in $transitions) {
    $state = Get-StringProp -Obj $transition -Names @("toState", "to_state")
    if ($state -ne $ToState) {
      continue
    }
    $atRaw = Get-StringProp -Obj $transition -Names @("at", "createdAt", "created_at")
    if ([string]::IsNullOrWhiteSpace($atRaw)) {
      continue
    }
    try {
      return [datetime]$atRaw
    } catch {}
  }

  return $null
}

function Get-TaskActivationAt {
  param([object]$TaskRuntimeRow)

  if (-not $TaskRuntimeRow) {
    return $null
  }

  $transitions = if ($TaskRuntimeRow.transitions) { @($TaskRuntimeRow.transitions) } else { @() }
  $activation = $null
  foreach ($transition in $transitions) {
    $state = Get-StringProp -Obj $transition -Names @("toState", "to_state")
    if (@("READY", "DISPATCHED", "DONE") -notcontains $state) {
      continue
    }
    $atRaw = Get-StringProp -Obj $transition -Names @("at", "createdAt", "created_at")
    if ([string]::IsNullOrWhiteSpace($atRaw)) {
      continue
    }
    try {
      $dt = [datetime]$atRaw
      if ($null -eq $activation -or $dt -lt $activation) {
        $activation = $dt
      }
    } catch {}
  }

  return $activation
}

function Build-TaskRuntimeMap {
  param([object]$TaskRuntime)

  $map = @{}
  $tasks = if ($TaskRuntime -and $TaskRuntime.tasks) { @($TaskRuntime.tasks) } else { @() }
  foreach ($row in $tasks) {
    $taskId = Get-StringProp -Obj $row -Names @("taskId", "task_id")
    if ([string]::IsNullOrWhiteSpace($taskId)) {
      continue
    }
    $map[$taskId] = $row
  }

  return $map
}

function Build-WorkflowProcessValidation {
  param(
    [object]$StatusBody,
    [object]$TaskRuntime,
    [object]$SessionsBody,
    [object[]]$MainPhaseTasks
  )

  $runStatus = Get-StringProp -Obj $StatusBody -Names @("status")
  $runFinishedPass = ($runStatus -eq "finished")
  $runtimeById = Build-TaskRuntimeMap -TaskRuntime $TaskRuntime
  $phaseStates = [ordered]@{}
  $phaseDoneTimes = [ordered]@{}
  $dependencyChecks = New-Object System.Collections.Generic.List[object]
  $dependencyViolations = New-Object System.Collections.Generic.List[object]
  $mainPhaseDonePass = $true

  foreach ($phase in $MainPhaseTasks) {
    $phaseId = [string]$phase.task_id
    $row = if ($runtimeById.Contains($phaseId)) { $runtimeById[$phaseId] } else { $null }
    $state = if ($row) { Get-StringProp -Obj $row -Names @("state") } else { "MISSING" }
    if ([string]::IsNullOrWhiteSpace($state)) {
      $state = "UNKNOWN"
    }
    $phaseStates[$phaseId] = $state
    if ($state -ne "DONE") {
      $mainPhaseDonePass = $false
    }

    $phaseDoneAt = Get-TaskTransitionAt -TaskRuntimeRow $row -ToState "DONE"
    $phaseActivationAt = Get-TaskActivationAt -TaskRuntimeRow $row
    $phaseDoneTimes[$phaseId] = if ($phaseDoneAt) { $phaseDoneAt.ToString("o") } else { "" }

    foreach ($depRaw in @($phase.dependencies)) {
      $depId = [string]$depRaw
      if ([string]::IsNullOrWhiteSpace($depId)) {
        continue
      }
      $depRow = if ($runtimeById.Contains($depId)) { $runtimeById[$depId] } else { $null }
      $depDoneAt = Get-TaskTransitionAt -TaskRuntimeRow $depRow -ToState "DONE"
      $depPass = $true
      $reason = ""
      if (-not $depRow) {
        $depPass = $false
        $reason = "dependency_missing"
      } elseif (-not $depDoneAt) {
        $depPass = $false
        $reason = "dependency_not_done"
      } elseif ($phaseActivationAt -and $phaseActivationAt -lt $depDoneAt) {
        $depPass = $false
        $reason = "activated_before_dependency_done"
      } elseif (-not $phaseActivationAt -and $phaseDoneAt -and $phaseDoneAt -lt $depDoneAt) {
        $depPass = $false
        $reason = "completed_before_dependency_done"
      } elseif (-not $phaseActivationAt -and -not $phaseDoneAt) {
        $depPass = $false
        $reason = "phase_activation_missing"
      }

      $record = [pscustomobject]@{
        phase_id = $phaseId
        dependency_phase_id = $depId
        pass = $depPass
        reason = $reason
        phase_state = $state
        phase_activation_at = if ($phaseActivationAt) { $phaseActivationAt.ToString("o") } else { "" }
        phase_done_at = if ($phaseDoneAt) { $phaseDoneAt.ToString("o") } else { "" }
        dependency_done_at = if ($depDoneAt) { $depDoneAt.ToString("o") } else { "" }
      }
      $dependencyChecks.Add($record)
      if (-not $depPass) {
        $dependencyViolations.Add($record)
      }
    }
  }

  $runningSessions = @()
  if ($SessionsBody -and $SessionsBody.items) {
    $runningSessions = @($SessionsBody.items | Where-Object { (Get-StringProp -Obj $_ -Names @("status")) -eq "running" })
  }
  $noRunningSessionsPass = ($runningSessions.Count -eq 0)
  $phaseDependencyOrderPass = ($dependencyViolations.Count -eq 0)

  return [ordered]@{
    pass = ($runFinishedPass -and $mainPhaseDonePass -and $phaseDependencyOrderPass -and $noRunningSessionsPass)
    run_status = $runStatus
    run_finished_pass = $runFinishedPass
    main_phase_done_pass = $mainPhaseDonePass
    phase_dependency_order_pass = $phaseDependencyOrderPass
    no_running_sessions_pass = $noRunningSessionsPass
    running_session_count = $runningSessions.Count
    running_sessions = $runningSessions
    phase_states = $phaseStates
    phase_done_times = $phaseDoneTimes
    dependency_check_count = $dependencyChecks.Count
    dependency_checks = $dependencyChecks.ToArray()
    dependency_violations = $dependencyViolations.ToArray()
  }
}

function Build-TaskTreeNodeMap {
  param([object]$TaskTree)

  $map = @{}
  $nodes = if ($TaskTree -and $TaskTree.nodes) { @($TaskTree.nodes) } else { @() }
  foreach ($node in $nodes) {
    $taskId = Get-StringProp -Obj $node -Names @("taskId", "task_id")
    if ([string]::IsNullOrWhiteSpace($taskId)) {
      continue
    }
    $map[$taskId] = $node
  }

  return $map
}

function Resolve-TaskPhase {
  param(
    [string]$TaskId,
    [hashtable]$NodeById,
    [hashtable]$PhaseSet,
    [hashtable]$Cache,
    [int]$Depth = 0
  )

  if ([string]::IsNullOrWhiteSpace($TaskId)) {
    return ""
  }
  if ($PhaseSet.Contains($TaskId)) {
    return $TaskId
  }
  if ($Cache.Contains($TaskId)) {
    return [string]$Cache[$TaskId]
  }
  if ($Depth -gt 32) {
    return ""
  }
  if (-not $NodeById.Contains($TaskId)) {
    $Cache[$TaskId] = ""
    return ""
  }

  $node = $NodeById[$TaskId]
  $parentTaskId = Get-StringProp -Obj $node -Names @("parentTaskId", "parent_task_id")
  if ([string]::IsNullOrWhiteSpace($parentTaskId)) {
    $Cache[$TaskId] = ""
    return ""
  }

  $resolved = Resolve-TaskPhase -TaskId $parentTaskId -NodeById $NodeById -PhaseSet $PhaseSet -Cache $Cache -Depth ($Depth + 1)
  $Cache[$TaskId] = $resolved
  return $resolved
}

function Build-SubtaskDependencyValidation {
  param(
    [object]$TaskTree,
    [string[]]$MainPhaseIds,
    [System.Collections.IDictionary]$PhaseDoneTimes
  )

  if (-not $PhaseDoneTimes) {
    $PhaseDoneTimes = @{}
  }

  $phaseSet = @{}
  foreach ($phaseId in $MainPhaseIds) {
    $phaseSet[[string]$phaseId] = $true
  }

  $nodeById = Build-TaskTreeNodeMap -TaskTree $TaskTree
  $phaseCache = @{}
  $phaseDoneAtMap = @{}
  foreach ($phaseId in $MainPhaseIds) {
    if (-not $PhaseDoneTimes.Contains($phaseId)) {
      continue
    }
    $raw = [string]$PhaseDoneTimes[$phaseId]
    if ([string]::IsNullOrWhiteSpace($raw)) {
      continue
    }
    try {
      $phaseDoneAtMap[$phaseId] = [datetime]$raw
    } catch {}
  }

  $checks = New-Object System.Collections.Generic.List[object]
  $violations = New-Object System.Collections.Generic.List[object]
  $inspectedSubtaskCount = 0
  foreach ($entry in $nodeById.GetEnumerator()) {
    $taskId = [string]$entry.Key
    $node = $entry.Value
    if ($phaseSet.Contains($taskId)) {
      continue
    }

    $taskPhase = Resolve-TaskPhase -TaskId $taskId -NodeById $nodeById -PhaseSet $phaseSet -Cache $phaseCache
    if ([string]::IsNullOrWhiteSpace($taskPhase) -or -not $phaseSet.Contains($taskPhase)) {
      continue
    }
    $inspectedSubtaskCount += 1

    $runtime = $null
    if ($node.PSObject.Properties.Name -contains "runtime") {
      $runtime = $node.runtime
    }
    $taskActivationAt = Get-TaskActivationAt -TaskRuntimeRow $runtime

    foreach ($depRaw in @($node.dependencies)) {
      $depTaskId = [string]$depRaw
      if ([string]::IsNullOrWhiteSpace($depTaskId)) {
        continue
      }
      $depPhase = Resolve-TaskPhase -TaskId $depTaskId -NodeById $nodeById -PhaseSet $phaseSet -Cache $phaseCache
      if ([string]::IsNullOrWhiteSpace($depPhase) -or $depPhase -eq $taskPhase) {
        continue
      }
      if (-not $phaseSet.Contains($depPhase)) {
        continue
      }

      $depDoneAt = if ($phaseDoneAtMap.Contains($depPhase)) { [datetime]$phaseDoneAtMap[$depPhase] } else { $null }
      $pass = $true
      $reason = ""
      if (-not $depDoneAt) {
        $pass = $false
        $reason = "dependency_phase_done_missing"
      } elseif (-not $taskActivationAt) {
        $pass = $false
        $reason = "task_activation_missing"
      } elseif ($taskActivationAt -lt $depDoneAt) {
        $pass = $false
        $reason = "cross_phase_reverse_order"
      }

      $record = [pscustomobject]@{
        task_id = $taskId
        task_phase = $taskPhase
        dependency_task_id = $depTaskId
        dependency_phase = $depPhase
        pass = $pass
        reason = $reason
        task_activation_at = if ($taskActivationAt) { $taskActivationAt.ToString("o") } else { "" }
        dependency_phase_done_at = if ($depDoneAt) { $depDoneAt.ToString("o") } else { "" }
      }
      $checks.Add($record)
      if (-not $pass) {
        $violations.Add($record)
      }
    }
  }

  return [ordered]@{
    pass = ($violations.Count -eq 0)
    inspected_subtask_count = $inspectedSubtaskCount
    cross_phase_check_count = $checks.Count
    violation_count = $violations.Count
    checks = $checks.ToArray()
    violations = $violations.ToArray()
  }
}

function Build-CodeOutputValidation {
  param(
    [object[]]$Requirements,
    [string]$Workspace
  )

  $srcPath = Join-Path $Workspace "src"
  $srcExists = Test-Path -LiteralPath $srcPath -PathType Container
  $srcFiles = @()
  if ($srcExists) {
    $srcFiles = @(
      Get-ChildItem -Path $srcPath -Recurse -File -ErrorAction SilentlyContinue
    )
  }
  $srcFileCount = @($srcFiles).Count
  $srcPass = $srcExists -and $srcFileCount -gt 0

  $requirementItems = @()
  foreach ($req in @($Requirements)) {
    $relativePath = Get-StringProp -Obj $req -Names @("relative_path", "relativePath")
    if (-not [string]::IsNullOrWhiteSpace($relativePath)) {
      $absolutePath = Join-Path $Workspace $relativePath
      $exists = Test-Path -LiteralPath $absolutePath
      $requirementItems += [pscustomobject]@{
        requirement_type = "relative_path"
        relative_path = $relativePath
        absolute_path = $absolutePath
        exists = $exists
        min_count = 1
        match_count = if ($exists) { 1 } else { 0 }
        pass = $exists
        reason = if ($exists) { "" } else { "path_missing" }
        matched_paths = if ($exists) { @($absolutePath) } else { @() }
      }
      continue
    }

    $dirPattern = Get-StringProp -Obj $req -Names @("dir_pattern", "dirPattern")
    $dirPath = Get-StringProp -Obj $req -Names @("dir_path", "dirPath")
    $filePattern = Get-StringProp -Obj $req -Names @("pattern", "file_pattern", "filePattern")
    if ([string]::IsNullOrWhiteSpace($filePattern)) {
      $filePattern = "*"
    }
    $minCount = 1
    $minRaw = Get-StringProp -Obj $req -Names @("min_count", "minCount")
    if (-not [string]::IsNullOrWhiteSpace($minRaw)) {
      [void][int]::TryParse($minRaw, [ref]$minCount)
      if ($minCount -lt 1) {
        $minCount = 1
      }
    }

    $resolvedPattern = ""
    $matches = @()
    $scanMode = ""
    if (-not [string]::IsNullOrWhiteSpace($dirPattern)) {
      $normalized = $dirPattern.Replace("/", "\")
      if ($normalized.Contains("**")) {
        $parts = $normalized -split "\*\*", 2
        $baseRel = $parts[0].TrimEnd("\")
        $tailPattern = if ($parts.Count -gt 1) { $parts[1].TrimStart("\") } else { "" }
        if ([string]::IsNullOrWhiteSpace($tailPattern)) {
          $tailPattern = $filePattern
        }
        $basePath = if ([string]::IsNullOrWhiteSpace($baseRel)) { $Workspace } else { Join-Path $Workspace $baseRel }
        $resolvedPattern = Join-Path $basePath $tailPattern
        $scanMode = "dir_pattern_globstar"
        if (Test-Path -LiteralPath $basePath) {
          $matches = @(
            Get-ChildItem -Path $basePath -Recurse -File -Filter $tailPattern -ErrorAction SilentlyContinue
          )
        }
      } else {
        $resolvedPattern = Join-Path $Workspace $normalized
        $scanMode = "dir_pattern"
        $matches = @(
          Get-ChildItem -Path $resolvedPattern -File -ErrorAction SilentlyContinue
        )
      }
    } elseif (-not [string]::IsNullOrWhiteSpace($dirPath)) {
      $resolvedDir = Join-Path $Workspace $dirPath
      $resolvedPattern = Join-Path $resolvedDir $filePattern
      $scanMode = "dir_path_pattern"
      if (Test-Path -LiteralPath $resolvedDir) {
        $matches = @(
          Get-ChildItem -Path $resolvedDir -Recurse -File -Filter $filePattern -ErrorAction SilentlyContinue
        )
      }
    } else {
      $requirementItems += [pscustomobject]@{
        requirement_type = "invalid"
        relative_path = ""
        absolute_path = ""
        exists = $false
        min_count = $minCount
        match_count = 0
        pass = $false
        reason = "invalid_requirement"
        matched_paths = @()
      }
      continue
    }

    $count = @($matches).Count
    $pass = ($count -ge $minCount)
    $requirementItems += [pscustomobject]@{
      requirement_type = "dir_pattern"
      dir_pattern = if (-not [string]::IsNullOrWhiteSpace($dirPattern)) { $dirPattern } else { Join-Path $dirPath $filePattern }
      resolved_pattern = $resolvedPattern
      scan_mode = $scanMode
      min_count = $minCount
      match_count = $count
      pass = $pass
      reason = if ($pass) { "" } else { "pattern_match_insufficient" }
      matched_paths = @(@($matches | Select-Object -First 50 -ExpandProperty FullName))
    }
  }

  $requirementFailed = @($requirementItems | Where-Object { -not $_.pass }).Count
  return [ordered]@{
    pass = $srcPass
    skipped = $false
    check_mode = "src_non_empty"
    src_path = $srcPath
    src_exists = $srcExists
    src_file_count = $srcFileCount
    total = 1
    failed = $(if ($srcPass) { 0 } else { 1 })
    items = @(
      [pscustomobject]@{
        requirement_type = "src_non_empty"
        src_path = $srcPath
        src_exists = $srcExists
        src_file_count = $srcFileCount
        pass = $srcPass
        reason = if ($srcPass) { "" } else { "src_empty_or_missing" }
      }
    )
    requirements_telemetry_pass = ($requirementFailed -eq 0)
    requirements_telemetry_total = $requirementItems.Count
    requirements_telemetry_failed = $requirementFailed
    requirements_telemetry_items = $requirementItems
  }
}

function Add-WorkflowSample {
  param([string]$Label)

  $statusResp = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/status" -AllowStatus @(200)
  $taskRuntimeResp = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/task-runtime" -AllowStatus @(200)
  $taskTreeResp = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/task-tree-runtime" -AllowStatus @(200)
  $sessionsResp = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/sessions" -AllowStatus @(200)
  $timelineResp = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/agent-io/timeline?limit=1000" -AllowStatus @(200)

  $script:latestStatus = $statusResp.body
  $script:latestTaskRuntime = $taskRuntimeResp.body
  $script:latestTaskTree = $taskTreeResp.body
  $script:latestSessions = $sessionsResp.body
  $script:latestTimeline = $timelineResp.body

  $timelineTotal = 0
  if ($timelineResp.body -and $timelineResp.body.total -ne $null) {
    $timelineTotal = [int]$timelineResp.body.total
  }

  $sessionsCount = 0
  if ($sessionsResp.body -and $sessionsResp.body.items) {
    $sessionsCount = @($sessionsResp.body.items).Count
  }

  $sample = [pscustomobject]@{
    at = (Get-Date).ToString("o")
    label = $Label
    run_status = (Get-StringProp -Obj $statusResp.body -Names @("status"))
    active = $statusResp.body.active
    counters = $taskRuntimeResp.body.counters
    phase_states = (Get-PhaseStates -TaskRuntime $taskRuntimeResp.body -PhaseIds $phaseTaskIds)
    sessions_count = $sessionsCount
    timeline_total = $timelineTotal
  }

  $script:runtimeSamples.Add($sample)
  return $sample
}

function Resolve-WorkspaceArtifactPath {
  param(
    [string]$Workspace,
    [string]$RelativePath
  )

  $directPath = Join-Path $Workspace $RelativePath
  if (Test-Path -LiteralPath $directPath) {
    return [pscustomobject]@{
      path = $directPath
      exists = $true
      mode = "direct"
    }
  }

  $leaf = Split-Path -Path $RelativePath -Leaf
  if ([string]::IsNullOrWhiteSpace($leaf)) {
    return [pscustomobject]@{
      path = $directPath
      exists = $false
      mode = "missing"
    }
  }

  $relativeSuffix = $RelativePath.Replace("/", "\").TrimStart("\")
  $matches = @(
    Get-ChildItem -Path $Workspace -Recurse -File -Filter $leaf -ErrorAction SilentlyContinue |
      Where-Object {
        $_.FullName.Replace("/", "\").ToLowerInvariant().EndsWith($relativeSuffix.ToLowerInvariant())
      } |
      Sort-Object @{ Expression = { if ($_.FullName -like "*\Agents\*") { 0 } else { 1 } } }, @{ Expression = { $_.FullName.Length } }
  )

  if ($matches.Count -ge 1) {
    return [pscustomobject]@{
      path = $matches[0].FullName
      exists = $true
      mode = "resolved_suffix"
    }
  }

  return [pscustomobject]@{
    path = $directPath
    exists = $false
    mode = "missing"
  }
}

function Invoke-BestEffortWorkflowDispatch {
  param(
    [string]$RunId,
    [hashtable]$Body,
    [string]$Reason
  )

  $resp = Invoke-TimedApi -Method POST -Path "/api/workflow-runs/$RunId/orchestrator/dispatch" -AllowStatus @(200, 500) -Body $Body
  if ([int]$resp.status -ne 200) {
    $detail = ""
    if ($resp.body) {
      try {
        $detail = ($resp.body | ConvertTo-Json -Depth 6 -Compress)
      } catch {
        $detail = [string]$resp.body
      }
    }
    Write-Warning ("workflow dispatch skipped: reason={0} status={1} detail={2}" -f $Reason, [int]$resp.status, $detail)
    return $false
  }

  return $true
}

function Recover-StaleWorkflowSessions {
  param(
    [string]$RunId,
    [object]$SessionsBody
  )

  $recovered = @()
  $items = if ($SessionsBody -and $SessionsBody.items) { @($SessionsBody.items) } else { @() }
  foreach ($item in $items) {
    if ([string]$item.status -ne "running") {
      continue
    }

    $role = [string]$item.role
    if ([string]::IsNullOrWhiteSpace($role)) {
      continue
    }

    $lastActiveRaw = Get-StringProp -Obj $item -Names @("lastActiveAt", "last_active_at")
    if ([string]::IsNullOrWhiteSpace($lastActiveRaw)) {
      continue
    }

    $timeoutStreak = 0
    if ($item.timeoutStreak -ne $null) {
      $timeoutStreak = [int]$item.timeoutStreak
    }

    $lastActive = [datetime]::Parse($lastActiveRaw)
    $staleMinutes = ((Get-Date).ToUniversalTime() - $lastActive.ToUniversalTime()).TotalMinutes
    if ($timeoutStreak -lt 3 -and $staleMinutes -lt 3) {
      continue
    }

    $lastRecoveredAt = if ($script:workflowRecoveryState.Contains($role)) { [datetime]$script:workflowRecoveryState[$role] } else { [datetime]::MinValue }
    if (((Get-Date) - $lastRecoveredAt).TotalSeconds -lt 90) {
      continue
    }

    Write-Warning ("workflow session recovery: role={0} stale_minutes={1:N1} timeout_streak={2}" -f $role, $staleMinutes, $timeoutStreak)
    Add-StabilityFallbackEvent -Type "workflow_recovery" -Detail ("role={0} stale_minutes={1:N1} timeout_streak={2}" -f $role, $staleMinutes, $timeoutStreak)
    Invoke-TimedApi -Method POST -Path "/api/workflow-runs/$RunId/sessions" -AllowStatus @(200, 201) -Body @{ role = $role } | Out-Null
    $null = Invoke-BestEffortWorkflowDispatch -RunId $RunId -Body @{ role = $role; force = $false; only_idle = $false } -Reason ("session_recovery:{0}" -f $role)
    $script:workflowRecoveryState[$role] = Get-Date
    $recovered += $role
  }

  return @($recovered | Select-Object -Unique)
}

function Build-SubtaskStats {
  param(
    [object]$TaskTree,
    [string[]]$PhaseIds
  )

  $phaseSet = @{}
  foreach ($phaseId in $PhaseIds) {
    $phaseSet[$phaseId] = $true
  }

  $nodes = if ($TaskTree -and $TaskTree.nodes) { @($TaskTree.nodes) } else { @() }
  $subtasks = @()
  foreach ($node in $nodes) {
    $taskId = Get-StringProp -Obj $node -Names @("taskId", "task_id")
    $creatorRole = Get-StringProp -Obj $node -Names @("creatorRole", "creator_role")
    if ($phaseSet.Contains($taskId)) {
      continue
    }
    if ([string]::IsNullOrWhiteSpace($creatorRole) -or $creatorRole -eq "manager") {
      continue
    }

    $parentTaskId = Get-StringProp -Obj $node -Names @("parentTaskId", "parent_task_id")
    $ownerRole = Get-StringProp -Obj $node -Names @("ownerRole", "owner_role")
    $subtasks += [pscustomobject]@{
      task_id = $taskId
      parent_task_id = $parentTaskId
      creator_role = $creatorRole
      owner_role = $ownerRole
      parent_is_phase = ($phaseSet.Contains($parentTaskId))
    }
  }

  $creatorRoles = @($subtasks | ForEach-Object { [string]$_.creator_role } | Select-Object -Unique)
  $invalidParents = @($subtasks | Where-Object { -not $_.parent_is_phase })
  $thresholdPass = ($subtasks.Count -ge 3 -and $creatorRoles.Count -ge 3)
  $parentPass = ($invalidParents.Count -eq 0)

  return [ordered]@{
    non_manager_subtask_create_count = $subtasks.Count
    non_manager_subtask_creator_roles = $creatorRoles
    non_manager_subtask_creator_role_count = $creatorRoles.Count
    parent_scope_pass = $parentPass
    threshold_pass = $thresholdPass
    overall_pass = ($thresholdPass -and $parentPass)
    invalid_parent_subtasks = $invalidParents
    inspected_subtasks = $subtasks
  }
}

function Build-ArtifactValidation {
  param(
    [object[]]$Specs,
    [string]$Workspace
  )

  $items = @()
  foreach ($spec in $Specs) {
    $taskId = [string]$spec.task_id
    $relativePath = [string]$spec.path
    $keywords = @($spec.keywords)
    $artifactRef = Resolve-WorkspaceArtifactPath -Workspace $Workspace -RelativePath $relativePath
    $absolutePath = [string]$artifactRef.path
    $exists = [bool]$artifactRef.exists
    $content = if ($exists) { Get-Content -LiteralPath $absolutePath -Raw } else { "" }
    $missingKeywords = @()
    $foundKeywords = @()
    $contentLower = $content.ToLowerInvariant()

    foreach ($kw in $keywords) {
      $kwText = [string]$kw
      if ([string]::IsNullOrWhiteSpace($kwText)) {
        continue
      }
      if ($exists -and $contentLower.Contains($kwText.ToLowerInvariant())) {
        $foundKeywords += $kwText
      } else {
        $missingKeywords += $kwText
      }
    }

    $keywordPass = ($missingKeywords.Count -eq 0)
    $items += [pscustomobject]@{
      task_id = $taskId
      path = $relativePath
      absolute_path = $absolutePath
      resolution_mode = [string]$artifactRef.mode
      exists = $exists
      keyword_pass = $keywordPass
      found_keywords = $foundKeywords
      missing_keywords = $missingKeywords
      pass = ($exists -and $keywordPass)
    }
  }

  return [ordered]@{
    pass = (@($items | Where-Object { -not $_.pass }).Count -eq 0)
    total = $items.Count
    failed = @($items | Where-Object { -not $_.pass }).Count
    items = $items
  }
}

function Save-Json {
  param(
    [string]$Path,
    [object]$Data
  )
  ($Data | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-WorkflowRunEvents {
  param([string]$RunId)
  $path = Join-Path $repoRoot "data\workflows\runs\$RunId\events.jsonl"
  $items = @()
  $raw = ""
  if (Test-Path -LiteralPath $path) {
    $raw = Get-Content -LiteralPath $path -Raw
    foreach ($line in (Get-Content -LiteralPath $path)) {
      $trimmed = $line.Trim()
      if (-not $trimmed) { continue }
      try { $items += ($trimmed | ConvertFrom-Json) } catch {}
    }
  }
  return [pscustomobject]@{
    path = $path
    raw = $raw
    items = $items
  }
}

function Get-WorkflowReminderEvidence {
  param(
    [object[]]$Events,
    [object]$TaskRuntime,
    [string]$ProbeRole,
    [string]$ProbeTaskId
  )

  $triggerEvents = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED" -and
      [string]$_.payload.role -eq $ProbeRole
    })
  $triggerEvents = @($triggerEvents | Sort-Object { [datetime]$_.createdAt })
  $firstTriggerAt = if ($triggerEvents.Count -gt 0) { [datetime]$triggerEvents[0].createdAt } else { $null }
  $dispatchEvents = @($Events | Where-Object {
      $_.eventType -eq "ORCHESTRATOR_DISPATCH_STARTED" -and
      [string]$_.taskId -eq $ProbeTaskId -and
      ($null -eq $firstTriggerAt -or [datetime]$_.createdAt -ge $firstTriggerAt)
    })
  $reportEvents = @($Events | Where-Object {
      $_.eventType -eq "TASK_REPORT_APPLIED" -and
      @([string[]]$_.payload.appliedTaskIds) -contains $ProbeTaskId
    })
  $probeRow = @(@($TaskRuntime.tasks) | Where-Object {
      (Get-StringProp -Obj $_ -Names @("taskId", "task_id")) -eq $ProbeTaskId
    } | Select-Object -First 1)[0]
  $probeState = if ($probeRow) { Get-StringProp -Obj $probeRow -Names @("state") } else { "MISSING" }
  $probeTerminal = @("DONE", "BLOCKED_DEP", "CANCELED") -contains $probeState

  return [ordered]@{
    probe_role = $ProbeRole
    probe_task_id = $ProbeTaskId
    reminder_trigger_count = $triggerEvents.Count
    message_dispatch_count = $dispatchEvents.Count
    report_applied_count = $reportEvents.Count
    probe_state = $probeState
    probe_terminal = $probeTerminal
    trigger_pass = ($triggerEvents.Count -ge 1)
    dispatch_pass = ($dispatchEvents.Count -ge 1)
    progress_pass = ($reportEvents.Count -ge 1 -or $probeTerminal)
    pass = ($triggerEvents.Count -ge 1 -and $dispatchEvents.Count -ge 1 -and ($reportEvents.Count -ge 1 -or $probeTerminal))
    trigger_events = $triggerEvents
    dispatch_events = $dispatchEvents
    report_events = $reportEvents
  }
}

function Wait-ForWorkflowReminderProbe {
  param(
    [string]$ProbeRole,
    [string]$ProbeTaskId,
    [int]$TimeoutMinutes,
    [int]$PollIntervalSeconds
  )

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $manualDispatchIssued = $false
  $trace = New-Object System.Collections.Generic.List[object]

  while ((Get-Date) -lt $deadline) {
    $eventsResp = Get-WorkflowRunEvents -RunId $runId
    $taskRuntimeResp = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/task-runtime" -AllowStatus @(200)
    $sessionsResp = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/sessions" -AllowStatus @(200)
    $evidence = Get-WorkflowReminderEvidence -Events $eventsResp.items -TaskRuntime $taskRuntimeResp.body -ProbeRole $ProbeRole -ProbeTaskId $ProbeTaskId

    $probeSession = @($sessionsResp.body.items | Where-Object { [string]$_.role -eq $ProbeRole } | Select-Object -First 1)[0]
    $trace.Add([pscustomobject]@{
        at = (Get-Date).ToString("o")
        reminder_trigger_count = $evidence.reminder_trigger_count
        message_dispatch_count = $evidence.message_dispatch_count
        report_applied_count = $evidence.report_applied_count
        probe_state = $evidence.probe_state
        probe_terminal = $evidence.probe_terminal
        session_status = if ($probeSession) { [string]$probeSession.status } else { "missing" }
      })

    if ($evidence.trigger_pass -and -not $manualDispatchIssued) {
      Invoke-TimedApi -Method POST -Path "/api/workflow-runs/$runId/orchestrator/dispatch" -AllowStatus @(200) -Body @{
        role = $ProbeRole
        task_id = $ProbeTaskId
        force = $false
        only_idle = $false
      } | Out-Null
      $manualDispatchIssued = $true
    }

    if ($evidence.pass) {
      return [ordered]@{
        pass = $true
        evidence = $evidence
        trace = $trace.ToArray()
        events_path = $eventsResp.path
        events_raw = $eventsResp.raw
      }
    }

    Start-Sleep -Seconds $PollIntervalSeconds
  }

  $eventsFinal = Get-WorkflowRunEvents -RunId $runId
  $taskRuntimeFinal = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/task-runtime" -AllowStatus @(200)
  $finalEvidence = Get-WorkflowReminderEvidence -Events $eventsFinal.items -TaskRuntime $taskRuntimeFinal.body -ProbeRole $ProbeRole -ProbeTaskId $ProbeTaskId
  return [ordered]@{
    pass = $false
    evidence = $finalEvidence
    trace = $trace.ToArray()
    events_path = $eventsFinal.path
    events_raw = $eventsFinal.raw
  }
}

function Build-SkillValidation {
  param(
    [object]$TimelineBody,
    [object]$SkillProbeConfig,
    [string]$SkillId,
    [string]$Workspace
  )

  if (-not $SkillProbeConfig) {
    return [ordered]@{ pass = $true; skipped = $true }
  }

  $items = if ($TimelineBody -and $TimelineBody.items) { @($TimelineBody.items) } else { @() }
  $dispatchRole = [string]$roleByKey[[string]$SkillProbeConfig.dispatch_role_ref]
  $skillItems = @($items | Where-Object {
      ([string]$_.role -eq $dispatchRole) -and
      ([string]$_.content).Contains("requestedSkillIds=") -and
      ([string]$_.content).Contains($SkillId)
    })

  $artifactRef = Resolve-WorkspaceArtifactPath -Workspace $Workspace -RelativePath ([string]$SkillProbeConfig.artifact_path)
  $artifactPath = [string]$artifactRef.path
  $artifactExists = [bool]$artifactRef.exists
  $artifactContent = if ($artifactExists) { Get-Content -LiteralPath $artifactPath -Raw } else { "" }
  $missingMarkers = @()
  foreach ($marker in @($SkillProbeConfig.required_markers)) {
    $markerText = [string]$marker
    if ([string]::IsNullOrWhiteSpace($markerText)) {
      continue
    }
    if (-not $artifactContent.Contains($markerText)) {
      $missingMarkers += $markerText
    }
  }

  return [ordered]@{
    pass = ($skillItems.Count -ge 1 -and $missingMarkers.Count -eq 0)
    skill_id = $SkillId
    dispatch_role = $dispatchRole
    timeline_match_count = $skillItems.Count
    timeline_matches = $skillItems
    artifact_path = $artifactPath
    artifact_resolution_mode = [string]$artifactRef.mode
    artifact_exists = $artifactExists
    missing_markers = $missingMarkers
  }
}

$scriptStart = Get-Date
$pass = $false
$finalReason = "not_started"
$fatalError = $null
$phaseValidation = [ordered]@{ pass = $false; states = @{} }
$processValidation = [ordered]@{
  pass = $false
  run_finished_pass = $false
  main_phase_done_pass = $false
  phase_dependency_order_pass = $false
  no_running_sessions_pass = $false
  running_session_count = 0
}
$subtaskDependencyValidation = [ordered]@{
  pass = $false
  violation_count = 0
}
$codeOutputValidation = [ordered]@{
  pass = $false
  skipped = $true
}
$subtaskStats = [ordered]@{ overall_pass = $false }
$artifactValidation = [ordered]@{ pass = $false; items = @() }

try {
  Write-Host "== Preflight =="
  $health = Invoke-TimedApi -Method GET -Path "/healthz" -AllowStatus @(200)
  if ((Get-StringProp -Obj $health.body -Names @("status")) -ne "ok") {
    $finalReason = "healthz_not_ok"
    throw "healthz is not ok"
  }

  $settings = Invoke-TimedApi -Method GET -Path "/api/settings" -AllowStatus @(200)
  $settingsPatch = @{}
  if ($ClearMiniMaxSettings.IsPresent) {
    $settingsPatch["minimaxApiKey"] = $null
    $settingsPatch["minimaxApiBase"] = $null
  }
  if (-not [string]::IsNullOrWhiteSpace($effectiveMiniMaxApiKeyOverride)) {
    $settingsPatch["minimaxApiKey"] = $effectiveMiniMaxApiKeyOverride.Trim()
  }
  if (-not [string]::IsNullOrWhiteSpace($effectiveMiniMaxApiBaseOverride)) {
    $settingsPatch["minimaxApiBase"] = $effectiveMiniMaxApiBaseOverride.Trim()
  }
  if ($settingsPatch.Keys.Count -gt 0) {
    Write-Host "== Apply MiniMax settings override =="
    Invoke-TimedApi -Method PATCH -Path "/api/settings" -AllowStatus @(200) -Body $settingsPatch | Out-Null
    $settings = Invoke-TimedApi -Method GET -Path "/api/settings" -AllowStatus @(200)
  }

  $minimaxKey = Get-StringProp -Obj $settings.body -Names @("minimaxApiKey", "minimax_api_key")
  if ([string]::IsNullOrWhiteSpace($minimaxKey)) {
    $finalReason = "minimax_not_configured"
  } else {
    Write-Host "== Cleanup by prefix =="
    $runPrefixes = @("e2e_gesture_")
    $templatePrefixes = @("e2e_gesture_")
    $projectPrefixes = @("e2e_gesture_")
    $agentPrefixes = @("e2e_gesture_", "e2e_mgr_")

    $runsResp = Invoke-TimedApi -Method GET -Path "/api/workflow-runs" -AllowStatus @(200)
    foreach ($item in @($runsResp.body.items)) {
      $existingRunId = Get-StringProp -Obj $item -Names @("runId", "run_id")
      if ([string]::IsNullOrWhiteSpace($existingRunId) -or -not (Matches-Prefix -Value $existingRunId -Prefixes $runPrefixes)) {
        continue
      }
      $existingStatus = Get-StringProp -Obj $item -Names @("status")
      if ($existingStatus -eq "running") {
        Invoke-TimedApi -Method POST -Path "/api/workflow-runs/$existingRunId/stop" -AllowStatus @(200, 404, 409) | Out-Null
      }
      Invoke-TimedApi -Method DELETE -Path "/api/workflow-runs/${existingRunId}?force=true" -AllowStatus @(200, 404) | Out-Null
    }

    $tplResp = Invoke-TimedApi -Method GET -Path "/api/workflow-templates" -AllowStatus @(200)
    foreach ($item in @($tplResp.body.items)) {
      $existingTemplateId = Get-StringProp -Obj $item -Names @("templateId", "template_id")
      if ([string]::IsNullOrWhiteSpace($existingTemplateId) -or -not (Matches-Prefix -Value $existingTemplateId -Prefixes $templatePrefixes)) {
        continue
      }
      Invoke-TimedApi -Method DELETE -Path "/api/workflow-templates/$existingTemplateId" -AllowStatus @(200, 404) | Out-Null
    }

    $projectsResp = Invoke-TimedApi -Method GET -Path "/api/projects" -AllowStatus @(200)
    foreach ($item in @($projectsResp.body.items)) {
      $existingProjectId = Get-StringProp -Obj $item -Names @("projectId", "project_id")
      if ([string]::IsNullOrWhiteSpace($existingProjectId) -or -not (Matches-Prefix -Value $existingProjectId -Prefixes $projectPrefixes)) {
        continue
      }
      Invoke-TimedApi -Method DELETE -Path "/api/projects/$existingProjectId" -AllowStatus @(200, 404) | Out-Null
    }

    $agentsResp = Invoke-TimedApi -Method GET -Path "/api/agents" -AllowStatus @(200)
    foreach ($item in @($agentsResp.body.items)) {
      $agentId = Get-StringProp -Obj $item -Names @("agentId", "agent_id")
      if ([string]::IsNullOrWhiteSpace($agentId) -or -not (Matches-Prefix -Value $agentId -Prefixes $agentPrefixes)) {
        continue
      }
      Invoke-TimedApi -Method DELETE -Path "/api/agents/$agentId" -AllowStatus @(200, 404) | Out-Null
    }

    Write-Host "== Reset workspace =="
    Reset-WorkspaceDirectory -WorkspaceRoot $workspace
    Ensure-Dir -Path $workspace

    if ($skillProbe) {
      Write-Host "== Import fixture skill and bind skill list =="
      $fixturePath = Join-Path $repoRoot ([string]$skillProbe.fixture_path)
      if (-not (Test-Path -LiteralPath $fixturePath)) {
        $finalReason = "skill_fixture_missing"
        throw "Skill fixture not found: $fixturePath"
      }

      $skillImportResponse = Invoke-TimedApi -Method POST -Path "/api/skills/import" -AllowStatus @(200) -Body @{
        sources = @($fixturePath)
        recursive = $true
      }
      $imported = @($skillImportResponse.body.imported)
      if ($imported.Count -eq 0) {
        $finalReason = "skill_import_empty"
        throw "No skill imported from fixture: $fixturePath"
      }

      $fixtureFull = [System.IO.Path]::GetFullPath($fixturePath).TrimEnd('\').ToLowerInvariant()
      $selectedImport = $null
      foreach ($item in $imported) {
        $itemSource = [string]$item.skill.sourcePath
        if ([string]::IsNullOrWhiteSpace($itemSource)) { continue }
        $itemFull = [System.IO.Path]::GetFullPath($itemSource).TrimEnd('\').ToLowerInvariant()
        if ($itemFull -eq $fixtureFull) {
          $selectedImport = $item
          break
        }
      }
      if ($null -eq $selectedImport) {
        $selectedImport = $imported[0]
      }
      $importedSkillId = [string]$selectedImport.skill.skillId
      if ([string]::IsNullOrWhiteSpace($importedSkillId)) {
        $finalReason = "skill_import_missing_id"
        throw "Imported skill id is empty."
      }

      $skillListId = [string]$skillProbe.skill_list_id
      $createSkillList = Invoke-TimedApi -Method POST -Path "/api/skill-lists" -AllowStatus @(201, 409) -Body @{
        list_id = $skillListId
        display_name = "Workflow E2E Skill List"
        description = "Baseline workflow skill binding"
        include_all = $false
        skill_ids = @($importedSkillId)
      }
      if ([int]$createSkillList.status -eq 409) {
        Invoke-TimedApi -Method PATCH -Path "/api/skill-lists/$skillListId" -AllowStatus @(200) -Body @{
          display_name = "Workflow E2E Skill List"
          description = "Baseline workflow skill binding"
          include_all = $false
          skill_ids = @($importedSkillId)
        } | Out-Null
      }
    }

    Write-Host "== Register workflow agents =="
    $agentsAfterCleanup = Invoke-TimedApi -Method GET -Path "/api/agents" -AllowStatus @(200)
    $knownAgents = @{}
    foreach ($item in @($agentsAfterCleanup.body.items)) {
      $knownId = Get-StringProp -Obj $item -Names @("agentId", "agent_id")
      if (-not [string]::IsNullOrWhiteSpace($knownId)) {
        $knownAgents[$knownId] = $true
      }
    }

    $skillBindKeys = @()
    if ($skillProbe -and $skillProbe.bind_role_refs) {
      $skillBindKeys = @($skillProbe.bind_role_refs | ForEach-Object { [string]$_ })
    }

    foreach ($entry in $roleEntries) {
      $prompt = Build-AgentPrompt -RoleKey ([string]$entry.key) -RoleId ([string]$entry.id) -Goal $primaryGoal -PhaseIds $mainPhaseTaskIds
      $skillListForAgent = @()
      if ($skillProbe -and $skillBindKeys -contains [string]$entry.key) {
        $skillListForAgent = @([string]$skillProbe.skill_list_id)
      }
      $payload = @{
        agent_id = [string]$entry.id
        display_name = [string]$entry.id
        prompt = $prompt
        summary = "Workflow E2E role $($entry.key)"
        provider_id = $providerId
        default_model_params = @{
          model = [string]$modelCfg.model
          effort = [string]$modelCfg.effort
        }
        model_selection_enabled = $true
        skill_list = $skillListForAgent
      }

      if ($knownAgents.Contains([string]$entry.id)) {
        Invoke-TimedApi -Method PATCH -Path "/api/agents/$($entry.id)" -Body $payload -AllowStatus @(200) | Out-Null
      } else {
        Invoke-TimedApi -Method POST -Path "/api/agents" -Body $payload -AllowStatus @(201) | Out-Null
      }
    }

    Write-Host "== Upsert workflow template =="
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

    $templateBody = @{
      template_id = $templateId
      name = "E2E Gesture Workflow Template"
      description = "High-level phases only. Real agent autonomous subtask creation."
      tasks = $templateTasks
      route_table = $scenario.route_table
      task_assign_route_table = $scenario.task_assign_route_table
      route_discuss_rounds = $scenario.route_discuss_rounds
      default_variables = @{}
    }

    $templateCheck = Invoke-TimedApi -Method GET -Path "/api/workflow-templates/$templateId" -AllowStatus @(200, 404)
    if ([int]$templateCheck.status -eq 200) {
      Invoke-TimedApi -Method PATCH -Path "/api/workflow-templates/$templateId" -AllowStatus @(200) -Body @{
        name = $templateBody.name
        description = $templateBody.description
        tasks = $templateBody.tasks
        route_table = $templateBody.route_table
        task_assign_route_table = $templateBody.task_assign_route_table
        route_discuss_rounds = $templateBody.route_discuss_rounds
      } | Out-Null
    } else {
      Invoke-TimedApi -Method POST -Path "/api/workflow-templates" -AllowStatus @(201) -Body $templateBody | Out-Null
    }

    Write-Host "== Create run with auto_start but auto dispatch paused =="
    $script:runCreateResponse = Invoke-TimedApi -Method POST -Path "/api/workflow-runs" -AllowStatus @(201) -Body @{
      run_id = $runId
      template_id = $templateId
      name = "$workflowName $runStamp"
      description = $primaryGoal
      workspace_path = $workspace
      auto_dispatch_enabled = $false
      auto_dispatch_remaining = 0
      auto_start = $true
    }
    $script:runStarted = $true

    Write-Host "== Register workflow sessions =="
    foreach ($entry in $roleEntries) {
      $workflowSessionId = "e2e_gesture_wf_$($entry.key)_session"
      Invoke-TimedApi -Method POST -Path "/api/workflow-runs/$runId/sessions" -AllowStatus @(200, 201) -Body @{
        role = [string]$entry.id
        session_id = $workflowSessionId
        status = "idle"
        provider_id = $providerId
      } | Out-Null
    }
    $sessionsVerify = Invoke-TimedApi -Method GET -Path "/api/workflow-runs/$runId/sessions" -AllowStatus @(200)
    foreach ($item in @($sessionsVerify.body.items)) {
      $sessionProvider = [string]$item.provider
      if ($sessionProvider.Trim().ToLower() -ne "minimax") {
        $finalReason = "provider_not_minimax"
        throw "Workflow session provider must be minimax. session_id=$($item.sessionId) role=$($item.role) provider=$sessionProvider"
      }
    }

    Invoke-TimedApi -Method PATCH -Path "/api/workflow-runs/$runId/orchestrator/settings" -AllowStatus @(200) -Body @{
      auto_dispatch_enabled = $false
      auto_dispatch_remaining = 0
      reminder_mode = "fixed_interval"
    } | Out-Null

    if ($SetupOnly) {
      Add-WorkflowSample -Label "setup_only_final" | Out-Null
      $pass = $true
      $finalReason = "setup_only"
    } else {
      $probeRole = [string]$roleByKey[[string]$reminderProbe.blocked_role_ref]
      $probeTaskId = $reminderProbeTaskId
      $gateTaskId = $reminderGateTaskId
      if ([string]::IsNullOrWhiteSpace($probeRole)) {
        $finalReason = "reminder_probe_invalid"
        throw "Unknown workflow reminder probe role ref: $($reminderProbe.blocked_role_ref)"
      }

      Write-Host "== Wait for workflow reminder probe =="
      $reminderValidation = Wait-ForWorkflowReminderProbe -ProbeRole $probeRole -ProbeTaskId $probeTaskId -TimeoutMinutes 6 -PollIntervalSeconds ([Math]::Max(5, $PollSeconds))
      if (-not $reminderValidation.pass) {
        $script:warnings.Add("reminder_probe_non_blocking: Workflow reminder probe did not fully converge for task '$probeTaskId'")
        Write-Warning "Reminder probe did not fully converge, continue as non-blocking telemetry."
      }

      Write-Host "== Release reminder gate =="
      Invoke-TimedApi -Method POST -Path "/api/workflow-runs/$runId/task-actions" -AllowStatus @(200, 201) -Body @{
        action_type = "TASK_REPORT"
        from_agent = $rdLeadRole
        from_session_id = $rdLeadWorkflowSessionId
        results = @(
          @{
            task_id = $gateTaskId
            outcome = "DONE"
            summary = "Release main workflow phases after reminder probe observation (non-blocking)."
          }
        )
      } | Out-Null

      Write-Host "== Kickoff message and enable auto dispatch =="
      Invoke-TimedApi -Method POST -Path "/api/workflow-runs/$runId/messages/send" -AllowStatus @(200) -Body @{
        from_agent = "manager"
        from_session_id = "manager-system"
        to_role = $rdLeadRole
        message_type = "MANAGER_MESSAGE"
        task_id = "wf_plan_master"
        request_id = "e2e_gesture_kickoff_$runStamp"
        content = @(
          "Primary goal: $primaryGoal",
          "Please drive the workflow to final delivery with autonomous subtask creation by agents.",
          "Complete phase tasks with TASK_REPORT and produce required artifacts."
        ) -join "`n"
      } | Out-Null

      Invoke-TimedApi -Method PATCH -Path "/api/workflow-runs/$runId/orchestrator/settings" -AllowStatus @(200) -Body @{
        auto_dispatch_enabled = $true
        auto_dispatch_remaining = $AutoDispatchBudget
        reminder_mode = "fixed_interval"
      } | Out-Null

      if (-not $strictMode) {
        Invoke-TimedApi -Method POST -Path "/api/workflow-runs/$runId/orchestrator/dispatch" -AllowStatus @(200) -Body @{
          role = $rdLeadRole
          force = $false
          only_idle = $false
        } | Out-Null

        Write-Host "== Initial agent trigger (single-shot) =="
        $initialPrompt = @(
          "You are $rdLeadRole. Complete workflow run $runId end-to-end in THIS single session.",
          "Goal: $primaryGoal",
          "",
          "Hard requirements (must all be satisfied):",
          "1) Use workflow APIs via AUTO_DEV_MANAGER_URL only, do not just write local docs.",
          "2) Respect dependency order strictly; do not progress downstream tasks before dependencies are DONE.",
          "3) For all high-level phase tasks, submit TASK_REPORT outcome DONE to /api/workflow-runs/$runId/task-actions.",
          "4) Prioritize real code outputs under src/android before supplementary docs.",
          "5) Ensure final delivery phase happens only after quality/release dependencies are complete."
        ) -join "`n"
        $trigger = Invoke-WorkflowAgentChatTrigger -Role $rdLeadRole -SessionId $rdLeadWorkflowSessionId -Prompt $initialPrompt
        if (-not $trigger.success) {
          $pass = $false
          $finalReason = "initial_agent_trigger_failed"
        }
      }

      Write-Host "== Observe run =="
      if ($finalReason -ne "initial_agent_trigger_failed") {
        $finalReason = "timeout"
        $deadline = (Get-Date).AddMinutes($MaxMinutes)
        $observedTerminal = $false
        $noRunningStreak = 0

        while ((Get-Date) -lt $deadline) {
          Add-WorkflowSample -Label "poll" | Out-Null

          $runStatus = Get-StringProp -Obj $script:latestStatus -Names @("status")
          $runningSessions = @()
          if ($script:latestSessions -and $script:latestSessions.items) {
            $runningSessions = @($script:latestSessions.items | Where-Object { [string]$_.status -eq "running" })
          }

          if ($runStatus -eq "failed") {
            $finalReason = "workflow_run_failed"
            $observedTerminal = $true
            break
          }

          if ($runStatus -eq "finished") {
            $pass = $true
            $finalReason = "workflow_runtime_ok"
            $observedTerminal = $true
            break
          }

          $recoveredRoles = Recover-StaleWorkflowSessions -RunId $runId -SessionsBody $script:latestSessions
          if ($recoveredRoles.Count -gt 0) {
            Write-Host ("workflow recovered stale sessions: {0}" -f ($recoveredRoles -join ","))
            Start-Sleep -Seconds $PollSeconds
            continue
          }

          if ($runningSessions.Count -eq 0) {
            $noRunningStreak += 1
          } else {
            $noRunningStreak = 0
          }

          if ($noRunningStreak -ge 6) {
            $nudgeOk = Invoke-BestEffortWorkflowDispatch -RunId $runId -Body @{ force = $false; only_idle = $false } -Reason ("idle_streak:{0}" -f $noRunningStreak)
            Add-StabilityFallbackEvent -Type "dispatch_nudge" -Detail ("reason=idle_streak streak={0} success={1}" -f $noRunningStreak, $nudgeOk)
            Write-Host ("workflow dispatch nudge attempted after idle streak={0} success={1}" -f $noRunningStreak, $nudgeOk)
            $noRunningStreak = 0
            Start-Sleep -Seconds $PollSeconds
            continue
          }

          Start-Sleep -Seconds $PollSeconds
        }

        if (-not $observedTerminal) {
          $pass = $false
        }
      }
    }
  }
} catch {
  $fatalError = $_
  $pass = $false
  if ($finalReason -eq "not_started") {
    $finalReason = "script_exception"
  }
  $script:warnings.Add("exception: $($_.Exception.Message)")
}

if ($script:runStarted -and -not $SetupOnly) {
  try {
    Add-WorkflowSample -Label "final" | Out-Null
  } catch {
    $script:warnings.Add("final_sample_failed: $($_.Exception.Message)")
  }
}

if ($script:latestTaskRuntime) {
  $phaseValidation = Test-PhaseCompletion -TaskRuntime $script:latestTaskRuntime -PhaseIds $phaseTaskIds
}
if ($script:latestStatus -and $script:latestTaskRuntime -and $script:latestSessions) {
  $processValidation = Build-WorkflowProcessValidation -StatusBody $script:latestStatus -TaskRuntime $script:latestTaskRuntime -SessionsBody $script:latestSessions -MainPhaseTasks $mainPhaseTasks
}
if ($script:latestTaskTree) {
  $subtaskStats = Build-SubtaskStats -TaskTree $script:latestTaskTree -PhaseIds $phaseTaskIds
  $subtaskDependencyValidation = Build-SubtaskDependencyValidation -TaskTree $script:latestTaskTree -MainPhaseIds $mainPhaseTaskIds -PhaseDoneTimes $processValidation.phase_done_times
}
$codeOutputValidation = Build-CodeOutputValidation -Requirements $codeOutputRequirements -Workspace $workspace
$artifactValidation = Build-ArtifactValidation -Specs $artifactSpecs -Workspace $workspace
if ($script:latestTimeline -and $skillProbe -and -not [string]::IsNullOrWhiteSpace($importedSkillId)) {
  $skillValidation = Build-SkillValidation -TimelineBody $script:latestTimeline -SkillProbeConfig $skillProbe -SkillId $importedSkillId -Workspace $workspace
}
if (-not $skillProbe) {
  $skillValidation = [ordered]@{ pass = $true; skipped = $true }
}
if ($SetupOnly) {
  $reminderValidation = [ordered]@{ pass = $false; skipped = $true; reason = "setup_only" }
  $processValidation = [ordered]@{
    pass = $true
    skipped = $true
    run_finished_pass = $false
    main_phase_done_pass = $false
    phase_dependency_order_pass = $false
    no_running_sessions_pass = $false
    running_session_count = 0
    phase_done_times = @{}
  }
  $subtaskDependencyValidation = [ordered]@{ pass = $true; skipped = $true; violation_count = 0; checks = @(); violations = @() }
  $codeOutputValidation = [ordered]@{ pass = $true; skipped = $true; total = 0; failed = 0; items = @() }
}

if (-not $SetupOnly -and $finalReason -eq "workflow_runtime_ok") {
  if (-not $processValidation.run_finished_pass) {
    $pass = $false
    $finalReason = "run_not_finished"
  } elseif (-not $processValidation.main_phase_done_pass) {
    $pass = $false
    $finalReason = "main_phase_not_done"
  } elseif (-not $processValidation.phase_dependency_order_pass) {
    $pass = $false
    $finalReason = "phase_dependency_order_invalid"
  } elseif (-not $processValidation.no_running_sessions_pass) {
    $pass = $false
    $finalReason = "running_sessions_remaining"
  } elseif (-not $codeOutputValidation.pass) {
    $pass = $false
    $finalReason = "code_output_missing"
  } elseif (-not $subtaskDependencyValidation.pass) {
    $pass = $false
    $finalReason = "subtask_dependency_order_invalid"
  } else {
    $pass = $true
    $finalReason = "workflow_runtime_ok"
  }
}

if ($finalReason -eq "minimax_not_configured") {
  $pass = $false
}

$reviewRequired = ($script:warnings.Count -gt 0)
Ensure-Dir -Path $workspace
Ensure-Dir -Path $artifactsBase
$stampOut = Get-Date -Format "yyyyMMdd_HHmmss"
$outDir = Join-Path $artifactsBase "$stampOut-workflow-observer"
Ensure-Dir -Path $outDir

$transcriptDir = Join-Path $outDir "agent_chat_transcripts"
Ensure-Dir -Path $transcriptDir
$triggerCount = $script:agentChatTranscripts.Count
if ($triggerCount -gt 0) {
  Write-Utf8NoBom -Path (Join-Path $transcriptDir "README.md") -Content (@(
    "# Agent Chat Transcripts",
    "",
    "This run used single-shot trigger mode for non-strict observe.",
    "trigger_count: $triggerCount"
  ) -join "`n")
} else {
  Write-Utf8NoBom -Path (Join-Path $transcriptDir "README.md") -Content (@(
    "# Agent Chat Transcripts",
    "",
    "No agent-chat trigger was executed in this run."
  ) -join "`n")
}

$triggerIndex = 0
foreach ($item in $script:agentChatTranscripts.ToArray()) {
  $triggerIndex += 1
  $safeRole = ([string]$item.role) -replace "[^a-zA-Z0-9._-]+", "_"
  $prefix = "{0:D2}_{1}" -f $triggerIndex, $safeRole
  Save-Json -Path (Join-Path $transcriptDir "$prefix.transcript.json") -Data $item
  Write-Utf8NoBom -Path (Join-Path $transcriptDir "$prefix.raw.sse.txt") -Content ([string]$item.raw_sse)
}

if ($script:runCreateResponse) {
  Save-Json -Path (Join-Path $outDir "workflow_run_created_response.json") -Data $script:runCreateResponse.body
}
if ($script:latestStatus) {
  Save-Json -Path (Join-Path $outDir "workflow_run_status.json") -Data $script:latestStatus
}
if ($script:latestTaskRuntime) {
  Save-Json -Path (Join-Path $outDir "workflow_task_runtime.json") -Data $script:latestTaskRuntime
}
if ($script:latestTaskTree) {
  Save-Json -Path (Join-Path $outDir "workflow_task_tree_runtime.json") -Data $script:latestTaskTree
}
if ($script:latestSessions) {
  Save-Json -Path (Join-Path $outDir "workflow_sessions.json") -Data $script:latestSessions
}
if ($script:latestTimeline) {
  Save-Json -Path (Join-Path $outDir "workflow_timeline.json") -Data $script:latestTimeline
}
if ($skillImportResponse) {
  Save-Json -Path (Join-Path $outDir "workflow_skill_import.json") -Data $skillImportResponse.body
}

Save-Json -Path (Join-Path $outDir "workflow_timing_timeline.json") -Data $script:timings.ToArray()
Save-Json -Path (Join-Path $outDir "workflow_step_runtime_samples.json") -Data $script:runtimeSamples.ToArray()
Save-Json -Path (Join-Path $outDir "workflow_artifact_validation.json") -Data $artifactValidation
Save-Json -Path (Join-Path $outDir "workflow_agent_subtask_stats.json") -Data $subtaskStats
Save-Json -Path (Join-Path $outDir "workflow_phase_validation.json") -Data $phaseValidation
Save-Json -Path (Join-Path $outDir "workflow_process_validation.json") -Data $processValidation
Save-Json -Path (Join-Path $outDir "workflow_subtask_dependency_validation.json") -Data $subtaskDependencyValidation
Save-Json -Path (Join-Path $outDir "workflow_code_output_validation.json") -Data $codeOutputValidation
Save-Json -Path (Join-Path $outDir "workflow_reminder_probe.json") -Data $reminderValidation
Save-Json -Path (Join-Path $outDir "workflow_skill_validation.json") -Data $skillValidation
$eventsSnapshot = Get-WorkflowRunEvents -RunId $runId
if ($eventsSnapshot.raw.Length -gt 0) {
  Write-Utf8NoBom -Path (Join-Path $outDir "workflow_events.jsonl") -Content $eventsSnapshot.raw
}

$toolFailedTimestamps = @(
  @($eventsSnapshot.items | Where-Object {
      [string]$_.eventType -eq "TEAM_TOOL_FAILED" -or
      [string]$_.eventType -eq "TOOL_CALL_FAILED" -or
      [string]$_.eventType -eq "TOOLCALL_FAILED"
    }) | ForEach-Object { [string]$_.createdAt }
)
$timeoutRecoveredTimestamps = @()
if ($pass) {
  $timeoutRecoveredTimestamps = @($script:stabilityFallbackEvents.ToArray() | ForEach-Object { [string]$_.timestamp })
}
$stabilityMetrics = [ordered]@{
  case_id = "workflow"
  start_time = $scriptStart.ToString("o")
  end_time = (Get-Date).ToString("o")
  exit_code = $(if ($pass) { 0 } else { 2 })
  final_pass = $pass
  final_reason = $finalReason
  toolcall_failed_count = @($toolFailedTimestamps).Count
  toolcall_failed_timestamps = @($toolFailedTimestamps)
  timeout_recovered_count = @($timeoutRecoveredTimestamps).Count
  timeout_recovered_timestamps = @($timeoutRecoveredTimestamps)
  fallback_events = @($script:stabilityFallbackEvents.ToArray())
}
Save-Json -Path (Join-Path $outDir "stability_metrics.json") -Data $stabilityMetrics
if ($script:warnings.Count -gt 0) {
  Save-Json -Path (Join-Path $outDir "warnings.json") -Data $script:warnings.ToArray()
}
if ($fatalError) {
  Write-Utf8NoBom -Path (Join-Path $outDir "fatal_error.txt") -Content ([string]$fatalError.Exception)
}

$totalElapsedMs = [int]((Get-Date) - $scriptStart).TotalMilliseconds
$subtaskCount = if ($subtaskStats.non_manager_subtask_create_count -ne $null) { [int]$subtaskStats.non_manager_subtask_create_count } else { 0 }
$subtaskRoleCount = if ($subtaskStats.non_manager_subtask_creator_role_count -ne $null) { [int]$subtaskStats.non_manager_subtask_creator_role_count } else { 0 }
$subtaskRolesText = if ($subtaskStats.non_manager_subtask_creator_roles) { (@($subtaskStats.non_manager_subtask_creator_roles) -join ",") } else { "" }

$summary = @()
$summary += "# Workflow E2E Summary"
$summary += ""
$summary += "- scenario: $($scenario.scenario_id)"
$summary += "- workspace: $workspace"
$summary += "- setup_only: $($SetupOnly.IsPresent)"
$summary += "- strict_observe: $strictMode"
$summary += "- run_id: $runId"
$summary += "- template_id: $templateId"
$summary += "- final_reason: $finalReason"
$summary += "- runtime_pass: $pass"
$summary += "- process_validation_pass: $($processValidation.pass)"
$summary += "- run_finished_pass: $($processValidation.run_finished_pass)"
$summary += "- main_phase_done_pass: $($processValidation.main_phase_done_pass)"
$summary += "- phase_dependency_order_pass: $($processValidation.phase_dependency_order_pass)"
$summary += "- no_running_sessions_pass: $($processValidation.no_running_sessions_pass)"
$summary += "- running_session_count: $($processValidation.running_session_count)"
$summary += "- code_output_validation_pass: $($codeOutputValidation.pass)"
$summary += "- code_output_failed_count: $($codeOutputValidation.failed)"
$summary += "- subtask_dependency_validation_pass: $($subtaskDependencyValidation.pass)"
$summary += "- subtask_dependency_violation_count: $($subtaskDependencyValidation.violation_count)"
$summary += "- reminder_probe_pass: $($reminderValidation.pass)"
$summary += "- reminder_probe_non_blocking: true"
$summary += "- skill_probe_pass: $($skillValidation.pass)"
$summary += "- skill_probe_non_blocking: true"
$summary += "- imported_skill_id: $importedSkillId"
$summary += "- artifact_validation_pass (telemetry_only): $($artifactValidation.pass)"
$summary += "- subtask_stats_overall_pass (telemetry_only): $($subtaskStats.overall_pass)"
$summary += "- review_required: $reviewRequired"
$summary += "- initial_agent_trigger_count: $triggerCount"
$summary += "- max_minutes: $MaxMinutes"
$summary += "- poll_seconds: $PollSeconds"
$summary += "- total_elapsed_ms: $totalElapsedMs"
$summary += "- non_manager_subtask_create_count: $subtaskCount"
$summary += "- non_manager_subtask_creator_role_count: $subtaskRoleCount"
$summary += "- non_manager_subtask_creator_roles: $subtaskRolesText"
$summary += "- slow_warning_count: $($script:warnings.Count)"
$summary += "- toolcall_failed_count: $(@($toolFailedTimestamps).Count)"
$summary += "- timeout_recovered_count: $(@($timeoutRecoveredTimestamps).Count)"
$summary += "- artifacts_dir: $outDir"

Write-Utf8NoBom -Path (Join-Path $outDir "run_summary.md") -Content ($summary -join "`n")

Write-Host "== Done =="
Write-Host "artifacts=$outDir"
Write-Host "final_reason=$finalReason"
Write-Host "runtime_pass=$pass"
Write-Host "review_required=$reviewRequired"
Write-Host "total_elapsed_ms=$totalElapsedMs"

if (-not $pass) {
  exit 2
}

