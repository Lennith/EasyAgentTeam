param(
  [string]$BaseUrl = "http://127.0.0.1:43123",
  [string]$SourceConfigPath = "D:/MinimaxTest/config.yaml",
  [string]$DpAgentRoot = "D:/work/MiniMaxAgentNodeJs",
  [string]$WorkspaceRoot = "D:/AgentWorkSpace/TestTeam/TestWorkflowTriProvider",
  [int]$AutoDispatchBudget = 30,
  [int]$MaxMinutes = 90,
  [int]$PollSeconds = 5,
  [int]$AutoTopupStep = 30,
  [int]$MaxTopups = 10,
  [int]$MaxTotalBudget = 330,
  [switch]$SetupOnly
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$scenarioPath = Join-Path $repoRoot "E2ETest\scenarios\workflow-gesture-mix-dpagent.json"
$workflowRunner = Join-Path $scriptDir "run-workflow-e2e.ps1"
$syncHelper = Join-Path $scriptDir "sync-dpagent-dev-config.mjs"
$dpagentWrapper = Join-Path $scriptDir "dpagent-dev-wrapper.cmd"
$backendBootstrap = Join-Path $repoRoot "tools\e2e-backend-bootstrap.ps1"

. (Join-Path $scriptDir "invoke-api.ps1")
. $backendBootstrap

function Get-ProviderProfileValue {
  param(
    [object]$SettingsBody,
    [string]$ProviderId,
    [string]$Name
  )
  if (-not $SettingsBody -or -not $SettingsBody.providers) {
    return $null
  }
  $profile = $SettingsBody.providers.PSObject.Properties[$ProviderId]
  if (-not $profile -or -not $profile.Value) {
    return $null
  }
  $prop = $profile.Value.PSObject.Properties[$Name]
  if (-not $prop) {
    return $null
  }
  return $prop.Value
}

function Test-DpAgentBackendReady {
  param([string]$Url)
  try {
    $resp = Invoke-WebRequest -Uri "$Url/api/auth/status" -UseBasicParsing -TimeoutSec 3
    return ([int]$resp.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Test-DpAgentDistExecSupported {
  param([string]$Root)

  $entry = Join-Path $Root "dist\cli\dpagent.js"
  if (-not (Test-Path -LiteralPath $entry)) {
    return $false
  }
  $entryText = Get-Content -LiteralPath $entry -Raw
  return ($entryText -match "runDpagentExec" -and $entryText -match "command === 'exec'")
}

function Resolve-DpAgentCliLaunch {
  param([string]$Root)

  $sourceEntry = Join-Path $Root "src\cli\dpagent.ts"
  $tsxEntry = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
  if ((Test-Path -LiteralPath $sourceEntry) -and (Test-Path -LiteralPath $tsxEntry)) {
    return [pscustomobject]@{
      Mode = "dev-source"
      FilePath = (Get-Command node.exe -ErrorAction Stop).Source
      Arguments = @($tsxEntry, $sourceEntry)
    }
  }

  $distEntry = Join-Path $Root "dist\cli\dpagent.js"
  if (Test-DpAgentDistExecSupported -Root $Root) {
    return [pscustomobject]@{
      Mode = "dist"
      FilePath = (Get-Command node.exe -ErrorAction Stop).Source
      Arguments = @($distEntry)
    }
  }

  throw "DPAgent dev source is unavailable and dist does not support exec under $Root. Run npm install or npm run build in the DPAgent repo before running this E2E."
}

function Resolve-DpAgentBackendLaunch {
  param([string]$Root)

  $serverEntry = Join-Path $Root "src\web\server\index.ts"
  $tsxEntry = Join-Path $Root "node_modules\tsx\dist\cli.mjs"
  if ((Test-Path -LiteralPath $serverEntry) -and (Test-Path -LiteralPath $tsxEntry)) {
    return [pscustomobject]@{
      Mode = "dev-server"
      FilePath = (Get-Command node.exe -ErrorAction Stop).Source
      Arguments = @($tsxEntry, $serverEntry)
    }
  }

  $distEntry = Join-Path $Root "dist\cli\dpagent.js"
  if (Test-Path -LiteralPath $distEntry) {
    return [pscustomobject]@{
      Mode = "dist-cli"
      FilePath = (Get-Command node.exe -ErrorAction Stop).Source
      Arguments = @($distEntry, "--no-open")
    }
  }

  throw "DPAgent backend source and dist entry are both unavailable under $Root. Run npm install or npm run build in the DPAgent repo before running this E2E."
}

function Wait-DpAgentBackendReady {
  param(
    [string]$Url,
    [int]$TimeoutSeconds = 60
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-DpAgentBackendReady -Url $Url) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-DpAgentBackendIfNeeded {
  param(
    [string]$Root,
    [string]$Workspace
  )
  $url = "http://localhost:53721"
  $handle = [pscustomobject]@{
    StartedByScript = $false
    Process = $null
    Url = $url
    StdoutPath = ""
    StderrPath = ""
  }
  if (Test-DpAgentBackendReady -Url $url) {
    Write-Host "DPAgent backend is already available: $url"
    return $handle
  }

  $launch = Resolve-DpAgentBackendLaunch -Root $Root

  $logDir = Join-Path $Workspace "docs\e2e\dpagent-backend"
  Ensure-Dir -Path $logDir
  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $stdoutPath = Join-Path $logDir "dpagent_stdout_$stamp.log"
  $stderrPath = Join-Path $logDir "dpagent_stderr_$stamp.log"
  $previousAllowMissingKey = $env:DPAGENT_ALLOW_MISSING_API_KEY_AT_BOOT
  $previousPort = $env:DPAGENT_PORT
  try {
    $env:DPAGENT_ALLOW_MISSING_API_KEY_AT_BOOT = "1"
    $env:DPAGENT_PORT = "53721"
    $proc = Start-Process `
      -FilePath $launch.FilePath `
      -ArgumentList $launch.Arguments `
      -WorkingDirectory $Root `
      -PassThru `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath
  } finally {
    if ($null -eq $previousAllowMissingKey) {
      Remove-Item Env:\DPAGENT_ALLOW_MISSING_API_KEY_AT_BOOT -ErrorAction SilentlyContinue
    } else {
      $env:DPAGENT_ALLOW_MISSING_API_KEY_AT_BOOT = $previousAllowMissingKey
    }
    if ($null -eq $previousPort) {
      Remove-Item Env:\DPAGENT_PORT -ErrorAction SilentlyContinue
    } else {
      $env:DPAGENT_PORT = $previousPort
    }
  }

  if (-not (Wait-DpAgentBackendReady -Url $url -TimeoutSeconds 90)) {
    if ($proc -and -not $proc.HasExited) {
      Stop-ProcessTree -ProcessId $proc.Id
    }
    $stdoutTail = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Tail 30 | Out-String } else { "" }
    $stderrTail = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Tail 30 | Out-String } else { "" }
    throw "DPAgent backend bootstrap failed. stdout=$stdoutPath`n$stdoutTail`nstderr=$stderrPath`n$stderrTail"
  }

  $handle.StartedByScript = $true
  $handle.Process = $proc
  $handle.StdoutPath = $stdoutPath
  $handle.StderrPath = $stderrPath
  Write-Host "DPAgent backend is ready. mode=$($launch.Mode) pid=$($proc.Id)"
  return $handle
}

function Get-RedactedE2EText {
  param([string]$Text = "")
  $cloudProviderKeyPattern = "sk" + "-cp-[A-Za-z0-9_-]+"
  $genericKeyPattern = "sk" + "-[A-Za-z0-9_-]{20,}"
  return $Text -replace $cloudProviderKeyPattern, "***redacted***" -replace $genericKeyPattern, "***redacted***"
}

function Invoke-DpAgentCredentialSmoke {
  param(
    [string]$WrapperPath,
    [string]$Workspace
  )

  $smokeWorkspace = Join-Path $Workspace ".dpagent-smoke"
  Ensure-Dir -Path $smokeWorkspace
  $prompt = "Reply with exactly DPAGENT_CREDENTIAL_SMOKE_DONE."
  $cmd = $env:ComSpec
  if ([string]::IsNullOrWhiteSpace($cmd)) {
    $cmd = "C:\Windows\System32\cmd.exe"
  }
  $cmdArgs = @("/d", "/c", "call", $WrapperPath, "exec", "--json", "--workspace", $smokeWorkspace)
  $output = @($prompt | & $cmd @cmdArgs 2>&1)
  $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
  if ($exitCode -eq 0) {
    Write-Host "DPAgent credential smoke passed."
    return
  }

  $errorMessages = New-Object System.Collections.Generic.List[string]
  foreach ($line in $output) {
    $text = [string]$line
    if (-not $text.Trim().StartsWith("{")) {
      continue
    }
    try {
      $event = $text | ConvertFrom-Json
      if ($event.type -eq "error" -and -not [string]::IsNullOrWhiteSpace([string]$event.message)) {
        [void]$errorMessages.Add([string]$event.message)
      }
    } catch {
      # Keep raw tail below when the line is not valid JSON.
    }
  }
  $message = if ($errorMessages.Count -gt 0) {
    ($errorMessages | Select-Object -Last 2) -join " | "
  } else {
    ($output | Select-Object -Last 8) -join "`n"
  }
  $message = Get-RedactedE2EText -Text $message
  throw "DPAgent credential smoke failed with exit code $exitCode. $message"
}

function Stop-DpAgentBackendIfStarted {
  param($Handle)
  if ($Handle -and $Handle.StartedByScript -and $Handle.Process -and -not $Handle.Process.HasExited) {
    Write-Host "Stopping DPAgent backend process tree pid=$($Handle.Process.Id)"
    Stop-ProcessTree -ProcessId $Handle.Process.Id
  }
}

function Invoke-SettingsPatch {
  param([object]$Patch)
  Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/settings" -AllowStatus @(200) -Body $Patch | Out-Null
}

function Get-SettingsBody {
  return (Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/settings" -AllowStatus @(200)).body
}

if (-not (Test-Path -LiteralPath $scenarioPath)) {
  throw "Missing workflow mix DPAgent scenario: $scenarioPath"
}
if (-not (Test-Path -LiteralPath $workflowRunner)) {
  throw "Missing workflow E2E runner: $workflowRunner"
}
if (-not (Test-Path -LiteralPath $syncHelper)) {
  throw "Missing DPAgent config sync helper: $syncHelper"
}
if (-not (Test-Path -LiteralPath $dpagentWrapper)) {
  throw "Missing DPAgent dev wrapper: $dpagentWrapper"
}

$backendHandle = $null
$dpagentHandle = $null
$restorePatch = $null
$exitCode = 1

try {
  Ensure-Dir -Path $WorkspaceRoot
  $syncOutput = & node $syncHelper $SourceConfigPath $DpAgentRoot --include-secrets
  if ($LASTEXITCODE -ne 0) {
    throw "DPAgent config sync failed."
  }
  $sync = $syncOutput | ConvertFrom-Json
  Write-Host ("DPAgent config synced: profiles={0} default_kimi_model={1}" -f $sync.profileCount, $sync.kimi.defaultModel)
  $dpagentLaunch = Resolve-DpAgentCliLaunch -Root $DpAgentRoot
  Write-Host ("DPAgent CLI launch mode: {0}" -f $dpagentLaunch.Mode)

  $dpagentHandle = Start-DpAgentBackendIfNeeded -Root $DpAgentRoot -Workspace $WorkspaceRoot
  Invoke-DpAgentCredentialSmoke -WrapperPath $dpagentWrapper -Workspace $WorkspaceRoot
  $backendHandle = Ensure-E2EBackend -BaseUrl $BaseUrl -RepoRoot $repoRoot -BootstrapLabel "workflow-mix-dpagent-e2e" -TimeoutSeconds 60

  $beforeSettings = Get-SettingsBody
  $beforeDpAgentCli = [string](Get-ProviderProfileValue -SettingsBody $beforeSettings -ProviderId "dpagent" -Name "cliCommand")
  if ([string]::IsNullOrWhiteSpace($beforeDpAgentCli)) {
    $beforeDpAgentCli = "dpagent"
  }
  $beforeMiniMax = [ordered]@{
    apiKey = Get-ProviderProfileValue -SettingsBody $beforeSettings -ProviderId "minimax" -Name "apiKey"
    apiBase = Get-ProviderProfileValue -SettingsBody $beforeSettings -ProviderId "minimax" -Name "apiBase"
    model = Get-ProviderProfileValue -SettingsBody $beforeSettings -ProviderId "minimax" -Name "model"
  }

  $restorePatch = [ordered]@{
    providers = [ordered]@{
      dpagent = [ordered]@{ cliCommand = $beforeDpAgentCli }
      minimax = [ordered]@{
        apiKey = $beforeMiniMax.apiKey
        apiBase = $beforeMiniMax.apiBase
        model = $beforeMiniMax.model
      }
    }
  }

  Invoke-SettingsPatch -Patch ([ordered]@{
      providers = [ordered]@{
        dpagent = [ordered]@{ cliCommand = $dpagentWrapper }
        minimax = [ordered]@{
          apiKey = [string]$sync.minimax.apiKey
          apiBase = [string]$sync.minimax.apiBase
          model = [string]$sync.minimax.defaultModel
        }
      }
    })

  $workflowArgs = @(
    "-ExecutionPolicy", "Bypass",
    "-File", $workflowRunner,
    "-BaseUrl", $BaseUrl,
    "-ScenarioPath", $scenarioPath,
    "-WorkspaceRoot", $WorkspaceRoot,
    "-AutoDispatchBudget", "$AutoDispatchBudget",
    "-MaxMinutes", "$MaxMinutes",
    "-PollSeconds", "$PollSeconds",
    "-AutoTopupStep", "$AutoTopupStep",
    "-MaxTopups", "$MaxTopups",
    "-MaxTotalBudget", "$MaxTotalBudget"
  )
  if ($SetupOnly) {
    $workflowArgs += "-SetupOnly"
  }

  Write-Host "== Workflow mix DPAgent E2E start =="
  Write-Host ("scenario={0}" -f $scenarioPath)
  Write-Host ("workspace={0}" -f $WorkspaceRoot)
  $output = @(& powershell @workflowArgs 2>&1)
  $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
  foreach ($line in $output) {
    Write-Host $line
  }
} finally {
  if ($restorePatch) {
    try {
      Invoke-SettingsPatch -Patch $restorePatch
      Write-Host "EAT runtime settings restored."
    } catch {
      Write-Warning ("Failed to restore EAT runtime settings: {0}" -f $_.Exception.Message)
    }
  }
  Stop-DpAgentBackendIfStarted -Handle $dpagentHandle
  Stop-E2EBackend -Handle $backendHandle
}

exit $exitCode
