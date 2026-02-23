param(
  [Parameter(Mandatory=$true)][string]$block_reason,
  [string]$progress_file = '',
  [string]$task_id = '',
  [string]$manager_url = '',
  [string]$project_id = ''
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

function Write-ToolError([string]$Code, [string]$Message, [string]$NextAction = '', [object]$Raw = $null) {
  $payload = @{ error_code = $Code; message = $Message; next_action = if ($NextAction) { $NextAction } else { $null }; raw = $Raw }
  $json = $payload | ConvertTo-Json
  [Console]::Error.WriteLine($json)
  Write-Output $json
  exit 2
}

function Resolve-NextAction([string]$Code) {
  switch ($Code) {
    'TASK_PROGRESS_REQUIRED' { return 'Update Agents/<role>/progress.md with blocker details and task_id, then retry.' }
    'TASK_RESULT_INVALID_TARGET' { return 'Verify task ownership/session and report only your assigned task.' }
    default { return 'Fix payload and retry once.' }
  }
}

$resolvedManagerUrl = if ($manager_url.Trim()) { $manager_url.Trim() } elseif ($env:AUTO_DEV_MANAGER_URL) { $env:AUTO_DEV_MANAGER_URL.Trim() } else { 'http://127.0.0.1:3000' }
$resolvedProjectId = if ($project_id.Trim()) { $project_id.Trim() } elseif ($env:AUTO_DEV_PROJECT_ID) { $env:AUTO_DEV_PROJECT_ID.Trim() } else { '' }
$resolvedRole = if ($env:AUTO_DEV_AGENT_ROLE) { $env:AUTO_DEV_AGENT_ROLE.Trim() } else { '' }
$resolvedSession = if ($env:AUTO_DEV_SESSION_ID) { $env:AUTO_DEV_SESSION_ID.Trim() } else { '' }
$resolvedTaskId = if ($task_id.Trim()) { $task_id.Trim() } elseif ($env:AUTO_DEV_ACTIVE_TASK_ID) { $env:AUTO_DEV_ACTIVE_TASK_ID.Trim() } else { '' }

if (-not $resolvedProjectId) { Write-ToolError 'LOCAL_PROJECT_CONTEXT_MISSING' 'AUTO_DEV_PROJECT_ID is missing.' 'Set AUTO_DEV_PROJECT_ID or pass -project_id.' }
if (-not $resolvedRole) { Write-ToolError 'LOCAL_AGENT_CONTEXT_MISSING' 'AUTO_DEV_AGENT_ROLE is missing.' 'Set AUTO_DEV_AGENT_ROLE before running script.' }
if (-not $resolvedSession) { Write-ToolError 'LOCAL_SESSION_CONTEXT_MISSING' 'AUTO_DEV_SESSION_ID is missing.' 'Set AUTO_DEV_SESSION_ID before running script.' }
if (-not $resolvedTaskId) { Write-ToolError 'LOCAL_TASK_CONTEXT_MISSING' 'No active task id found.' 'Set AUTO_DEV_ACTIVE_TASK_ID or pass -task_id.' }
if (-not $block_reason.Trim()) { Write-ToolError 'LOCAL_BLOCK_REASON_REQUIRED' 'block_reason cannot be empty.' 'Pass a concrete blocker reason.' }

$resolvedProgressFile = if ($progress_file.Trim()) { $progress_file.Trim() } else { '' }

$body = @{
  action_type = 'TASK_REPORT'
  from_agent = $resolvedRole
  from_session_id = $resolvedSession
  task_id = $resolvedTaskId
  parent_request_id = if ($env:AUTO_DEV_PARENT_REQUEST_ID) { $env:AUTO_DEV_PARENT_REQUEST_ID.Trim() } else { $null }
  report_mode = 'BLOCK'
  report_content = $block_reason.Trim()
  report_file = if ($resolvedProgressFile) { $resolvedProgressFile } else { $null }
  block_reason = $block_reason.Trim()
}

$uri = "$resolvedManagerUrl/api/projects/$resolvedProjectId/task-actions"

$maxRetries = 3
$retryDelay = 2
$timeoutSec = 5
$lastError = $null

$jsonBody = $body | ConvertTo-Json

# Use curl.exe via Process to avoid PowerShell hanging issues
for ($i = 0; $i -lt $maxRetries; $i++) {
  # Write JSON to temp file to avoid escaping issues
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

Write-ToolError 'TASK_ACTION_TRANSPORT_ERROR' "Request failed: $lastError" 'Check backend status and AUTO_DEV_MANAGER_URL.'
