param(
  [Parameter(Mandatory=$true)][string]$to_role,
  [Parameter(Mandatory=$true)][string]$message,
  [Parameter(Mandatory=$true)][string]$thread_id,
  [string]$task_id = '',
  [int]$round = 1,
  [string]$in_reply_to = '',
  [string]$manager_url = '',
  [string]$project_id = ''
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

function Write-ToolError([string]$Code, [string]$Message, [string]$NextAction = '', [object]$Raw = $null) {
  $payload = @{ error_code = $Code; message = $Message; next_action = if ($NextAction) { $NextAction } else { $null }; raw = $Raw }
  $json = $payload | ConvertTo-Json -Depth 16
  [Console]::Error.WriteLine($json)
  Write-Output $json
  exit 2
}

$resolvedManagerUrl = if ($manager_url.Trim()) { $manager_url.Trim() } elseif ($env:AUTO_DEV_MANAGER_URL) { $env:AUTO_DEV_MANAGER_URL.Trim() } else { 'http://127.0.0.1:3000' }
$resolvedProjectId = if ($project_id.Trim()) { $project_id.Trim() } elseif ($env:AUTO_DEV_PROJECT_ID) { $env:AUTO_DEV_PROJECT_ID.Trim() } else { '' }
$resolvedRole = if ($env:AUTO_DEV_AGENT_ROLE) { $env:AUTO_DEV_AGENT_ROLE.Trim() } else { '' }
$resolvedSession = if ($env:AUTO_DEV_SESSION_ID) { $env:AUTO_DEV_SESSION_ID.Trim() } else { '' }
$resolvedTaskId = if ($task_id.Trim()) { $task_id.Trim() } elseif ($env:AUTO_DEV_ACTIVE_TASK_ID) { $env:AUTO_DEV_ACTIVE_TASK_ID.Trim() } else { '' }

if (-not $resolvedProjectId) { Write-ToolError 'LOCAL_PROJECT_CONTEXT_MISSING' 'AUTO_DEV_PROJECT_ID is missing.' 'Set AUTO_DEV_PROJECT_ID or pass -project_id.' }
if (-not $resolvedRole) { Write-ToolError 'LOCAL_AGENT_CONTEXT_MISSING' 'AUTO_DEV_AGENT_ROLE is missing.' 'Set AUTO_DEV_AGENT_ROLE before running script.' }
if (-not $resolvedSession) { Write-ToolError 'LOCAL_SESSION_CONTEXT_MISSING' 'AUTO_DEV_SESSION_ID is missing.' 'Set AUTO_DEV_SESSION_ID before running script.' }
if (-not $resolvedTaskId) { Write-ToolError 'LOCAL_TASK_CONTEXT_MISSING' 'No task_id was provided or found in environment.' 'Set AUTO_DEV_ACTIVE_TASK_ID or pass -task_id.' }
if (-not $to_role.Trim()) { Write-ToolError 'LOCAL_TARGET_REQUIRED' 'to_role cannot be empty.' 'Pass -to_role target role.' }
if (-not $message.Trim()) { Write-ToolError 'LOCAL_MESSAGE_REQUIRED' 'message cannot be empty.' 'Pass -message with concrete answer.' }
if (-not $thread_id.Trim()) { Write-ToolError 'LOCAL_THREAD_REQUIRED' 'thread_id is required for discuss reply.' 'Pass the original discuss thread_id.' }
if ($round -le 0) { $round = 1 }

$body = @{
  from_agent = $resolvedRole
  from_session_id = $resolvedSession
  to = @{ agent = $to_role.Trim() }
  content = $message.Trim()
  mode = 'CHAT'
  message_type = 'TASK_DISCUSS_REPLY'
  task_id = $resolvedTaskId
  parent_request_id = if ($env:AUTO_DEV_PARENT_REQUEST_ID) { $env:AUTO_DEV_PARENT_REQUEST_ID.Trim() } else { $null }
  discuss = @{ thread_id = $thread_id.Trim(); round = $round; in_reply_to = if ($in_reply_to.Trim()) { $in_reply_to.Trim() } else { $null } }
}

$uri = "$resolvedManagerUrl/api/projects/$resolvedProjectId/messages/send"

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
  $code = if ($raw.error_code) { [string]$raw.error_code } elseif ($raw.error -and $raw.error.code) { [string]$raw.error.code } else { 'DISCUSS_REMOTE_ERROR' }
  $msg = if ($raw.error -and $raw.error.message) { [string]$raw.error.message } elseif ($raw.message) { [string]$raw.message } else { 'Discuss reply rejected by backend.' }
  $nextAction = if ($raw.next_action) { [string]$raw.next_action } elseif ($raw.hint) { [string]$raw.hint } else { 'Check route target, thread_id, and round then retry once.' }
  Write-ToolError $code $msg $nextAction $raw
}

Write-ToolError 'DISCUSS_TRANSPORT_ERROR' "Request failed: $lastError" 'Check backend status and AUTO_DEV_MANAGER_URL.'
