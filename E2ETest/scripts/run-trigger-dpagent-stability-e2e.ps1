param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$DpAgentUrl = "http://127.0.0.1:53721",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TriggerDPAgentStability",
  [string]$PluginPath = "",
  [string]$TriggerId = "e2e_hello_30s_dpagent",
  [string]$TemplateId = "e2e_trigger_hello_template_v1",
  [string]$Role = "trigger_dpagent_worker",
  [string]$DpAgentCliCommand = "",
  [int]$RequiredFires = 5,
  [int]$IntervalSeconds = 30,
  [ValidateSet("fresh", "reuse_provider_session")]
  [string]$SessionMode = "fresh",
  [int]$AllowedInFlightFires = 0,
  [int]$DrainInFlightMinutes = 8,
  [int]$MaxMinutes = 30,
  [int]$PollSeconds = 5
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
. (Join-Path $scriptDir "invoke-api.ps1")
. (Join-Path $repoRoot "tools\e2e-backend-bootstrap.ps1")

if ([string]::IsNullOrWhiteSpace($PluginPath)) {
  $PluginPath = Join-Path $repoRoot "E2ETest\fixtures\trigger-plugins\hello-30s"
}
if ([string]::IsNullOrWhiteSpace($DpAgentCliCommand)) {
  $DpAgentCliCommand = Join-Path $scriptDir "dpagent-dev-wrapper.cmd"
}

$taskId = "say_hello"
$backendHandle = $null
$oldDpAgentCliCommand = $null
$shouldRestoreSettings = $false
$triggerCreated = $false

function Test-DpAgentBackendReady {
  param([string]$Url)
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/auth/status" -Method Get -TimeoutSec 5
    return ([int]$resp.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-OptionalProperty {
  param(
    [object]$Object,
    [string]$Name
  )
  if ($null -eq $Object) {
    return $null
  }
  if ($Object.PSObject.Properties[$Name]) {
    return $Object.PSObject.Properties[$Name].Value
  }
  return $null
}

function Get-RunValidation {
  param(
    [string]$BaseUrl,
    [string]$RunId,
    [string]$WorkspaceRoot,
    [string]$Role,
    [string]$SessionMode
  )
  $runResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$RunId" -AllowStatus @(200, 404)
  if ([int]$runResp.status -ne 200) {
    return [pscustomobject]@{ ok = $false; reason = "run_not_found"; run_id = $RunId }
  }
  $run = $runResp.body
  $sequence = [string](Get-OptionalProperty -Object $run.variables -Name "sequence")
  $marker = [string](Get-OptionalProperty -Object $run.variables -Name "marker")
  $artifactFile = if ([string]::IsNullOrWhiteSpace($sequence)) {
    ""
  } else {
    Join-Path $WorkspaceRoot ("docs\e2e\trigger_stability_{0}.md" -f $sequence)
  }
  $artifactContent = if ($artifactFile -and (Test-Path -LiteralPath $artifactFile)) {
    Get-Content -LiteralPath $artifactFile -Raw
  } else {
    ""
  }
  $sessionsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$RunId/sessions" -AllowStatus @(200)
  $session = @($sessionsResp.body.items | Where-Object { [string]$_.role -eq $Role } | Select-Object -First 1)[0]
  $sessionProvider = if ($session) { [string]$session.provider } else { "" }
  $sessionProviderSessionId = if ($session) { [string](Get-OptionalProperty -Object $session -Name "providerSessionId") } else { "" }
  $providerSessionOk = ($SessionMode -ne "reuse_provider_session" -or -not [string]::IsNullOrWhiteSpace($sessionProviderSessionId))
  $ok = (
    [string]$run.status -eq "finished" -and
    $sessionProvider -eq "dpagent" -and
    $providerSessionOk -and
    -not [string]::IsNullOrWhiteSpace($marker) -and
    $artifactContent.Contains($marker)
  )
  return [pscustomobject]@{
    ok = $ok
    reason = if ($ok) { "ok" } else { "not_finished_or_missing_artifact" }
    run_id = $RunId
    run_status = [string]$run.status
    sequence = $sequence
    marker = $marker
    session_provider = $sessionProvider
    provider_session_id = $sessionProviderSessionId
    artifact_file = $artifactFile
    artifact_contains_marker = (-not [string]::IsNullOrWhiteSpace($marker) -and $artifactContent.Contains($marker))
  }
}

function Select-CurrentEvidenceHistory {
  param(
    [object[]]$Items,
    [datetime]$StartedAt
  )
  return @($Items | Where-Object {
      $rawStartedAt = [string]$_.startedAt
      if ([string]::IsNullOrWhiteSpace($rawStartedAt)) {
        $true
      } else {
        try {
          [datetime]::Parse($rawStartedAt) -ge $StartedAt
        } catch {
          $true
        }
      }
    })
}

function Update-ValidTriggerRuns {
  param(
    [object[]]$HistoryItems,
    [hashtable]$ValidRuns,
    [string]$BaseUrl,
    [string]$WorkspaceRoot,
    [string]$Role,
    [string]$SessionMode
  )
  $completedItems = @($HistoryItems | Where-Object { [string]$_.status -eq "completed" -and -not [string]::IsNullOrWhiteSpace([string]$_.workflowRunId) })
  foreach ($item in $completedItems) {
    $runId = [string]$item.workflowRunId
    if ($ValidRuns.ContainsKey($runId)) {
      continue
    }
    $validation = Get-RunValidation -BaseUrl $BaseUrl -RunId $runId -WorkspaceRoot $WorkspaceRoot -Role $Role -SessionMode $SessionMode
    if ($validation.ok) {
      $ValidRuns[$runId] = $validation
    }
  }
  return $completedItems
}

function Get-ExpectedReuseProviderSessionId {
  param([hashtable]$ValidRuns)
  $ids = @(
    $ValidRuns.Values |
      ForEach-Object { [string]$_.provider_session_id } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Select-Object -Unique
  )
  if ($ids.Count -eq 1) {
    return [string]$ids[0]
  }
  return ""
}

function Update-ReuseInjectionEvidence {
  param(
    [object[]]$HistoryItems,
    [hashtable]$Evidence,
    [hashtable]$ValidRuns,
    [string]$BaseUrl,
    [string]$TriggerId,
    [string]$TemplateId,
    [string]$Role,
    [string]$SessionMode
  )
  if ($SessionMode -ne "reuse_provider_session") {
    return
  }
  $expectedProviderSessionId = Get-ExpectedReuseProviderSessionId -ValidRuns $ValidRuns
  if ([string]::IsNullOrWhiteSpace($expectedProviderSessionId)) {
    return
  }
  $bindingResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/triggers/$TriggerId/session-bindings" -AllowStatus @(200, 404)
  if ([int]$bindingResp.status -ne 200) {
    return
  }
  $roleBinding = @($bindingResp.body.items | Where-Object {
      [string]$_.role -eq $Role -and
      [string]$_.provider -eq "dpagent" -and
      [string]$_.workflowTemplateId -eq $TemplateId
    } | Select-Object -First 1)[0]
  if (-not $roleBinding) {
    return
  }
  $bindingProviderSessionId = [string](Get-OptionalProperty -Object $roleBinding -Name "providerSessionId")
  $activeWorkflowRunId = [string](Get-OptionalProperty -Object $roleBinding -Name "activeWorkflowRunId")
  if ($bindingProviderSessionId -ne $expectedProviderSessionId -or [string]::IsNullOrWhiteSpace($activeWorkflowRunId)) {
    return
  }
  $activeHistory = @($HistoryItems | Where-Object {
      [string]$_.workflowRunId -eq $activeWorkflowRunId -and
      [string]$_.status -eq "fired"
    })
  if ($activeHistory.Count -eq 0 -or $Evidence.ContainsKey($activeWorkflowRunId)) {
    return
  }
  $sessionsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$activeWorkflowRunId/sessions" -AllowStatus @(200, 404)
  if ([int]$sessionsResp.status -ne 200) {
    return
  }
  $session = @($sessionsResp.body.items | Where-Object { [string]$_.role -eq $Role } | Select-Object -First 1)[0]
  $sessionProviderSessionId = if ($session) { [string](Get-OptionalProperty -Object $session -Name "providerSessionId") } else { "" }
  if ($sessionProviderSessionId -ne $expectedProviderSessionId) {
    return
  }
  $Evidence[$activeWorkflowRunId] = [pscustomobject]@{
    run_id = $activeWorkflowRunId
    provider_session_id = $sessionProviderSessionId
    binding_id = [string](Get-OptionalProperty -Object $roleBinding -Name "bindingId")
    captured_at = (Get-Date).ToString("o")
  }
}

try {
  Write-Host "== Preflight =="
  if (-not (Test-DpAgentBackendReady -Url $DpAgentUrl)) {
    throw "DPAgent backend is not reachable at $DpAgentUrl/api/auth/status"
  }
  if (-not (Test-Path -LiteralPath $PluginPath)) {
    throw "PluginPath not found: $PluginPath"
  }
  if (-not (Test-Path -LiteralPath $DpAgentCliCommand)) {
    throw "DpAgentCliCommand not found: $DpAgentCliCommand"
  }

  $backendHandle = Ensure-E2EBackend -BaseUrl $BaseUrl -RepoRoot $repoRoot -BootstrapLabel "trigger-dpagent-stability" -TimeoutSeconds 90
  $health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz" -AllowStatus @(200)
  if ([string]$health.body.status -ne "ok") {
    throw "EAT backend healthz is not ok"
  }

  Write-Host "== Configure DPAgent provider CLI =="
  $settings = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/settings" -AllowStatus @(200)
  $oldDpAgentCliCommand = [string](Get-OptionalProperty -Object $settings.body.providers.dpagent -Name "cliCommand")
  $shouldRestoreSettings = $true
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/settings" -AllowStatus @(200) -Body @{
    providers = @{
      dpagent = @{
        cliCommand = $DpAgentCliCommand
      }
    }
  } | Out-Null

  Write-Host "== Reset trigger, template, and workspace =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/triggers/$TriggerId" -AllowStatus @(200, 404) -Body @{
    enabled = $false
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/triggers/$TriggerId" -AllowStatus @(200, 404) | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/workflow-templates/$TemplateId" -AllowStatus @(200, 404) | Out-Null
  Reset-WorkspaceDirectory -WorkspaceRoot $WorkspaceRoot
  Ensure-Dir -Path $WorkspaceRoot

  Write-Host "== Upsert DPAgent trigger worker agent =="
  $agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents" -AllowStatus @(200)
  $knownAgent = @($agentList.body.items | Where-Object { [string]$_.agentId -eq $Role }).Count -gt 0
  $agentPrompt = "You are the DPAgent trigger stability worker. Complete only the active workflow phase. Create the requested marker file, then use TeamTool task_report_done. Do not create extra workflow tasks or discussions."
  if ($knownAgent) {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$Role" -AllowStatus @(200) -Body @{
      display_name = $Role
      prompt = $agentPrompt
      provider_id = "dpagent"
      default_model_params = @{ model = "dpagent-config"; effort = "medium" }
      model_selection_enabled = $true
    } | Out-Null
  } else {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -AllowStatus @(201) -Body @{
      agent_id = $Role
      display_name = $Role
      prompt = $agentPrompt
      provider_id = "dpagent"
      default_model_params = @{ model = "dpagent-config"; effort = "medium" }
      model_selection_enabled = $true
    } | Out-Null
  }

  Write-Host "== Create workflow template =="
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-templates" -AllowStatus @(201) -Body @{
    template_id = $TemplateId
    name = "E2E Trigger DPAgent Hello Template"
    description = "Single-task workflow used by Trigger Runtime DPAgent stability validation."
    tasks = @(@{
      task_id = $taskId
      title = "Trigger hello placeholder"
      owner_role = $Role
      dependencies = @()
      acceptance = @("Create the requested docs/e2e marker file and report the active task DONE.")
      artifacts = @("docs/e2e/trigger_stability_<sequence>.md")
    })
    route_table = @{ $Role = @() }
    task_assign_route_table = @{ $Role = @() }
    route_discuss_rounds = @{ $Role = @{} }
    default_variables = @{ message = "hello"; sequence = "0"; marker = "TRIGGER_HELLO_DONE_0" }
  } | Out-Null

  Write-Host "== Import plugin and create trigger =="
  $evidenceStartedAt = (Get-Date).AddSeconds(-2)
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/trigger-plugins/import" -AllowStatus @(200) -Body @{
    source = $PluginPath
  } | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/triggers" -AllowStatus @(201) -Body @{
    trigger_id = $TriggerId
    plugin_id = "e2e-hello-30s-trigger"
    enabled = $true
    interval_seconds = $IntervalSeconds
    workflow_template_id = $TemplateId
    workspace_path = $WorkspaceRoot
    default_variables = @{ message = "hello" }
    hook_timeout_ms = 5000
    session_mode = $SessionMode
  } | Out-Null
  $triggerCreated = $true

  Write-Host ("== Wait for {0} completed trigger fires ==" -f $RequiredFires)
  $deadline = (Get-Date).AddMinutes($MaxMinutes)
  $validRuns = @{}
  $reuseInjectionEvidence = @{}
  $lastHistory = @()
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    $historyResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/triggers/$TriggerId/runs" -AllowStatus @(200)
    $lastHistory = @(Select-CurrentEvidenceHistory -Items @($historyResp.body.items) -StartedAt $evidenceStartedAt)
    $completedItems = @(Update-ValidTriggerRuns -HistoryItems $lastHistory -ValidRuns $validRuns -BaseUrl $BaseUrl -WorkspaceRoot $WorkspaceRoot -Role $Role -SessionMode $SessionMode)
    Update-ReuseInjectionEvidence -HistoryItems $lastHistory -Evidence $reuseInjectionEvidence -ValidRuns $validRuns -BaseUrl $BaseUrl -TriggerId $TriggerId -TemplateId $TemplateId -Role $Role -SessionMode $SessionMode
    $failedCount = @($lastHistory | Where-Object { [string]$_.status -eq "failed" }).Count
    $firedCount = @($lastHistory | Where-Object { [string]$_.status -eq "fired" }).Count
    Write-Host ("history_total={0} fired={1} completed={2} valid_completed={3} failed={4}" -f $lastHistory.Count, $firedCount, $completedItems.Count, $validRuns.Count, $failedCount)
    if ($validRuns.Count -ge $RequiredFires) {
      break
    }
  }

  if ($validRuns.Count -ge $RequiredFires) {
    Write-Host "== Drain in-flight trigger fires =="
    Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/triggers/$TriggerId" -AllowStatus @(200, 404) -Body @{
      enabled = $false
    } | Out-Null
    $drainDeadline = (Get-Date).AddMinutes($DrainInFlightMinutes)
    while ((Get-Date) -lt $drainDeadline) {
      $historyResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/triggers/$TriggerId/runs" -AllowStatus @(200)
      $lastHistory = @(Select-CurrentEvidenceHistory -Items @($historyResp.body.items) -StartedAt $evidenceStartedAt)
      $completedItems = @(Update-ValidTriggerRuns -HistoryItems $lastHistory -ValidRuns $validRuns -BaseUrl $BaseUrl -WorkspaceRoot $WorkspaceRoot -Role $Role -SessionMode $SessionMode)
      Update-ReuseInjectionEvidence -HistoryItems $lastHistory -Evidence $reuseInjectionEvidence -ValidRuns $validRuns -BaseUrl $BaseUrl -TriggerId $TriggerId -TemplateId $TemplateId -Role $Role -SessionMode $SessionMode
      $failedCount = @($lastHistory | Where-Object { [string]$_.status -eq "failed" }).Count
      $firedCount = @($lastHistory | Where-Object { [string]$_.status -eq "fired" }).Count
      Write-Host ("drain history_total={0} fired={1} completed={2} valid_completed={3} failed={4}" -f $lastHistory.Count, $firedCount, $completedItems.Count, $validRuns.Count, $failedCount)
      if ($firedCount -le $AllowedInFlightFires) {
        break
      }
      Start-Sleep -Seconds $PollSeconds
    }
  }

  $summaryDir = Join-Path $WorkspaceRoot "docs\e2e"
  Ensure-Dir -Path $summaryDir
  $summaryPath = Join-Path $summaryDir "trigger_dpagent_stability_summary.json"
  $finalFailedCount = @($lastHistory | Where-Object { [string]$_.status -eq "failed" }).Count
  $finalInFlightCount = @($lastHistory | Where-Object { [string]$_.status -eq "fired" }).Count
  $providerSessionIds = @(
    $validRuns.Values |
      ForEach-Object { [string]$_.provider_session_id } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Select-Object -Unique
  )
  $validWorkflowRunIds = @(
    $validRuns.Values |
      ForEach-Object { [string]$_.run_id } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Select-Object -Unique
  )
  $bindingResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/triggers/$TriggerId/session-bindings" -AllowStatus @(200, 404)
  $sessionBindings = if ([int]$bindingResp.status -eq 200) { @($bindingResp.body.items) } else { @() }
  $roleBinding = @($sessionBindings | Where-Object {
      [string]$_.role -eq $Role -and
      [string]$_.provider -eq "dpagent" -and
      [string]$_.workflowTemplateId -eq $TemplateId
    } | Select-Object -First 1)[0]
  $bindingProviderSessionId = if ($roleBinding) { [string](Get-OptionalProperty -Object $roleBinding -Name "providerSessionId") } else { "" }
  $bindingLastWorkflowRunId = if ($roleBinding) { [string](Get-OptionalProperty -Object $roleBinding -Name "lastWorkflowRunId") } else { "" }
  $distinctWorkflowRunPass = ($validWorkflowRunIds.Count -eq $validRuns.Count)
  $bindingProviderSessionPass = (
    $SessionMode -ne "reuse_provider_session" -or
    ($providerSessionIds.Count -eq 1 -and $bindingProviderSessionId -eq [string]$providerSessionIds[0])
  )
  $bindingLastRunPass = (
    $SessionMode -ne "reuse_provider_session" -or
    ($validWorkflowRunIds -contains $bindingLastWorkflowRunId)
  )
  $reuseInjectionEvidenceItems = @($reuseInjectionEvidence.Values)
  $reuseInjectionEvidencePass = (
    $SessionMode -ne "reuse_provider_session" -or
    $reuseInjectionEvidenceItems.Count -ge [Math]::Max(0, $RequiredFires - 1)
  )
  $providerSessionReusePass = (
    $SessionMode -ne "reuse_provider_session" -or
    (
      $providerSessionIds.Count -eq 1 -and
      $distinctWorkflowRunPass -and
      $bindingProviderSessionPass -and
      $bindingLastRunPass -and
      $reuseInjectionEvidencePass
    )
  )
  $summary = [ordered]@{
    trigger_id = $TriggerId
    template_id = $TemplateId
    role = $Role
    session_mode = $SessionMode
    interval_seconds = $IntervalSeconds
    allowed_in_flight_fires = $AllowedInFlightFires
    required_fires = $RequiredFires
    history_total = $lastHistory.Count
    valid_completed_count = $validRuns.Count
    failed_count = $finalFailedCount
    in_flight_count = $finalInFlightCount
    provider_session_reuse_pass = $providerSessionReusePass
    distinct_workflow_run_pass = $distinctWorkflowRunPass
    binding_provider_session_pass = $bindingProviderSessionPass
    binding_last_run_pass = $bindingLastRunPass
    reuse_injection_evidence_pass = $reuseInjectionEvidencePass
    reuse_injection_evidence_count = $reuseInjectionEvidenceItems.Count
    provider_session_ids = $providerSessionIds
    workflow_run_ids = $validWorkflowRunIds
    session_binding = $roleBinding
    reuse_injection_evidence = $reuseInjectionEvidenceItems
    valid_runs = @($validRuns.Values)
    generated_at = (Get-Date).ToString("o")
  }
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

  $pass = ($validRuns.Count -ge $RequiredFires -and $finalFailedCount -eq 0 -and $finalInFlightCount -le $AllowedInFlightFires -and $providerSessionReusePass)
  Write-Host "summary=$summaryPath"
  Write-Host "trigger_dpagent_stability_pass=$pass"
  if (-not $pass) {
    $summary | ConvertTo-Json -Depth 8 | Write-Host
    exit 1
  }
  exit 0
} catch {
  Write-Host ("script_exception_message=" + $_.Exception.Message)
  Write-Host ("script_exception_stack=" + $_.ScriptStackTrace)
  exit 2
} finally {
  if ($triggerCreated) {
    try {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/triggers/$TriggerId" -AllowStatus @(200, 404) -Body @{
        enabled = $false
      } | Out-Null
    } catch {}
  }
  if ($shouldRestoreSettings) {
    try {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/settings" -AllowStatus @(200) -Body @{
        providers = @{
          dpagent = @{
            cliCommand = $oldDpAgentCliCommand
          }
        }
      } | Out-Null
    } catch {}
  }
  Stop-E2EBackend -Handle $backendHandle
}
