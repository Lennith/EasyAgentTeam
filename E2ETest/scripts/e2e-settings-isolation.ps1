function Get-E2EServerDefaultMiniMaxModel {
  return "MiniMax-M2.5-High-speed"
}

function New-E2ESettingsIsolationState {
  param(
    [Parameter(Mandatory = $true)][object]$SettingsBody,
    [Parameter(Mandatory = $true)][object]$ResolvedMatrix,
    [string]$CaseId = "e2e",
    [switch]$AllowMiniMaxCredentialPatch,
    [string]$MiniMaxApiKeyOverride = "",
    [string]$MiniMaxApiBaseOverride = "",
    [switch]$ClearMiniMaxSettings
  )

  $providers = if ($ResolvedMatrix.providers) { @($ResolvedMatrix.providers) } else { @() }
  $hasMiniMax = $providers -contains "minimax"
  $targetMiniMaxModel = if ($hasMiniMax) {
    [string](Get-E2EDefaultAgentModelConfig -ProviderId "minimax").model
  } else {
    $null
  }

  $before = [ordered]@{
    minimaxApiKey = Get-E2EObjectString -Obj $SettingsBody -Names @("minimaxApiKey", "minimax_api_key")
    minimaxApiBase = Get-E2EObjectString -Obj $SettingsBody -Names @("minimaxApiBase", "minimax_api_base")
    minimaxModel = Get-E2EObjectString -Obj $SettingsBody -Names @("minimaxModel", "minimax_model")
  }

  $patch = [ordered]@{}
  $restorePatch = [ordered]@{}
  $changedKeys = New-Object System.Collections.Generic.List[string]
  $reasons = New-Object System.Collections.Generic.List[string]

  if ($hasMiniMax) {
    if ([string]$before.minimaxModel -ne $targetMiniMaxModel) {
      $patch["minimaxModel"] = $targetMiniMaxModel
      $restorePatch["minimaxModel"] = if ([string]::IsNullOrWhiteSpace([string]$before.minimaxModel)) {
        Get-E2EServerDefaultMiniMaxModel
      } else {
        [string]$before.minimaxModel
      }
      [void]$changedKeys.Add("minimaxModel")
      [void]$reasons.Add("align_minimax_model")
    }
  }

  if ($AllowMiniMaxCredentialPatch.IsPresent -and $hasMiniMax) {
    $shouldPatchCredentials =
      $ClearMiniMaxSettings.IsPresent -or
      -not [string]::IsNullOrWhiteSpace($MiniMaxApiKeyOverride) -or
      -not [string]::IsNullOrWhiteSpace($MiniMaxApiBaseOverride)

    if ($shouldPatchCredentials) {
      $targetApiKey = if ($ClearMiniMaxSettings.IsPresent) { $null } else {
        if ([string]::IsNullOrWhiteSpace($MiniMaxApiKeyOverride)) { [string]$before.minimaxApiKey } else { $MiniMaxApiKeyOverride.Trim() }
      }
      $targetApiBase = if ($ClearMiniMaxSettings.IsPresent) { $null } else {
        if ([string]::IsNullOrWhiteSpace($MiniMaxApiBaseOverride)) { [string]$before.minimaxApiBase } else { $MiniMaxApiBaseOverride.Trim() }
      }

      foreach ($item in @(
          @{ Key = "minimaxApiKey"; Target = $targetApiKey; Original = [string]$before.minimaxApiKey },
          @{ Key = "minimaxApiBase"; Target = $targetApiBase; Original = [string]$before.minimaxApiBase }
        )) {
        $normalizedOriginal = if ([string]::IsNullOrWhiteSpace([string]$item.Original)) { $null } else { [string]$item.Original }
        $normalizedTarget = if ([string]::IsNullOrWhiteSpace([string]$item.Target)) { $null } else { [string]$item.Target }
        if ($normalizedOriginal -ne $normalizedTarget) {
          $patch[$item.Key] = $normalizedTarget
          $restorePatch[$item.Key] = $normalizedOriginal
          [void]$changedKeys.Add([string]$item.Key)
        }
      }

      if ($ClearMiniMaxSettings.IsPresent) {
        [void]$reasons.Add("clear_minimax_credentials")
      }
      if (-not [string]::IsNullOrWhiteSpace($MiniMaxApiKeyOverride)) {
        [void]$reasons.Add("override_minimax_api_key")
      }
      if (-not [string]::IsNullOrWhiteSpace($MiniMaxApiBaseOverride)) {
        [void]$reasons.Add("override_minimax_api_base")
      }
    }
  }

  return [pscustomobject]@{
    case_id = $CaseId
    providers = @($providers)
    target_minimax_model = $targetMiniMaxModel
    effective_minimax_runtime_model = $targetMiniMaxModel
    before = $before
    patch = if ($changedKeys.Count -gt 0) { $patch } else { $null }
    restore_patch = if ($changedKeys.Count -gt 0) { $restorePatch } else { $null }
    restore_fallback_keys = @(
      if ($hasMiniMax -and [string]::IsNullOrWhiteSpace([string]$before.minimaxModel) -and $patch.Contains("minimaxModel")) {
        "minimaxModel"
      }
    )
    changed_keys = @($changedKeys)
    reasons = @(Get-E2EUniqueStringValues -Values $reasons)
    applied = $false
    restored = $false
    apply_verified = $false
    restore_verified = $false
    apply_failed = $false
    restore_failed = $false
    warnings = @()
  }
}

function New-E2ESettingsIsolationPlan {
  param(
    [Parameter(Mandatory = $true)][object]$SettingsBody,
    [Parameter(Mandatory = $true)][object]$ResolvedMatrix,
    [string]$CaseId = "e2e",
    [switch]$AllowMiniMaxCredentialPatch,
    [string]$MiniMaxApiKeyOverride = "",
    [string]$MiniMaxApiBaseOverride = "",
    [switch]$ClearMiniMaxSettings
  )

  return New-E2ESettingsIsolationState `
    -SettingsBody $SettingsBody `
    -ResolvedMatrix $ResolvedMatrix `
    -CaseId $CaseId `
    -AllowMiniMaxCredentialPatch:$AllowMiniMaxCredentialPatch.IsPresent `
    -MiniMaxApiKeyOverride $MiniMaxApiKeyOverride `
    -MiniMaxApiBaseOverride $MiniMaxApiBaseOverride `
    -ClearMiniMaxSettings:$ClearMiniMaxSettings.IsPresent
}

function Get-E2ESettingsIsolationAuditPayload {
  param(
    [object]$Plan,
    [object]$State
  )

  if (-not $State) {
    $State = $Plan
  }
  if (-not $State) {
    return $null
  }

  return [ordered]@{
    case_id = $State.case_id
    providers = @($State.providers)
    target_minimax_model = $State.target_minimax_model
    effective_minimax_runtime_model = $State.effective_minimax_runtime_model
    changed_keys = @($State.changed_keys)
    reasons = @($State.reasons)
    patch = $State.patch
    restore_patch = $State.restore_patch
    restore_fallback_keys = @($State.restore_fallback_keys)
    before = $State.before
    after_apply = $State.after_apply
    after_restore = $State.after_restore
    applied = [bool]$State.applied
    applied_at = $State.applied_at
    apply_verified = [bool]$State.apply_verified
    apply_failed = [bool]$State.apply_failed
    restored = [bool]$State.restored
    restored_at = $State.restored_at
    restore_verified = [bool]$State.restore_verified
    restore_failed = [bool]$State.restore_failed
    warnings = @($State.warnings)
  }
}

function Invoke-E2ESettingsIsolationApply {
  param(
    [string]$BaseUrl = "",
    [object]$Plan,
    [object]$State,
    [scriptblock]$PatchInvoker,
    [scriptblock]$GetInvoker,
    [scriptblock]$PatchSettings,
    [scriptblock]$GetSettings
  )

  if (-not $State) {
    $State = $Plan
  }
  if (-not $State -or -not $State.patch) {
    return $State
  }

  if (-not $PatchSettings -and $PatchInvoker) {
    $PatchSettings = $PatchInvoker
  }
  if (-not $GetSettings -and $GetInvoker) {
    $GetSettings = $GetInvoker
  }

  if (-not $PatchSettings) {
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
      throw "Invoke-E2ESettingsIsolationApply requires PatchSettings/GetSettings or BaseUrl."
    }
    $PatchSettings = {
      param($patch)
      Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/settings" -AllowStatus @(200) -Body $patch
    }.GetNewClosure()
  }
  if (-not $GetSettings) {
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
      throw "Invoke-E2ESettingsIsolationApply requires PatchSettings/GetSettings or BaseUrl."
    }
    $GetSettings = {
      Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/settings" -AllowStatus @(200)
    }.GetNewClosure()
  }

  & $PatchSettings $State.patch | Out-Null
  $State.applied = $true
  $State.applied_at = (Get-Date).ToString("o")

  $afterBody = (& $GetSettings).body
  $State.after_apply = [ordered]@{
    minimaxApiKey = Get-E2EObjectString -Obj $afterBody -Names @("minimaxApiKey", "minimax_api_key")
    minimaxApiBase = Get-E2EObjectString -Obj $afterBody -Names @("minimaxApiBase", "minimax_api_base")
    minimaxModel = Get-E2EObjectString -Obj $afterBody -Names @("minimaxModel", "minimax_model")
  }

  $applyVerified = $true
  foreach ($key in @($State.changed_keys)) {
    $expected = $State.patch[$key]
    $actual = $State.after_apply[$key]
    $normalizedExpected = if ($null -eq $expected) { "" } else { ([string]$expected).Trim() }
    $normalizedActual = if ($null -eq $actual) { "" } else { ([string]$actual).Trim() }
    if ($normalizedExpected -ne $normalizedActual) {
      $applyVerified = $false
      break
    }
  }
  $State.apply_verified = $applyVerified
  if (-not $applyVerified) {
    $State.apply_failed = $true
    throw ("Failed to verify E2E settings isolation apply for {0}. changed_keys={1}" -f $State.case_id, ($State.changed_keys -join ","))
  }

  return $State
}

function Invoke-E2ESettingsIsolationRestore {
  param(
    [string]$BaseUrl = "",
    [object]$Plan,
    [object]$State,
    [scriptblock]$PatchInvoker,
    [scriptblock]$GetInvoker,
    [scriptblock]$PatchSettings,
    [scriptblock]$GetSettings,
    [scriptblock]$OnWarning
  )

  if (-not $State) {
    $State = $Plan
  }
  if (-not $State -or -not $State.applied -or -not $State.restore_patch) {
    return $State
  }

  try {
    if (-not $PatchSettings -and $PatchInvoker) {
      $PatchSettings = $PatchInvoker
    }
    if (-not $GetSettings -and $GetInvoker) {
      $GetSettings = $GetInvoker
    }

    if (-not $PatchSettings) {
      if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        throw "Invoke-E2ESettingsIsolationRestore requires PatchSettings/GetSettings or BaseUrl."
      }
      $PatchSettings = {
        param($patch)
        Invoke-ApiJson -BaseUrl $BaseUrl -Method PATCH -Path "/api/settings" -AllowStatus @(200) -Body $patch
      }.GetNewClosure()
    }
    if (-not $GetSettings) {
      if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
        throw "Invoke-E2ESettingsIsolationRestore requires PatchSettings/GetSettings or BaseUrl."
      }
      $GetSettings = {
        Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/settings" -AllowStatus @(200)
      }.GetNewClosure()
    }

    & $PatchSettings $State.restore_patch | Out-Null
    $State.restored = $true
    $State.restored_at = (Get-Date).ToString("o")

    $afterBody = (& $GetSettings).body
    $State.after_restore = [ordered]@{
      minimaxApiKey = Get-E2EObjectString -Obj $afterBody -Names @("minimaxApiKey", "minimax_api_key")
      minimaxApiBase = Get-E2EObjectString -Obj $afterBody -Names @("minimaxApiBase", "minimax_api_base")
      minimaxModel = Get-E2EObjectString -Obj $afterBody -Names @("minimaxModel", "minimax_model")
    }

    $restoreVerified = $true
    foreach ($key in @($State.changed_keys)) {
      $expected = $State.restore_patch[$key]
      $actual = $State.after_restore[$key]
      $normalizedExpected = if ($null -eq $expected) { "" } else { ([string]$expected).Trim() }
      $normalizedActual = if ($null -eq $actual) { "" } else { ([string]$actual).Trim() }
      if ($normalizedExpected -ne $normalizedActual) {
        $restoreVerified = $false
        break
      }
    }
    $State.restore_verified = $restoreVerified
    if (-not $restoreVerified) {
      throw ("Failed to verify E2E settings isolation restore for {0}. changed_keys={1}" -f $State.case_id, ($State.changed_keys -join ","))
    }
  } catch {
    $State.restore_failed = $true
    $message = "settings_restore_failed: $($_.Exception.Message)"
    $State.warnings = @($State.warnings) + @($message)
    if ($OnWarning) {
      & $OnWarning $message
    } else {
      Write-Warning $message
    }
    throw
  }

  return $State
}
