$ErrorActionPreference = "Stop"

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
      throw "Unexpected status $status for $Method $Path`n$([string]$resp.Content)"
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
      throw "HTTP $status on $Method $Path`n$raw"
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
        throw "HTTP $status on $Method $Path after $MaxAttempts attempts`n$([string]$resp.raw)"
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

  if (Test-Path -LiteralPath $safeRoot) {
    Get-ChildItem -LiteralPath $safeRoot -Force | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
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
