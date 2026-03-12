param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$WorkspaceRoot = "D:\AgentWorkSpace\TestTeam\TestSkillImport",
  [string]$SkillSourcePath = "C:\Users\spiri\.config\opencode\skills\minimax-vision",
  [string]$SkillListId = "e2e_skill_list",
  [string]$AgentId = "skill_e2e_agent",
  [string]$TemplateId = "e2e_skill_template",
  [string]$WorkflowName = "Skill Import E2E",
  [int]$MaxMinutes = 15,
  [int]$PollSeconds = 5,
  [switch]$RequireRunSuccess
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "invoke-api.ps1")

function Wait-ForCondition {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][int]$PollSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $result = & $Condition
    if ($result.pass) {
      return $result
    }
    Start-Sleep -Seconds $PollSeconds
  }
  return [pscustomobject]@{ pass = $false; detail = "timeout" }
}

Write-Host "== Skill Import E2E: preflight =="
$health = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/healthz"
if ($health.body.status -ne "ok") {
  throw "healthz is not ok"
}

if (-not (Test-Path -LiteralPath $SkillSourcePath)) {
  throw "Skill source path not found: $SkillSourcePath"
}

Write-Host "== Reset workspace =="
Reset-WorkspaceDirectory -WorkspaceRoot $WorkspaceRoot
Ensure-Dir -Path $WorkspaceRoot

$runStamp = Get-Date -Format "yyyyMMddHHmmss"
$runId = "e2e_skill_run_$runStamp"
$sessionId = "e2e-skill-session-$runStamp"
$artifactsDir = Join-Path $WorkspaceRoot "docs\e2e\$($runStamp)-skill-import"
Ensure-Dir -Path $artifactsDir

Write-Host "== Import skill from local source =="
$importResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/skills/import" -Body @{
  sources = @($SkillSourcePath)
  recursive = $true
} -AllowStatus @(200)

$imported = @($importResp.body.imported)
if ($imported.Count -le 0) {
  throw "No skill imported from source: $SkillSourcePath"
}

$sourceFull = [System.IO.Path]::GetFullPath($SkillSourcePath).TrimEnd('\').ToLowerInvariant()
$selectedImport = $null
foreach ($item in $imported) {
  $itemSource = [string]$item.skill.sourcePath
  if ([string]::IsNullOrWhiteSpace($itemSource)) { continue }
  $itemSourceFull = [System.IO.Path]::GetFullPath($itemSource).TrimEnd('\').ToLowerInvariant()
  if ($itemSourceFull -eq $sourceFull) {
    $selectedImport = $item
    break
  }
}
if ($null -eq $selectedImport) {
  $selectedImport = $imported[0]
}

$skillId = [string]$selectedImport.skill.skillId
if ([string]::IsNullOrWhiteSpace($skillId)) {
  throw "Imported skill id is empty."
}
Write-Host ("Imported skill_id={0}" -f $skillId)

Write-Host "== Upsert skill list =="
$createSkillList = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/skill-lists" -Body @{
  list_id = $SkillListId
  display_name = "E2E Skill List"
  description = "Skill import e2e list"
  include_all = $false
  skill_ids = @($skillId)
} -AllowStatus @(201, 409)

if ([int]$createSkillList.status -eq 409) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/skill-lists/$SkillListId" -Body @{
    display_name = "E2E Skill List"
    description = "Skill import e2e list"
    include_all = $false
    skill_ids = @($skillId)
  } -AllowStatus @(200) | Out-Null
}

Write-Host "== Upsert agent with skill_list =="
$agentList = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/agents" -AllowStatus @(200)
$known = @{}
foreach ($agent in @($agentList.body.items)) {
  $known[[string]$agent.agentId] = $true
}

$agentPayload = @{
  agent_id = $AgentId
  display_name = $AgentId
  prompt = @(
    "You are agent '$AgentId' for skill import E2E."
    "If a skill instruction is provided in system prompt, follow it."
    "Always report progress using TASK_REPORT."
  ) -join "`n"
  summary = "E2E skill validation agent."
  skill_list = @($SkillListId)
  provider_id = "minimax"
}

if ($known.ContainsKey($AgentId)) {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/agents/$AgentId" -Body $agentPayload -AllowStatus @(200) | Out-Null
} else {
  Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/agents" -Body $agentPayload -AllowStatus @(201) | Out-Null
}

Write-Host "== Recreate workflow template =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/workflow-templates/$TemplateId" -AllowStatus @(200, 404) | Out-Null
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-templates" -Body @{
  template_id = $TemplateId
  name = $WorkflowName
  description = "E2E workflow for skill import validation"
  tasks = @(
    @{
      task_id = "phase_skill_check"
      title = "Run skill check task"
      owner_role = $AgentId
      acceptance = @("Dispatch path resolves imported skill and runs once")
      artifacts = @("docs/e2e/skill-import-check.md")
    }
  )
} -AllowStatus @(201) | Out-Null

Write-Host "== Create and start workflow run =="
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs" -Body @{
  template_id = $TemplateId
  run_id = $runId
  name = "$WorkflowName $runStamp"
  workspace_path = $WorkspaceRoot
  auto_dispatch_enabled = $false
  auto_dispatch_remaining = 5
} -AllowStatus @(201) | Out-Null

Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/start" -AllowStatus @(200) | Out-Null
Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/sessions" -Body @{
  role = $AgentId
  session_id = $sessionId
} -AllowStatus @(200, 201, 409) | Out-Null

Write-Host "== Trigger manual dispatch =="
$dispatchResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/workflow-runs/$runId/orchestrator/dispatch" -Body @{
  role = $AgentId
  force = $true
  only_idle = $false
} -AllowStatus @(200)

Write-Host ("dispatch_count={0}" -f @($dispatchResp.body.results).Count)

Write-Host "== Poll timeline for skill usage evidence =="
$timeoutSec = $MaxMinutes * 60
$skillEvidence = Wait-ForCondition -TimeoutSeconds $timeoutSec -PollSeconds $PollSeconds -Condition {
  $timelineResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/agent-io/timeline?limit=500" -AllowStatus @(200)
  $timelineItems = @($timelineResp.body.items)
  $dispatchItems = @($timelineItems | Where-Object { $_.kind -like "dispatch_*" })
  $withSkill = @(
    $dispatchItems | Where-Object {
      $content = [string]$_.content
      $content -and $content.Contains("requestedSkillIds=") -and $content.Contains($skillId)
    }
  )
  if ($withSkill.Count -gt 0) {
    return [pscustomobject]@{
      pass = $true
      dispatch_items = $dispatchItems
      evidence = $withSkill
      timeline = $timelineItems
    }
  }
  return [pscustomobject]@{
    pass = $false
    dispatch_items = $dispatchItems
    timeline = $timelineItems
  }
}

if (-not $skillEvidence.pass) {
  throw "No dispatch timeline item contains requestedSkillIds with imported skill '$skillId'."
}

$skillErrorItems = @(
  @($skillEvidence.evidence) | Where-Object {
    $status = [string]$_.status
    $status.Contains("SKILL_REQUIRED_MISSING")
  }
)
if ($skillErrorItems.Count -gt 0) {
  throw "Skill injection reported SKILL_REQUIRED_MISSING."
}

$finalRuntime = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/workflow-runs/$runId/task-runtime" -AllowStatus @(200)
$taskRows = @($finalRuntime.body.tasks)
$phaseRow = @($taskRows | Where-Object { [string]$_.taskId -eq "phase_skill_check" } | Select-Object -First 1)[0]
$phaseState = if ($phaseRow) { [string]$phaseRow.state } else { "MISSING" }

if ($RequireRunSuccess.IsPresent -and $phaseState -ne "DONE") {
  throw "RequireRunSuccess enabled but phase task is '$phaseState' (expected DONE)."
}

$summary = [ordered]@{
  run_id = $runId
  template_id = $TemplateId
  workspace_root = $WorkspaceRoot
  skill_source = $SkillSourcePath
  imported_skill_id = $skillId
  skill_list_id = $SkillListId
  agent_id = $AgentId
  require_run_success = $RequireRunSuccess.IsPresent
  phase_state = $phaseState
  dispatch_results = @($dispatchResp.body.results)
  skill_evidence = @($skillEvidence.evidence)
}

$summaryJson = $summary | ConvertTo-Json -Depth 20
Write-Utf8NoBom -Path (Join-Path $artifactsDir "skill_import_summary.json") -Content $summaryJson

$summaryMd = @(
  "# Skill Import E2E Summary"
  ""
  "- run_id: $runId"
  "- imported_skill_id: $skillId"
  "- skill_list_id: $SkillListId"
  "- agent_id: $AgentId"
  "- phase_state: $phaseState"
  "- require_run_success: $($RequireRunSuccess.IsPresent)"
  ""
  "## Result"
  "- Skill imported via API."
  "- Agent referenced skill list."
  "- Workflow dispatch timeline contains requestedSkillIds including imported skill."
) -join "`n"
Write-Utf8NoBom -Path (Join-Path $artifactsDir "run_summary.md") -Content $summaryMd

Write-Host "== Skill Import E2E Passed =="
Write-Host ("Artifacts: {0}" -f $artifactsDir)
