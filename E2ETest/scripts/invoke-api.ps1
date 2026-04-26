$ErrorActionPreference = "Stop"

function Format-ApiErrorMessage {
  param(
    [Parameter(Mandatory = $true)][int]$Status,
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Raw = ""
  )

  $normalized = if ($null -eq $Raw) { "" } else { [string]$Raw }
  $normalized = ($normalized -replace "`r", " " -replace "`n", " ").Trim()
  if (-not $normalized) {
    $normalized = "(empty)"
  }
  return "HTTP $Status on $Method $Path response=$normalized"
}

function Invoke-ApiJson {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null,
    [int[]]$AllowStatus = @(200, 201)
  )

  $uri = "$BaseUrl$Path"
  $json = $null
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 100
  }

  try {
    if ($null -ne $json) {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method $Method -ContentType "application/json; charset=utf-8" -Body $json
    } else {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method $Method
    }
    $status = [int]$resp.StatusCode
    if ($AllowStatus -notcontains $status) {
      throw (Format-ApiErrorMessage -Status $status -Method $Method -Path $Path -Raw ([string]$resp.Content))
    }
    $raw = if ($resp.Content -is [byte[]]) {
      [System.Text.Encoding]::UTF8.GetString($resp.Content)
    } else {
      [string]$resp.Content
    }
    $bodyObj = $null
    if ($raw -and $raw.Trim().Length -gt 0) {
      try { $bodyObj = $raw | ConvertFrom-Json } catch {}
    }
    return [pscustomobject]@{ status = $status; body = $bodyObj; raw = $raw }
  } catch {
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $raw = $reader.ReadToEnd()
      $reader.Close()
      if ($AllowStatus -contains $status) {
        $bodyObj = $null
        if ($raw -and $raw.Trim().Length -gt 0) {
          try { $bodyObj = $raw | ConvertFrom-Json } catch {}
        }
        return [pscustomobject]@{ status = $status; body = $bodyObj; raw = $raw }
      }
      throw (Format-ApiErrorMessage -Status $status -Method $Method -Path $Path -Raw $raw)
    }
    throw
  }
}

function Invoke-ApiJsonWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null,
    [int[]]$AllowStatus = @(200, 201),
    [int[]]$RetryOnStatus = @(),
    [int]$MaxAttempts = 3,
    [int]$InitialDelayMs = 250,
    [switch]$RetryOnRequestFailure
  )

  if ($MaxAttempts -lt 1) {
    $MaxAttempts = 1
  }

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      $resp = Invoke-ApiJson -BaseUrl $BaseUrl -Method $Method -Path $Path -Body $Body -AllowStatus $AllowStatus
      $status = [int]$resp.status
      if (($RetryOnStatus -contains $status) -and $attempt -lt $MaxAttempts) {
        $delay = [Math]::Min(3000, $InitialDelayMs * [Math]::Pow(2, $attempt - 1))
        Write-Host ("retryable_response status={0} method={1} path={2} attempt={3}/{4}" -f $status, $Method, $Path, $attempt, $MaxAttempts)
        Start-Sleep -Milliseconds ([int]$delay)
        continue
      }
      if (($RetryOnStatus -contains $status) -and $attempt -ge $MaxAttempts) {
        throw (Format-ApiErrorMessage -Status $status -Method $Method -Path $Path -Raw ([string]$resp.raw))
      }
      return $resp
    } catch {
      if (-not $RetryOnRequestFailure.IsPresent -or $attempt -ge $MaxAttempts) {
        throw
      }
      $delay = [Math]::Min(3000, $InitialDelayMs * [Math]::Pow(2, $attempt - 1))
      Write-Host ("retryable_exception method={0} path={1} attempt={2}/{3} message={4}" -f $Method, $Path, $attempt, $MaxAttempts, [string]$_.Exception.Message)
      Start-Sleep -Milliseconds ([int]$delay)
    }
  }
}

function Get-EventsNdjson {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$ProjectId
  )
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/projects/$ProjectId/events" -Method Get
  $raw = if ($resp.Content -is [byte[]]) {
    [System.Text.Encoding]::UTF8.GetString($resp.Content)
  } else {
    [string]$resp.Content
  }
  $items = @()
  foreach ($line in ($raw -split "`r?`n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try { $items += ($trimmed | ConvertFrom-Json) } catch {}
  }
  return [pscustomobject]@{ raw = $raw; items = $items }
}

function Ensure-Dir {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content,
    [int]$RetryCount = 10,
    [int]$RetryDelayMs = 200
  )
  for ($attempt = 1; $attempt -le $RetryCount; $attempt++) {
    try {
      [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
      return
    } catch [System.IO.IOException] {
      if ($attempt -ge $RetryCount) { throw }
      Start-Sleep -Milliseconds $RetryDelayMs
    } catch [System.UnauthorizedAccessException] {
      if ($attempt -ge $RetryCount) { throw }
      Start-Sleep -Milliseconds $RetryDelayMs
    }
  }
}

function Resolve-WorkspaceRootSafePath {
  param([Parameter(Mandatory = $true)][string]$WorkspaceRoot)

  $trimmed = $WorkspaceRoot.Trim()
  if (-not $trimmed) {
    throw "WorkspaceRoot must not be empty."
  }

  $fullPath = [System.IO.Path]::GetFullPath($trimmed)
  $rootPath = [System.IO.Path]::GetPathRoot($fullPath)
  if (-not $rootPath) {
    throw "WorkspaceRoot must be an absolute path: '$WorkspaceRoot'"
  }

  $normalizedRoot = $rootPath.TrimEnd('\').ToLowerInvariant()
  $normalizedFull = $fullPath.TrimEnd('\').ToLowerInvariant()

  if ($normalizedFull -eq $normalizedRoot) {
    throw "Refuse to clean drive/share root path: '$fullPath'"
  }

  $relativePart = $fullPath.Substring($rootPath.Length).TrimStart('\')
  $segments = @($relativePart -split '[\\/]' | Where-Object { $_.Trim().Length -gt 0 })
  if ($segments.Count -lt 3) {
    throw "Refuse to clean high-risk path '$fullPath'. Workspace path must include at least 3 segments under root."
  }

  if (Test-Path -LiteralPath (Join-Path $fullPath ".git")) {
    throw "Refuse to clean git repository root '$fullPath'."
  }

  return $fullPath
}

function Convert-ToWorkspacePathKey {
  param([string]$Path)

  $trimmed = ([string]$Path).Trim()
  if (-not $trimmed) {
    return ""
  }
  try {
    return ([System.IO.Path]::GetFullPath($trimmed)).TrimEnd('\').ToLowerInvariant()
  } catch {
    return $trimmed.TrimEnd('\').ToLowerInvariant()
  }
}

function Resolve-WorkspaceRootFromContextBase64 {
  param([string]$CommandLine)

  $line = ([string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($line)) {
    return ""
  }

  $patterns = @(
    "context-base64['`"]\s*,\s*['`"](?<b64>[A-Za-z0-9+/=]+)",
    "--context-base64\s+['`"]?(?<b64>[A-Za-z0-9+/=]+)['`"]?",
    "context-base64=(?<b64>[A-Za-z0-9+/=]+)"
  )

  foreach ($pattern in $patterns) {
    $match = [regex]::Match($line, $pattern)
    if (-not $match.Success) {
      continue
    }
    $b64 = [string]$match.Groups["b64"].Value
    if ([string]::IsNullOrWhiteSpace($b64)) {
      continue
    }

    try {
      $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
      $obj = $json | ConvertFrom-Json -ErrorAction Stop
      $workspaceRoot = ""
      if ($obj -and $obj.PSObject.Properties["workspaceRoot"]) {
        $workspaceRoot = [string]$obj.workspaceRoot
      } elseif ($obj -and $obj.PSObject.Properties["workspace_root"]) {
        $workspaceRoot = [string]$obj.workspace_root
      }
      $normalized = Convert-ToWorkspacePathKey -Path $workspaceRoot
      if (-not [string]::IsNullOrWhiteSpace($normalized)) {
        return $normalized
      }
    } catch {
      continue
    }
  }

  return ""
}

function Stop-ProcessTreeBestEffort {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  if ($ProcessId -le 0) {
    return
  }

  if ($env:OS -eq "Windows_NT") {
    try {
      & taskkill /PID $ProcessId /T /F | Out-Null
      return
    } catch {}
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  } catch {}
}

function Stop-WorkspaceBoundProcesses {
  param([Parameter(Mandatory = $true)][string]$WorkspaceRoot)

  $safeRoot = Resolve-WorkspaceRootSafePath -WorkspaceRoot $WorkspaceRoot
  $needle = Convert-ToWorkspacePathKey -Path $safeRoot
  if ([string]::IsNullOrWhiteSpace($needle)) {
    return
  }

  $candidateProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -match 'codex|node|powershell' -and
    -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine)
  }
  $matches = @()
  foreach ($proc in @($candidateProcesses)) {
    $commandLine = [string]$proc.CommandLine
    $directMatch = $commandLine.ToLowerInvariant().Contains($needle)
    if ($directMatch) {
      $matches += $proc
      continue
    }
    $contextWorkspace = Resolve-WorkspaceRootFromContextBase64 -CommandLine $commandLine
    if ($contextWorkspace -eq $needle) {
      $matches += $proc
    }
  }

  $uniqueIds = @($matches | Select-Object -ExpandProperty ProcessId -Unique)

  foreach ($procId in $uniqueIds) {
    Stop-ProcessTreeBestEffort -ProcessId ([int]$procId)
  }

  if ($uniqueIds.Count -gt 0) {
    Start-Sleep -Milliseconds 500
  }
}

function Remove-WorkspaceRuntimeArtifacts {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )
  $safeRoot = Resolve-WorkspaceRootSafePath -WorkspaceRoot $WorkspaceRoot
  Ensure-Dir -Path $safeRoot
  $targets = @(
    ".minimax",
    "Agents",
    "TeamTools",
    "TeamsTools"
  )
  foreach ($name in $targets) {
    $targetPath = Join-Path $safeRoot $name
    if (Test-Path -LiteralPath $targetPath) {
      Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
  }
}

function Reset-WorkspaceDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )
  $safeRoot = Resolve-WorkspaceRootSafePath -WorkspaceRoot $WorkspaceRoot
  Stop-WorkspaceBoundProcesses -WorkspaceRoot $safeRoot
  if (Test-Path -LiteralPath $safeRoot) {
    for ($attempt = 1; $attempt -le 4; $attempt++) {
      try {
        Get-ChildItem -LiteralPath $safeRoot -Force | ForEach-Object {
          Remove-Item -LiteralPath $_.FullName -Recurse -Force
        }
        break
      } catch {
        if ($attempt -ge 4) {
          throw
        }
        Stop-WorkspaceBoundProcesses -WorkspaceRoot $safeRoot
        Start-Sleep -Milliseconds (400 * $attempt)
      }
    }
  } else {
    New-Item -ItemType Directory -Path $safeRoot | Out-Null
  }
}

function Remove-ProjectWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [int]$MaxAttempts = 6,
    [int]$InitialDelayMs = 400
  )

  $lastStatus = -1
  $lastRaw = ""
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $deleteResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method DELETE -Path "/api/projects/$ProjectId" -AllowStatus @(200, 404, 409, 500)
    $lastStatus = [int]$deleteResp.status
    $lastRaw = [string]$deleteResp.raw
    if ($lastStatus -eq 200 -or $lastStatus -eq 404) {
      return [pscustomobject]@{
        status = $lastStatus
        attempts = $attempt
      }
    }

    try {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/projects/$ProjectId/orchestrator/settings" -AllowStatus @(200, 404) -Body @{
        auto_dispatch_enabled = $false
        auto_dispatch_remaining = 0
      } | Out-Null
    } catch {}

    try {
      $sessionsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/projects/$ProjectId/sessions" -AllowStatus @(200, 404)
      if ([int]$sessionsResp.status -eq 200 -and $sessionsResp.body -and $sessionsResp.body.items) {
        foreach ($session in @($sessionsResp.body.items)) {
          $sessionId = [string]$session.sessionId
          if ([string]::IsNullOrWhiteSpace($sessionId)) {
            continue
          }
          try {
            Invoke-ApiJson -BaseUrl $BaseUrl -Method POST -Path "/api/projects/$ProjectId/sessions/$sessionId/dismiss" -AllowStatus @(200, 404, 409) | Out-Null
          } catch {}
        }
      }
    } catch {}

    if ($attempt -lt $MaxAttempts) {
      $delay = [Math]::Min(4000, $InitialDelayMs * [Math]::Pow(2, $attempt - 1))
      Start-Sleep -Milliseconds ([int]$delay)
    }
  }

  throw "Failed to remove project '$ProjectId' after $MaxAttempts attempts (lastStatus=$lastStatus). response=$lastRaw"
}
