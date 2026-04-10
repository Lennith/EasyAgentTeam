param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [int]$TargetSpawnCount = 30,
  [int]$PollIntervalSeconds = 5,
  [int]$MaxLoopMinutes = 60,
  [int]$TailObserveMinutes = 3
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "invoke-api.ps1")

$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDir = Join-Path $repoRoot ("docs/e2e/workflow-loop-30/{0}" -f $timestamp)
Ensure-Dir -Path $outputDir

$summaryPath = Join-Path $outputDir "validation_summary.md"
$spawnChainPath = Join-Path $outputDir "spawn_chain.json"
$pollSnapshotsPath = Join-Path $outputDir "poll_snapshots.json"
$e2eResultPath = Join-Path $outputDir "e2e_workflow_result.txt"

$devStdoutPath = Join-Path $outputDir "pnpm_dev_stdout.log"
$devStderrPath = Join-Path $outputDir "pnpm_dev_stderr.log"

$spawnChain = New-Object System.Collections.Generic.List[object]
$pollSnapshots = New-Object System.Collections.Generic.List[object]
$errors = New-Object System.Collections.Generic.List[string]
$runMap = @{}

$seedRunId = ""
$templateId = ""
$workspacePath = ""
$spawnCount = 0
$overallStatus = "FAIL"
$e2eExitCode = -1
$minimaxConfigured = $false
$devProcess = $null
$devStartedByScript = $false

$createdAt = (Get-Date).ToString("o")
$startedAt = Get-Date

function Add-PollSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][int]$SpawnCount,
    [Parameter(Mandatory = $true)][object[]]$Runs,
    [string]$ReportedRunId = ""
  )

  $latestRun = Get-LatestRun -Runs $Runs
  $pollSnapshots.Add(
    [pscustomobject]@{
      timestamp = (Get-Date).ToString("o")
      phase = $Phase
      spawn_count = $SpawnCount
      template_run_total = $Runs.Count
      latest_run_id = if ($null -eq $latestRun) { $null } else { Get-RunId -Run $latestRun }
      latest_status = if ($null -eq $latestRun) { $null } else { Get-RunStatus -Run $latestRun }
      reported_run_id = if ([string]::IsNullOrWhiteSpace($ReportedRunId)) { $null } else { $ReportedRunId }
      run_ids = @($Runs | ForEach-Object { Get-RunId -Run $_ })
    }
  ) | Out-Null
}

function Get-FieldValue {
  param(
    [Parameter(Mandatory = $true)][object]$InputObject,
    [Parameter(Mandatory = $true)][string[]]$Names
  )

  foreach ($name in $Names) {
    if ($InputObject -is [System.Collections.IDictionary]) {
      if ($InputObject.Contains($name)) {
        return $InputObject[$name]
      }
    }
    $property = $InputObject.PSObject.Properties[$name]
    if ($null -ne $property) {
      return $property.Value
    }
  }
  return $null
}

function Get-RunId {
  param([Parameter(Mandatory = $true)][object]$Run)
  return [string](Get-FieldValue -InputObject $Run -Names @("run_id", "runId"))
}

function Get-RunTemplateId {
  param([Parameter(Mandatory = $true)][object]$Run)
  return [string](Get-FieldValue -InputObject $Run -Names @("template_id", "templateId"))
}

function Get-RunWorkspacePath {
  param([Parameter(Mandatory = $true)][object]$Run)
  return [string](Get-FieldValue -InputObject $Run -Names @("workspace_path", "workspacePath"))
}

function Get-RunOriginId {
  param([Parameter(Mandatory = $true)][object]$Run)
  return [string](Get-FieldValue -InputObject $Run -Names @("origin_run_id", "originRunId"))
}

function Get-RunMode {
  param([Parameter(Mandatory = $true)][object]$Run)
  return [string](Get-FieldValue -InputObject $Run -Names @("mode"))
}

function Get-RunLoopEnabled {
  param([Parameter(Mandatory = $true)][object]$Run)
  $value = Get-FieldValue -InputObject $Run -Names @("loop_enabled", "loopEnabled")
  if ($null -eq $value) {
    return $false
  }
  return [bool]$value
}

function Get-RunStatus {
  param([Parameter(Mandatory = $true)][object]$Run)
  return [string](Get-FieldValue -InputObject $Run -Names @("status"))
}

function Get-RunCreatedAt {
  param([Parameter(Mandatory = $true)][object]$Run)
  $value = [string](Get-FieldValue -InputObject $Run -Names @("created_at", "createdAt"))
  if ([string]::IsNullOrWhiteSpace($value)) {
    return [DateTime]::MinValue
  }
  try {
    return [DateTime]::Parse($value)
  } catch {
    return [DateTime]::MinValue
  }
}

function Normalize-ScalarValue {
  param([object]$Value)
  if ($null -eq $Value) {
    return ""
  }
  if ($Value -is [bool]) {
    return [string]$Value
  }
  return ([string]$Value).Trim()
}

function Normalize-JsonValue {
  param([object]$Value)
  if ($null -eq $Value) {
    return ""
  }
  return ($Value | ConvertTo-Json -Depth 100 -Compress)
}

function Is-TerminalStatus {
  param([string]$Status)
  if ([string]::IsNullOrWhiteSpace($Status)) {
    return $false
  }
  switch ($Status.Trim().ToLowerInvariant()) {
    "finished" { return $true }
    "stopped" { return $true }
    "canceled" { return $true }
    "cancelled" { return $true }
    "failed" { return $true }
    "error" { return $true }
    default { return $false }
  }
}

function Get-LatestRun {
  param([Parameter(Mandatory = $true)][object[]]$Runs)
  if ($Runs.Count -eq 0) {
    return $null
  }
  return @($Runs | Sort-Object -Property @{ Expression = { Get-RunCreatedAt -Run $_ } }, @{ Expression = { Get-RunId -Run $_ } })[-1]
}

function Get-LatestActiveRun {
  param([Parameter(Mandatory = $true)][object[]]$Runs)
  $sorted = @($Runs | Sort-Object -Property @{ Expression = { Get-RunCreatedAt -Run $_ } }, @{ Expression = { Get-RunId -Run $_ } })
  [array]::Reverse($sorted)
  foreach ($run in $sorted) {
    if (-not (Is-TerminalStatus -Status (Get-RunStatus -Run $run))) {
      return $run
    }
  }
  return $null
}

function Get-LatestRunningRun {
  param([Parameter(Mandatory = $true)][object[]]$Runs)
  $sorted = @($Runs | Sort-Object -Property @{ Expression = { Get-RunCreatedAt -Run $_ } }, @{ Expression = { Get-RunId -Run $_ } })
  [array]::Reverse($sorted)
  foreach ($run in $sorted) {
    if ((Get-RunStatus -Run $run).Trim().ToLowerInvariant() -eq "running") {
      return $run
    }
  }
  return $null
}

function Get-TemplateRuns {
  param([Parameter(Mandatory = $true)][string]$TemplateId)

  $resp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs"
  $items = @($resp.body.items)
  $filtered = @()
  foreach ($item in $items) {
    if ((Get-RunTemplateId -Run $item) -eq $TemplateId) {
      $filtered += $item
    }
  }
  return @($filtered | Sort-Object -Property @{ Expression = { Get-RunCreatedAt -Run $_ } }, @{ Expression = { Get-RunId -Run $_ } })
}

function Get-LoopValidationRuns {
  $resp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs"
  $items = @($resp.body.items)
  $filtered = @()
  foreach ($item in $items) {
    $templateId = Get-RunTemplateId -Run $item
    $workspacePath = Get-RunWorkspacePath -Run $item
    if ($templateId -like "workflow_loop30_tpl_*" -or $workspacePath -like "*\.minimax\workflow-loop-30\*") {
      $filtered += $item
    }
  }
  return @($filtered | Sort-Object -Property @{ Expression = { Get-RunCreatedAt -Run $_ } }, @{ Expression = { Get-RunId -Run $_ } })
}

function Get-RunById {
  param([Parameter(Mandatory = $true)][string]$RunId)
  $resp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path ("/api/workflow-runs/{0}" -f $RunId)
  return $resp.body
}

function Disable-RecurringRun {
  param([Parameter(Mandatory = $true)][object]$Run)

  $runId = Get-RunId -Run $Run
  if ([string]::IsNullOrWhiteSpace($runId)) {
    return
  }

  $disableLoopBody = @{
    mode = "none"
    loop_enabled = $false
    schedule_enabled = $false
  }
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path ("/api/workflow-runs/{0}/orchestrator/settings" -f $runId) -Body $disableLoopBody | Out-Null
  if (-not (Is-TerminalStatus -Status (Get-RunStatus -Run $Run))) {
    Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path ("/api/workflow-runs/{0}/stop" -f $runId) | Out-Null
  }
}

function Cleanup-LoopValidationChains {
  param([string]$ExcludeTemplateId = "")

  $runs = Get-LoopValidationRuns
  $latestByTemplateId = @{}
  foreach ($run in $runs) {
    $templateId = Get-RunTemplateId -Run $run
    if ([string]::IsNullOrWhiteSpace($templateId) -or $templateId -eq $ExcludeTemplateId) {
      continue
    }
    $latestByTemplateId[$templateId] = $run
  }

  foreach ($run in $latestByTemplateId.Values) {
    Disable-RecurringRun -Run $run
  }
}

function Cleanup-CurrentTemplateChain {
  param([string]$TemplateId)

  if ([string]::IsNullOrWhiteSpace($TemplateId)) {
    return
  }

  $templateRuns = Get-TemplateRuns -TemplateId $TemplateId
  if ($templateRuns.Count -eq 0) {
    return
  }

  $latestRun = Get-LatestRun -Runs $templateRuns
  if ($null -ne $latestRun) {
    Disable-RecurringRun -Run $latestRun
  }
}

function Ensure-ApiReady {
  param(
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [int]$ProbeIntervalSeconds = 2
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($script:devStartedByScript -and $null -ne $script:devProcess) {
      $resolvedBaseUrl = Try-Resolve-BaseUrlFromDevLog -LogPath $devStdoutPath
      if (-not [string]::IsNullOrWhiteSpace($resolvedBaseUrl) -and $script:BaseUrl -ne $resolvedBaseUrl) {
        $script:BaseUrl = $resolvedBaseUrl
        Write-Host ("resolved_base_url={0}" -f $script:BaseUrl)
      }
    }
    try {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs" | Out-Null
      return
    } catch {
      if ($script:devStartedByScript -and $null -ne $script:devProcess -and $script:devProcess.HasExited) {
        $portInUseBaseUrl = Try-Resolve-BaseUrlFromPortInUseLog -LogPath $devStderrPath
        if (-not [string]::IsNullOrWhiteSpace($portInUseBaseUrl)) {
          try {
            Invoke-ApiJson -BaseUrl $portInUseBaseUrl -Method GET -Path "/api/workflow-runs" | Out-Null
            $script:BaseUrl = $portInUseBaseUrl
            Write-Host ("resolved_api_from_eaddrinuse={0}" -f $script:BaseUrl)
            return
          } catch {}
        }
        if (Try-UseExistingApiServer) {
          return
        }
        throw "Dev server process exited before API became ready. See $devStdoutPath and $devStderrPath."
      }
      Start-Sleep -Seconds $ProbeIntervalSeconds
    }
  }
  throw "API is not ready at $BaseUrl within ${TimeoutSeconds}s."
}

function Try-Resolve-BaseUrlFromDevLog {
  param([Parameter(Mandatory = $true)][string]$LogPath)

  if (-not (Test-Path -LiteralPath $LogPath)) {
    return $null
  }

  $tail = @()
  try {
    $tail = @(Get-Content -Path $LogPath -Tail 50)
  } catch {
    return $null
  }

  foreach ($line in $tail) {
    if ($line -match "listening on\s+(https?://[0-9A-Za-z\.\-:]+)") {
      return [string]$Matches[1]
    }
  }

  return $null
}

function Try-Resolve-BaseUrlFromPortInUseLog {
  param([Parameter(Mandatory = $true)][string]$LogPath)

  if (-not (Test-Path -LiteralPath $LogPath)) {
    return $null
  }

  $content = ""
  try {
    $content = [string](Get-Content -Path $LogPath -Raw)
  } catch {
    return $null
  }

  if ($content -match "address already in use\s+127\.0\.0\.1:(\d+)") {
    return "http://127.0.0.1:$($Matches[1])"
  }
  return $null
}

function Get-HistoricalBaseUrlCandidates {
  $candidates = New-Object System.Collections.Generic.List[string]
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

  if (-not [string]::IsNullOrWhiteSpace($BaseUrl) -and $seen.Add($BaseUrl)) {
    $candidates.Add($BaseUrl) | Out-Null
  }

  $historyRoot = Join-Path $repoRoot "docs/e2e/workflow-loop-30"
  if (Test-Path -LiteralPath $historyRoot) {
    $historyDirs = Get-ChildItem -Path $historyRoot -Directory | Sort-Object Name -Descending | Select-Object -First 20
    foreach ($dir in $historyDirs) {
      $logPath = Join-Path $dir.FullName "pnpm_dev_stdout.log"
      $candidate = Try-Resolve-BaseUrlFromDevLog -LogPath $logPath
      if (-not [string]::IsNullOrWhiteSpace($candidate) -and $seen.Add($candidate)) {
        $candidates.Add($candidate) | Out-Null
      }
    }
  }

  return @($candidates)
}

function Try-UseExistingApiServer {
  $candidates = Get-HistoricalBaseUrlCandidates
  foreach ($candidate in $candidates) {
    try {
      Invoke-ApiJson -BaseUrl $candidate -Method GET -Path "/api/workflow-runs" | Out-Null
      if ($BaseUrl -ne $candidate) {
        $script:BaseUrl = $candidate
      }
      Write-Host ("resolved_existing_api_base_url={0}" -f $script:BaseUrl)
      return $true
    } catch {
      continue
    }
  }
  return $false
}

function Compare-Field {
  param(
    [Parameter(Mandatory = $true)][object]$ParentRun,
    [Parameter(Mandatory = $true)][object]$ChildRun,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string[]]$Keys,
    [switch]$AsJson
  )

  $parentValue = Get-FieldValue -InputObject $ParentRun -Names $Keys
  $childValue = Get-FieldValue -InputObject $ChildRun -Names $Keys
  $left = if ($AsJson.IsPresent) { Normalize-JsonValue -Value $parentValue } else { Normalize-ScalarValue -Value $parentValue }
  $right = if ($AsJson.IsPresent) { Normalize-JsonValue -Value $childValue } else { Normalize-ScalarValue -Value $childValue }
  if ($left -ne $right) {
    throw "inheritance drift on '$Label': parent=$left child=$right"
  }
}

function Ensure-RunInCache {
  param([Parameter(Mandatory = $true)][string]$RunId)
  if (-not $runMap.ContainsKey($RunId)) {
    $runMap[$RunId] = Get-RunById -RunId $RunId
  }
}

function Write-Artifacts {
  param(
    [Parameter(Mandatory = $true)][string]$Status,
    [Parameter(Mandatory = $true)][DateTime]$Started,
    [Parameter(Mandatory = $true)][DateTime]$Ended
  )

  $durationSec = [Math]::Round(($Ended - $Started).TotalSeconds, 2)
  $errorText = if ($errors.Count -eq 0) { "- (none)" } else { ($errors | ForEach-Object { "- $_" }) -join "`n" }
  $summary = @"
# Workflow loop validation summary

- status: $Status
- started_at: $($Started.ToString("o"))
- ended_at: $($Ended.ToString("o"))
- duration_seconds: $durationSec
- base_url: $BaseUrl
- template_id: $templateId
- seed_run_id: $seedRunId
- workspace_path: $workspacePath
- target_spawn_count: $TargetSpawnCount
- actual_spawn_count: $spawnCount
- minimax_configured: $minimaxConfigured
- e2e_exit_code: $e2eExitCode

## Errors
$errorText
"@

  Write-Utf8NoBom -Path $summaryPath -Content $summary
  $spawnChainJson = if ($spawnChain.Count -eq 0) { "[]" } else { ($spawnChain | ConvertTo-Json -Depth 100) }
  $pollSnapshotsJson = if ($pollSnapshots.Count -eq 0) { "[]" } else { ($pollSnapshots | ConvertTo-Json -Depth 100) }
  Write-Utf8NoBom -Path $spawnChainPath -Content $spawnChainJson
  Write-Utf8NoBom -Path $pollSnapshotsPath -Content $pollSnapshotsJson
}

try {
  Write-Host ("loop_validation_output_dir={0}" -f $outputDir)

  if (Try-UseExistingApiServer) {
    Write-Host ("api_precheck_ok=true base_url={0}" -f $BaseUrl)
  } else {
    Write-Host "api_precheck_ok=false, starting pnpm run dev:server"
    $devProcess = Start-Process -FilePath "pnpm.cmd" -ArgumentList @("run", "dev:server") -WorkingDirectory $repoRoot -PassThru -RedirectStandardOutput $devStdoutPath -RedirectStandardError $devStderrPath
    $devStartedByScript = $true
    Ensure-ApiReady -TimeoutSeconds 180
  }

  $settingsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/settings"
  $minimaxApiKey = [string](Get-FieldValue -InputObject $settingsResp.body -Names @("minimaxApiKey", "minimax_api_key"))
  $minimaxModel = [string](Get-FieldValue -InputObject $settingsResp.body -Names @("minimaxModel", "minimax_model"))
  $minimaxConfigured = (-not [string]::IsNullOrWhiteSpace($minimaxApiKey)) -and (-not [string]::IsNullOrWhiteSpace($minimaxModel))
  if (-not $minimaxConfigured) {
    throw "MiniMax configuration is missing; fail by policy."
  }
  Write-Host "minimax_precheck_ok=true"

  Cleanup-LoopValidationChains

  $templateId = "workflow_loop30_tpl_$((Get-Date).ToString('yyyyMMddHHmmss'))"
  $workspacePath = Join-Path $repoRoot (".minimax/workflow-loop-30/{0}" -f $timestamp)
  Ensure-Dir -Path $workspacePath

  $templateBody = @{
    template_id = $templateId
    name = "workflow-loop-30-validation"
    description = "Minimal workflow template for loop spawn validation"
    tasks = @(
      @{
        task_id = "loop_task_01"
        title = "Loop task"
        owner_role = "loop_tester"
        acceptance = @("Report DONE via TASK_REPORT.")
      }
    )
  }
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-templates" -Body $templateBody -AllowStatus @(201) | Out-Null

  $seedRunBody = @{
    template_id = $templateId
    name = "loop-seed"
    workspace_path = $workspacePath
    variables = @{
      validation_case = "workflow-loop-30"
      validator = "loop-watchdog"
    }
    task_overrides = @{
      loop_task_01 = "Loop task override"
    }
    mode = "loop"
    loop_enabled = $true
    schedule_enabled = $false
    auto_dispatch_enabled = $true
    auto_dispatch_remaining = 3
    hold_enabled = $false
    reminder_mode = "backoff"
  }
  $seedCreate = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs" -Body $seedRunBody -AllowStatus @(201)
  $seedRunId = Get-RunId -Run $seedCreate.body
  if ([string]::IsNullOrWhiteSpace($seedRunId)) {
    throw "seed run id missing from POST /api/workflow-runs"
  }
  $runMap[$seedRunId] = $seedCreate.body
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path ("/api/workflow-runs/{0}/start" -f $seedRunId) | Out-Null

  $seenRunIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $seenSpawnedRunIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $reportedRunIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $null = $seenRunIds.Add($seedRunId)

  $watchdogDeadline = (Get-Date).AddMinutes($MaxLoopMinutes)
  while ($spawnCount -lt $TargetSpawnCount) {
    if ((Get-Date) -gt $watchdogDeadline) {
      throw "loop watchdog timeout after ${MaxLoopMinutes}m; spawn_count=$spawnCount"
    }

    $templateRuns = Get-TemplateRuns -TemplateId $templateId
    foreach ($run in $templateRuns) {
      $runId = Get-RunId -Run $run
      if ([string]::IsNullOrWhiteSpace($runId)) {
        continue
      }
      $runMap[$runId] = $run
      $null = $seenRunIds.Add($runId)
      if ($runId -ne $seedRunId -and -not $seenSpawnedRunIds.Contains($runId)) {
        $null = $seenSpawnedRunIds.Add($runId)
        $spawnCount += 1
        if ($spawnCount -gt $TargetSpawnCount) {
          throw "spawn_count exceeded target: $spawnCount"
        }
        $spawnChain.Add(
          [pscustomobject]@{
            index = $spawnCount
            runId = $runId
            templateId = Get-RunTemplateId -Run $run
            workspacePath = Get-RunWorkspacePath -Run $run
            originRunId = Get-RunOriginId -Run $run
            mode = Get-RunMode -Run $run
            loopEnabled = Get-RunLoopEnabled -Run $run
            autoDispatchInitialRemaining = Get-FieldValue -InputObject $run -Names @("auto_dispatch_initial_remaining", "autoDispatchInitialRemaining")
            autoDispatchRemaining = Get-FieldValue -InputObject $run -Names @("auto_dispatch_remaining", "autoDispatchRemaining")
            createdAt = [string](Get-FieldValue -InputObject $run -Names @("created_at", "createdAt"))
          }
        ) | Out-Null
        Write-Host ("spawn_detected index={0} run_id={1}" -f $spawnCount, $runId)
      }
    }

    $latestActiveRun = Get-LatestRunningRun -Runs $templateRuns
    $reportedRunId = ""
    if ($null -ne $latestActiveRun) {
      $latestActiveRunId = Get-RunId -Run $latestActiveRun
      if (-not [string]::IsNullOrWhiteSpace($latestActiveRunId) -and -not $reportedRunIds.Contains($latestActiveRunId)) {
        $taskReportBody = @{
          action_type = "TASK_REPORT"
          from_agent = "loop_tester"
          from_session_id = "loop-validation-watchdog"
          results = @(
            @{
              task_id = "loop_task_01"
              outcome = "DONE"
              summary = "loop watchdog DONE"
            }
          )
        }
        Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path ("/api/workflow-runs/{0}/task-actions" -f $latestActiveRunId) -Body $taskReportBody | Out-Null
        $null = $reportedRunIds.Add($latestActiveRunId)
        $reportedRunId = $latestActiveRunId
      }
    }

    Add-PollSnapshot -Phase "loop" -SpawnCount $spawnCount -Runs $templateRuns -ReportedRunId $reportedRunId

    if ($spawnCount -ge $TargetSpawnCount) {
      break
    }
    Start-Sleep -Seconds $PollIntervalSeconds
  }

  if ($spawnCount -ne $TargetSpawnCount) {
    throw "spawn_count mismatch: expected=$TargetSpawnCount actual=$spawnCount"
  }

  $beforeStopRuns = Get-TemplateRuns -TemplateId $templateId
  foreach ($run in $beforeStopRuns) {
    $runId = Get-RunId -Run $run
    if (-not [string]::IsNullOrWhiteSpace($runId)) {
      $runMap[$runId] = $run
    }
  }

  $uniqueSpawnRunIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $spawnChain) {
    if (-not $uniqueSpawnRunIds.Add([string]$entry.runId)) {
      throw "duplicate spawned run id detected: $($entry.runId)"
    }
  }

  $expectedOrigin = $seedRunId
  foreach ($entry in $spawnChain) {
    $entryRunId = [string]$entry.runId
    $originRunId = [string]$entry.originRunId
    if ($originRunId -ne $expectedOrigin) {
      throw "origin_run_id chain break at run=$entryRunId expected=$expectedOrigin actual=$originRunId"
    }

    $runMap[$expectedOrigin] = Get-RunById -RunId $expectedOrigin
    $runMap[$entryRunId] = Get-RunById -RunId $entryRunId
    $parentRun = $runMap[$expectedOrigin]
    $childRun = $runMap[$entryRunId]
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "templateId" -Keys @("template_id", "templateId")
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "workspacePath" -Keys @("workspace_path", "workspacePath")
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "variables" -Keys @("variables") -AsJson
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "taskOverrides" -Keys @("task_overrides", "taskOverrides") -AsJson
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "mode" -Keys @("mode")
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "loopEnabled" -Keys @("loop_enabled", "loopEnabled")
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "autoDispatchEnabled" -Keys @("auto_dispatch_enabled", "autoDispatchEnabled")
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "autoDispatchInitialRemaining" -Keys @("auto_dispatch_initial_remaining", "autoDispatchInitialRemaining")
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "holdEnabled" -Keys @("hold_enabled", "holdEnabled")
    Compare-Field -ParentRun $parentRun -ChildRun $childRun -Label "reminderMode" -Keys @("reminder_mode", "reminderMode")
    $expectedOrigin = $entryRunId
  }

  $activeRun = Get-LatestActiveRun -Runs $beforeStopRuns
  if ($null -eq $activeRun) {
    $activeRun = Get-LatestRun -Runs $beforeStopRuns
  }
  if ($null -eq $activeRun) {
    throw "no run found for stop step"
  }
  $activeRunId = Get-RunId -Run $activeRun
  if ([string]::IsNullOrWhiteSpace($activeRunId)) {
    throw "active run id missing before stop"
  }

  $disableLoopBody = @{
    mode = "none"
    loop_enabled = $false
    schedule_enabled = $false
  }
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path ("/api/workflow-runs/{0}/orchestrator/settings" -f $activeRunId) -Body $disableLoopBody | Out-Null
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path ("/api/workflow-runs/{0}/stop" -f $activeRunId) | Out-Null

  $tailDeadline = (Get-Date).AddMinutes($TailObserveMinutes)
  while ((Get-Date) -lt $tailDeadline) {
    $tailRuns = Get-TemplateRuns -TemplateId $templateId
    foreach ($run in $tailRuns) {
      $runId = Get-RunId -Run $run
      if ([string]::IsNullOrWhiteSpace($runId)) {
        continue
      }
      $runMap[$runId] = $run
      if (-not $seenRunIds.Contains($runId)) {
        throw "unexpected new run after stop window: $runId"
      }
    }
    Add-PollSnapshot -Phase "tail" -SpawnCount $spawnCount -Runs $tailRuns
    Start-Sleep -Seconds $PollIntervalSeconds
  }

  "Running pnpm e2e:workflow ..." | Tee-Object -FilePath $e2eResultPath | Out-Null
  & pnpm e2e:workflow 2>&1 | Tee-Object -FilePath $e2eResultPath -Append
  $e2eExitCode = $LASTEXITCODE
  if ($e2eExitCode -ne 0) {
    throw "pnpm e2e:workflow failed with exit code $e2eExitCode"
  }

  $overallStatus = "PASS"
} catch {
  $errors.Add([string]$_.Exception.Message) | Out-Null
  if (-not (Test-Path -LiteralPath $e2eResultPath)) {
    Write-Utf8NoBom -Path $e2eResultPath -Content ("e2e not completed. error: {0}" -f [string]$_.Exception.Message)
  } else {
    Add-Content -Path $e2eResultPath -Value ("`nERROR: {0}" -f [string]$_.Exception.Message)
  }
  Write-Host ("loop_validation_failed reason={0}" -f [string]$_.Exception.Message)
} finally {
  $endedAt = Get-Date
  if (-not [string]::IsNullOrWhiteSpace($templateId)) {
    try {
      Cleanup-CurrentTemplateChain -TemplateId $templateId
    } catch {
      $errors.Add("cleanup current template chain failed: $([string]$_.Exception.Message)") | Out-Null
    }
  }
  Write-Artifacts -Status $overallStatus -Started $startedAt -Ended $endedAt
  if ($devStartedByScript -and $null -ne $devProcess -and -not $devProcess.HasExited) {
    Stop-Process -Id $devProcess.Id -Force
  }
  Write-Host ("loop_validation_status={0}" -f $overallStatus)
  Write-Host ("validation_summary={0}" -f $summaryPath)
}

if ($overallStatus -ne "PASS") {
  exit 1
}
