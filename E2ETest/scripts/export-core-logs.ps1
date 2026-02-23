param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "invoke-api.ps1")

Ensure-Dir -Path $OutDir

$events = Get-EventsNdjson -BaseUrl $BaseUrl -ProjectId $ProjectId
$timeline = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/agent-io/timeline?limit=5000"
$taskTree = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/task-tree"
$sessions = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions"
$settings = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/orchestrator/settings"

$taskDetails = @()
foreach ($node in @($taskTree.body.nodes)) {
  $taskId = $node.task_id
  if (-not $taskId) { continue }
  $detail = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/tasks/$taskId/detail" -AllowStatus @(200, 404)
  $taskDetails += [pscustomobject]@{
    task_id = $taskId
    status = $detail.status
    body = $detail.body
    raw = $detail.raw
  }
}

Write-Utf8NoBom -Path (Join-Path $OutDir "events.ndjson") -Content $events.raw
($timeline.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $OutDir "timeline.json") -Encoding UTF8
($taskTree.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $OutDir "task_tree_final.json") -Encoding UTF8
($sessions.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $OutDir "sessions_final.json") -Encoding UTF8
($settings.body | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $OutDir "orchestrator_settings_final.json") -Encoding UTF8
($taskDetails | ConvertTo-Json -Depth 100) | Set-Content -LiteralPath (Join-Path $OutDir "task_details.json") -Encoding UTF8

Write-Host "Exported core logs to: $OutDir"

