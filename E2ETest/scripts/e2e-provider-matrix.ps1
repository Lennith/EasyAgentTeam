$script:E2EDefaultAgentModels = @{
  codex = [ordered]@{
    provider_id = "codex"
    model = "gpt-5.4"
    effort = "medium"
  }
  minimax = [ordered]@{
    provider_id = "minimax"
    model = "MiniMax-M2.7-High-speed"
    effort = "high"
  }
}

function Get-E2EObjectString {
  param(
    [object]$Obj,
    [string[]]$Names
  )

  if (-not $Obj) {
    return $null
  }
  foreach ($name in $Names) {
    $prop = $Obj.PSObject.Properties[$name]
    if (-not $prop) {
      continue
    }
    $value = $prop.Value
    if ($null -eq $value) {
      continue
    }
    $text = [string]$value
    if ($text.Trim().Length -gt 0) {
      return $text.Trim()
    }
  }
  return $null
}

function Normalize-E2EProviderId {
  param(
    [object]$Raw,
    [string]$Fallback = "minimax"
  )

  if ($null -eq $Raw) {
    return $Fallback
  }
  $text = ([string]$Raw).Trim().ToLower()
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $Fallback
  }
  if ($text -eq "codex" -or $text -eq "minimax") {
    return $text
  }
  throw "Unsupported provider '$text'. Supported values: codex, minimax."
}

function Get-E2EDefaultAgentModelConfig {
  param([string]$ProviderId)

  $normalized = Normalize-E2EProviderId -Raw $ProviderId
  $preset = $script:E2EDefaultAgentModels[$normalized]
  if (-not $preset) {
    throw "Missing E2E default model preset for provider '$normalized'."
  }
  return [ordered]@{
    provider_id = [string]$preset.provider_id
    model = [string]$preset.model
    effort = [string]$preset.effort
  }
}

function Get-E2EUniqueStringValues {
  param([object[]]$Values)

  $set = New-Object System.Collections.Generic.HashSet[string]
  foreach ($value in @($Values)) {
    if ($null -eq $value) {
      continue
    }
    $text = ([string]$value).Trim()
    if ($text.Length -eq 0) {
      continue
    }
    [void]$set.Add($text)
  }
  return @($set | Sort-Object)
}

function Test-E2EObservedValueMatch {
  param(
    [string]$ExpectedValue,
    [object[]]$ObservedValues
  )

  $expected = if ($null -eq $ExpectedValue) { "" } else { ([string]$ExpectedValue).Trim() }
  if ([string]::IsNullOrWhiteSpace($expected)) {
    return $true
  }
  $observed = @(Get-E2EUniqueStringValues -Values $ObservedValues)
  if ($observed.Count -eq 0) {
    return $false
  }
  return (@($observed | Where-Object { $_ -ne $expected }).Count -eq 0)
}

function Get-E2ECodexObservedRunConfig {
  param([object[]]$Events)

  $models = New-Object System.Collections.Generic.List[string]
  $efforts = New-Object System.Collections.Generic.List[string]
  foreach ($event in @($Events)) {
    $payload = if ($event) { $event.payload } else { $null }
    $args = if ($payload -and $payload.args) { @($payload.args) } else { @() }
    for ($i = 0; $i -lt $args.Count; $i++) {
      $arg = [string]$args[$i]
      if ($arg -eq "--model" -and ($i + 1) -lt $args.Count) {
        $models.Add([string]$args[$i + 1])
        continue
      }
      $candidate = if ($arg -eq "--config" -and ($i + 1) -lt $args.Count) {
        [string]$args[$i + 1]
      } else {
        $arg
      }
      if ($candidate -match 'model_reasoning_effort\s*=\s*"?(?<effort>[A-Za-z0-9_-]+)"?') {
        $efforts.Add($Matches.effort.ToLower())
      }
    }
  }
  return [ordered]@{
    observed_models = @(Get-E2EUniqueStringValues -Values $models)
    observed_efforts = @(Get-E2EUniqueStringValues -Values $efforts)
  }
}

function Get-E2EMiniMaxObservedRunConfig {
  param([object[]]$Events)

  $models = New-Object System.Collections.Generic.List[string]
  foreach ($event in @($Events)) {
    $payload = if ($event) { $event.payload } else { $null }
    $model = Get-E2EObjectString -Obj $payload -Names @("model")
    if (-not [string]::IsNullOrWhiteSpace($model)) {
      $models.Add($model)
    }
  }
  return [ordered]@{
    observed_models = @(Get-E2EUniqueStringValues -Values $models)
    observed_efforts = @()
  }
}

function Get-E2EObservedRunConfigFromProviderObservations {
  param([object[]]$ObservationEvents)

  $models = New-Object System.Collections.Generic.List[string]
  $efforts = New-Object System.Collections.Generic.List[string]
  foreach ($event in @($ObservationEvents)) {
    $payload = if ($event) { $event.payload } else { $null }
    $details = if ($payload -and $payload.details) { $payload.details } else { $null }
    $model = Get-E2EObjectString -Obj $details -Names @("model")
    if (-not [string]::IsNullOrWhiteSpace($model)) {
      $models.Add($model)
    }
    $effort = Get-E2EObjectString -Obj $details -Names @("effort", "reasoning_effort")
    if (-not [string]::IsNullOrWhiteSpace($effort)) {
      $efforts.Add($effort.ToLower())
    }
  }
  return [ordered]@{
    observed_models = @(Get-E2EUniqueStringValues -Values $models)
    observed_efforts = @(Get-E2EUniqueStringValues -Values $efforts)
  }
}

function Resolve-E2ESingleAgentModel {
  param([object]$Scenario)

  $legacy = $Scenario.agent_model
  if (-not $legacy) {
    return Get-E2EDefaultAgentModelConfig -ProviderId "minimax"
  }
  $providerId = Normalize-E2EProviderId -Raw (Get-E2EObjectString -Obj $legacy -Names @("provider_id", "tool")) -Fallback "minimax"
  $preset = Get-E2EDefaultAgentModelConfig -ProviderId $providerId
  $model = Get-E2EObjectString -Obj $legacy -Names @("model")
  $effort = Get-E2EObjectString -Obj $legacy -Names @("effort")
  return [ordered]@{
    provider_id = $providerId
    model = if ($model) { $model } else { [string]$preset.model }
    effort = if ($effort) { $effort.ToLower() } else { [string]$preset.effort }
  }
}

function Resolve-E2ERoleModelMatrix {
  param(
    [Parameter(Mandatory = $true)][object]$Scenario,
    [Parameter(Mandatory = $true)][hashtable]$RoleByKey,
    [string]$ForcedProviderId = ""
  )

  $forced = if ([string]::IsNullOrWhiteSpace($ForcedProviderId)) {
    ""
  } else {
    Normalize-E2EProviderId -Raw $ForcedProviderId
  }
  $legacy = Resolve-E2ESingleAgentModel -Scenario $Scenario
  $matrixRaw = $Scenario.agent_model_matrix
  $resolvedByRoleKey = [ordered]@{}
  $resolvedByRoleId = [ordered]@{}
  $providers = New-Object System.Collections.Generic.HashSet[string]

  foreach ($entry in $RoleByKey.GetEnumerator()) {
    $roleKey = [string]$entry.Key
    $roleId = [string]$entry.Value
    if ([string]::IsNullOrWhiteSpace($roleKey) -or [string]::IsNullOrWhiteSpace($roleId)) {
      continue
    }

    $resolved = $null
    if ($forced) {
      $resolved = Get-E2EDefaultAgentModelConfig -ProviderId $forced
    } elseif ($matrixRaw) {
      $configRaw = $matrixRaw.PSObject.Properties[$roleKey]
      if (-not $configRaw) {
        throw "Scenario agent_model_matrix is missing role key '$roleKey'."
      }
      $providerId = Normalize-E2EProviderId -Raw (Get-E2EObjectString -Obj $configRaw.Value -Names @("provider_id", "tool")) -Fallback ([string]$legacy.provider_id)
      $preset = Get-E2EDefaultAgentModelConfig -ProviderId $providerId
      $model = Get-E2EObjectString -Obj $configRaw.Value -Names @("model")
      $effort = Get-E2EObjectString -Obj $configRaw.Value -Names @("effort")
      $resolved = [ordered]@{
        provider_id = $providerId
        model = if ($model) { $model } else { [string]$preset.model }
        effort = if ($effort) { $effort.ToLower() } else { [string]$preset.effort }
      }
    } else {
      $resolved = [ordered]@{
        provider_id = [string]$legacy.provider_id
        model = [string]$legacy.model
        effort = [string]$legacy.effort
      }
    }

    $resolvedByRoleKey[$roleKey] = [ordered]@{
      role_key = $roleKey
      role_id = $roleId
      provider_id = [string]$resolved.provider_id
      model = [string]$resolved.model
      effort = [string]$resolved.effort
    }
    $resolvedByRoleId[$roleId] = [ordered]@{
      role_key = $roleKey
      role_id = $roleId
      provider_id = [string]$resolved.provider_id
      model = [string]$resolved.model
      effort = [string]$resolved.effort
    }
    [void]$providers.Add([string]$resolved.provider_id)
  }

  return [pscustomobject]@{
    mode = if ($forced) { "forced_provider" } elseif ($matrixRaw) { "mixed_matrix" } else { "single_model" }
    forced_provider_id = if ($forced) { $forced } else { $null }
    by_role_key = $resolvedByRoleKey
    by_role_id = $resolvedByRoleId
    providers = @($providers | Sort-Object)
  }
}

function Assert-E2EMixedProviderBaseline {
  param(
    [Parameter(Mandatory = $true)][object]$ResolvedMatrix,
    [string]$CaseId = "e2e-case"
  )

  if ([string]$ResolvedMatrix.mode -eq "forced_provider") {
    return
  }

  $providers = @($ResolvedMatrix.providers | ForEach-Object { Normalize-E2EProviderId -Raw $_ } | Sort-Object -Unique)
  $expected = @("codex", "minimax")
  if (($providers.Count -ne $expected.Count) -or (@($providers | Where-Object { $expected -notcontains $_ }).Count -gt 0)) {
    throw ("{0} must resolve to the mixed baseline providers codex,minimax. actual={1}" -f $CaseId, ($providers -join ","))
  }
}

function Assert-E2EProvidersConfigured {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][object]$ResolvedMatrix
  )

  $settingsResp = Invoke-ApiJson -BaseUrl $BaseUrl -Method GET -Path "/api/settings" -AllowStatus @(200)
  $providers = if ($ResolvedMatrix.providers) { @($ResolvedMatrix.providers) } else { @() }
  foreach ($providerId in $providers) {
    if ($providerId -eq "minimax") {
      $minimaxKey = Get-E2EObjectString -Obj $settingsResp.body -Names @("minimaxApiKey", "minimax_api_key")
      if ([string]::IsNullOrWhiteSpace($minimaxKey)) {
        throw "MiniMax provider is not configured. settings.minimaxApiKey is empty."
      }
      continue
    }
    if ($providerId -eq "codex") {
      $codexCommand = Get-E2EObjectString -Obj $settingsResp.body -Names @("codexCliCommand", "codex_cli_command")
      if ([string]::IsNullOrWhiteSpace($codexCommand)) {
        $codexCommand = Get-E2EObjectString -Obj $settingsResp.body -Names @("codexCliCommandDefault", "codex_cli_command_default")
      }
      if ([string]::IsNullOrWhiteSpace($codexCommand)) {
        throw "Codex provider is not configured. settings.codexCliCommand is empty."
      }
      continue
    }
  }
  return $settingsResp
}
