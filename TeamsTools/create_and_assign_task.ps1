param(
  [Parameter(Mandatory=$true)][string]$title,
  [Parameter(Mandatory=$true)][string]$to_role,
  [string]$task_id = '',
  [string]$parent_task_id = '',
  [string]$root_task_id = '',
  [int]$priority = 0,
  [string]$dependencies = '',
  [string]$write_set = '',
  [string]$acceptance = '',
  [string]$artifacts = '',
  [string]$content = '',
  [string]$manager_url = '',
  [string]$project_id = '',
  [string]$from_agent = '',
  [string]$from_session_id = ''
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

function Write-ToolError([string]$Code, [string]$Message, [string]$NextAction = '', [object]$Raw = $null) {
  $payload = @{
    error_code = $Code
    message = $Message
    next_action = if ($NextAction) { $NextAction } else { $null }
    raw = $Raw
  }
  $json = $payload | ConvertTo-Json -Depth 16
  [Console]::Error.WriteLine($json)
  Write-Output $json
  exit 2
}

function Split-Items([string]$Raw) {
  if (-not $Raw) { return @() }
  return $Raw -split '[,\n\r\|]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

function Resolve-TaskId([string]$Candidate, [string]$CreatorRole, [string]$OwnerRole) {
  if ($Candidate -and $Candidate.Trim()) {
    return $Candidate.Trim()
  }
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $rand = [guid]::NewGuid().ToString('N').Substring(0, 6)
  $creator = if ($CreatorRole) { $CreatorRole } else { 'agent' }
  $owner = if ($OwnerRole) { $OwnerRole } else { 'owner' }
  return "task-$ts-$creator-to-$owner-$rand"
}

$resolvedManagerUrl = if ($manager_url.Trim()) { $manager_url.Trim() } elseif ($env:AUTO_DEV_MANAGER_URL) { $env:AUTO_DEV_MANAGER_URL.Trim() } else { 'http://127.0.0.1:3000' }
$resolvedProjectId = if ($project_id.Trim()) { $project_id.Trim() } elseif ($env:AUTO_DEV_PROJECT_ID) { $env:AUTO_DEV_PROJECT_ID.Trim() } else { '' }
$resolvedFromAgent = if ($from_agent.Trim()) { $from_agent.Trim() } elseif ($env:AUTO_DEV_AGENT_ROLE) { $env:AUTO_DEV_AGENT_ROLE.Trim() } else { '' }
$resolvedFromSessionId = if ($from_session_id.Trim()) { $from_session_id.Trim() } elseif ($env:AUTO_DEV_SESSION_ID) { $env:AUTO_DEV_SESSION_ID.Trim() } else { '' }
$resolvedParentTaskId = if ($parent_task_id.Trim()) { $parent_task_id.Trim() } elseif ($env:AUTO_DEV_ACTIVE_TASK_ID) { $env:AUTO_DEV_ACTIVE_TASK_ID.Trim() } else { '' }
$resolvedRootTaskId = if ($root_task_id.Trim()) { $root_task_id.Trim() } elseif ($env:AUTO_DEV_ACTIVE_ROOT_TASK_ID) { $env:AUTO_DEV_ACTIVE_ROOT_TASK_ID.Trim() } else { '' }
$resolvedTaskId = Resolve-TaskId $task_id $resolvedFromAgent $to_role

if (-not $resolvedProjectId) { Write-ToolError 'LOCAL_PROJECT_CONTEXT_MISSING' 'AUTO_DEV_PROJECT_ID is missing.' 'Set AUTO_DEV_PROJECT_ID or pass -project_id.' }
if (-not $resolvedFromAgent) { Write-ToolError 'LOCAL_AGENT_CONTEXT_MISSING' 'AUTO_DEV_AGENT_ROLE is missing.' 'Set AUTO_DEV_AGENT_ROLE or pass -from_agent.' }
if (-not $title.Trim()) { Write-ToolError 'LOCAL_TITLE_REQUIRED' 'title cannot be empty.' 'Pass a short executable title.' }
if (-not $to_role.Trim()) { Write-ToolError 'LOCAL_TARGET_ROLE_REQUIRED' 'to_role cannot be empty.' 'Pass target owner role with -to_role.' }
if (-not $resolvedParentTaskId) {
  Write-ToolError 'LOCAL_PARENT_TASK_REQUIRED' 'parent_task_id is required.' 'Pass -parent_task_id or ensure AUTO_DEV_ACTIVE_TASK_ID is set.'
}

$body = @{
  action_type = 'TASK_CREATE'
  from_agent = $resolvedFromAgent
  from_session_id = if ($resolvedFromSessionId) { $resolvedFromSessionId } else { $null }
  task_id = $resolvedTaskId
  task_kind = 'EXECUTION'
  parent_task_id = $resolvedParentTaskId
  root_task_id = if ($resolvedRootTaskId) { $resolvedRootTaskId } else { $null }
  title = $title.Trim()
  owner_role = $to_role.Trim()
  priority = $priority
  dependencies = Split-Items $dependencies
  write_set = Split-Items $write_set
  acceptance = Split-Items $acceptance
  artifacts = Split-Items $artifacts
  content = if ($content.Trim()) { $content.Trim() } else { $null }
  parent_request_id = if ($env:AUTO_DEV_PARENT_REQUEST_ID) { $env:AUTO_DEV_PARENT_REQUEST_ID.Trim() } else { $null }
}

$uri = "$resolvedManagerUrl/api/projects/$resolvedProjectId/task-actions"

$maxRetries = 3
$retryDelay = 2
$timeoutSec = 5
$lastError = $null

$jsonBody = $body | ConvertTo-Json

# Use curl.exe via Process to avoid PowerShell hanging issues
for ($i = 0; $i -lt $maxRetries; $i++) {
  $tempFile = [System.IO.Path]::GetTempFileName() + ".json"
  $jsonBody | Out-File -FilePath $tempFile -Encoding UTF8
  
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = "curl.exe"
  $processInfo.Arguments = "-s -X POST `"$uri`" -H `"Content-Type: application/json`" --data-binary @`"$tempFile`""
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  $process.Start() | Out-Null
  
  $output = $process.StandardOutput.ReadToEnd()
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  
  Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
  
  if ($exitCode -eq 0 -and $output) {
    Write-Output $output
    exit 0
  }
  
  $lastError = "$exitCode : $output"
  if ($i -lt ($maxRetries - 1)) {
    Start-Sleep -Seconds $retryDelay
  }
}

$raw = $null
try {
  if ($lastError -match '^\d+\s*\{') {
    $raw = $lastError -replace '^\d+\s*', '' | ConvertFrom-Json -ErrorAction Stop
  }
} catch {}

if ($raw) {
  $code = if ($raw.error_code) { [string]$raw.error_code } elseif ($raw.error -and $raw.error.code) { [string]$raw.error.code } else { 'TASK_ACTION_REMOTE_ERROR' }
  $msg = if ($raw.error -and $raw.error.message) { [string]$raw.error.message } elseif ($raw.message) { [string]$raw.message } else { 'Task create/assign rejected by backend.' }
  $next = if ($raw.next_action) { [string]$raw.next_action } else { 'Check parent_task_id, route permission, and owner role; then retry once.' }
  Write-ToolError $code $msg $next $raw
}

Write-ToolError 'TASK_ACTION_TRANSPORT_ERROR' "Request failed: $lastError" 'Check backend health and AUTO_DEV_MANAGER_URL.'
