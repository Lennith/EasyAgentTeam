param(
  [ValidateSet('acquire','renew','release','list')][string]$action = 'acquire',
  [string]$lock_content_path = '',
  [ValidateSet('file','dir')][string]$target_type = 'file',
  [int]$ttl_seconds = 1800,
  [string]$purpose = '',
  [string]$session_id = '',
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

function Normalize-LockKey([string]$Raw) {
  if (-not $Raw) { return '' }
  $v = $Raw.Trim() -replace '\\','/'
  while ($v.StartsWith('./')) { $v = $v.Substring(2) }
  return $v.Trim('/')
}

function Invoke-CurlRequest([string]$method, [string]$uri, [string]$bodyJson) {
  $timeoutSec = 5
  
  if ($bodyJson) {
    $tempFile = [System.IO.Path]::GetTempFileName() + ".json"
    $bodyJson | Out-File -FilePath $tempFile -Encoding UTF8
    
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = "curl.exe"
    $processInfo.Arguments = "-s -X $method `"$uri`" -H `"Content-Type: application/json`" --data-binary @`"$tempFile`" --max-time $timeoutSec"
  } else {
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = "curl.exe"
    $processInfo.Arguments = "-s -X $method `"$uri`" --max-time $timeoutSec"
  }
  
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
  
  if ($bodyJson) {
    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
  }
  
  return @{ exitCode = $exitCode; output = $output }
}

$resolvedManagerUrl = if ($manager_url.Trim()) { $manager_url.Trim() } elseif ($env:AUTO_DEV_MANAGER_URL) { $env:AUTO_DEV_MANAGER_URL.Trim() } else { 'http://127.0.0.1:3000' }
$resolvedProjectId = if ($project_id.Trim()) { $project_id.Trim() } elseif ($env:AUTO_DEV_PROJECT_ID) { $env:AUTO_DEV_PROJECT_ID.Trim() } else { '' }
$resolvedSessionId = if ($session_id.Trim()) { $session_id.Trim() } elseif ($env:AUTO_DEV_SESSION_ID) { $env:AUTO_DEV_SESSION_ID.Trim() } else { '' }
$key = Normalize-LockKey $lock_content_path

if (-not $resolvedProjectId) { Write-ToolError 'LOCAL_PROJECT_CONTEXT_MISSING' 'AUTO_DEV_PROJECT_ID is missing.' 'Set AUTO_DEV_PROJECT_ID or pass -project_id.' }
$baseUri = "$resolvedManagerUrl/api/projects/$resolvedProjectId/locks"

if ($action -eq 'list') {
  $result = Invoke-CurlRequest "GET" $baseUri ""
  if ($result.exitCode -eq 0 -and $result.output) {
    Write-Output $result.output
    exit 0
  }
  Write-ToolError 'LOCK_REQUEST_FAILED' "Request failed: $($result.output)" 'Check manager health and project_id.'
}

if (-not $resolvedSessionId) { Write-ToolError 'LOCAL_SESSION_CONTEXT_MISSING' 'AUTO_DEV_SESSION_ID is missing.' 'Set AUTO_DEV_SESSION_ID or pass -session_id.' }
if (-not $key) { Write-ToolError 'LOCAL_LOCK_KEY_REQUIRED' 'lock_content_path is required.' 'Pass relative path like src/module/file.ts.' }

$subUri = $baseUri + "/" + $action
$body = $null

if ($action -eq 'acquire') {
  $body = @{ session_id = $resolvedSessionId; lock_key = $key; target_type = $target_type; ttl_seconds = $ttl_seconds; purpose = if ($purpose.Trim()) { $purpose.Trim() } else { $null } }
} else {
  $body = @{ session_id = $resolvedSessionId; lock_key = $key }
}

$bodyJson = $body | ConvertTo-Json
$result = Invoke-CurlRequest "POST" $subUri $bodyJson

if ($result.exitCode -eq 0 -and $result.output) {
  Write-Output $result.output
  exit 0
}

$raw = $null
try {
  if ($result.output -match '^\{') {
    $raw = $result.output | ConvertFrom-Json -ErrorAction Stop
  }
} catch {}

if ($raw) {
  $code = if ($raw.error_code) { [string]$raw.error_code } elseif ($raw.error -and $raw.error.code) { [string]$raw.error.code } else { 'LOCK_REQUEST_FAILED' }
  $msg = if ($raw.error -and $raw.error.message) { [string]$raw.error.message } elseif ($raw.message) { [string]$raw.message } else { 'Lock request rejected by backend.' }
  $nextAction = if ($raw.next_action) { [string]$raw.next_action } else { 'Check session_id and lock_content_path, then retry once.' }
  Write-ToolError $code $msg $nextAction $raw
}

Write-ToolError 'LOCK_TRANSPORT_ERROR' "Request failed: $($result.output)" 'Check backend status and AUTO_DEV_MANAGER_URL.'
