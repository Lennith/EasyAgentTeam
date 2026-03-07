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
    [Parameter(Mandatory = $true)][string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
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
