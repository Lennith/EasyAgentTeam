param(
  [string]$from_agent = '',
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
$resolvedFromAgent = if ($from_agent.Trim()) { $from_agent.Trim() } elseif ($env:AUTO_DEV_AGENT_ROLE) { $env:AUTO_DEV_AGENT_ROLE.Trim() } else { '' }

if (-not $resolvedProjectId) { Write-ToolError 'LOCAL_PROJECT_CONTEXT_MISSING' 'AUTO_DEV_PROJECT_ID is missing.' 'Set AUTO_DEV_PROJECT_ID or pass -project_id.' }
if (-not $resolvedFromAgent) { Write-ToolError 'LOCAL_AGENT_CONTEXT_MISSING' 'AUTO_DEV_AGENT_ROLE is missing.' 'Set AUTO_DEV_AGENT_ROLE or pass -from_agent.' }

$uri = "$resolvedManagerUrl/api/projects/$resolvedProjectId/route-targets?from_agent=$([System.Uri]::EscapeDataString($resolvedFromAgent))"

$timeoutSec = 5

# Use curl.exe via Process to avoid PowerShell hanging issues
$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = "curl.exe"
$processInfo.Arguments = "-s -X GET `"$uri`" --max-time $timeoutSec"
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

if ($exitCode -eq 0 -and $output) {
  Write-Output $output
  exit 0
}

$transport = "exit code: $exitCode, output: $output"
Write-ToolError 'ROUTE_TARGETS_REQUEST_FAILED' "Request failed: $transport" 'Check manager health, project_id, and from_agent.'
