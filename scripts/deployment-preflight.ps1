param(
  [string]$RepoRoot = "",
  [ValidateSet('PreSwitch', 'PostSwitch')][string]$Phase = 'PreSwitch',
  [Parameter(Mandatory=$true)][ValidateSet('LocalLoopback', 'ReverseProxyHttps')][string]$Topology,
  [string]$EnvironmentFile = "",
  [string]$AllowedOrigins = "",
  [string]$SessionCookieSecure = "",
  [string]$TrustedProxyCidrs = "",
  [string]$NoRollbackAcceptanceEvidence = "",
  [string]$ReleaseValidationToken = "",
  [string]$VerificationEvidencePath = "",
  [string]$RollbackManifestPath = "",
  [string]$RuntimeInspectionFixturePath = "",
  [switch]$ValidateRunningServices,
  [switch]$RequirePm2Node22,
  [switch]$CheckOnly,
  [string]$FrontendDistPath = ""
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if ($RuntimeInspectionFixturePath -and $env:NEXO_PREFLIGHT_TEST_FIXTURES -ne '1') { throw 'Runtime inspection fixtures are restricted to executable tests.' }

$ExpectedNodeVersion = 'v22.23.1'
$ExpectedNodeSha256 = 'f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed'
$RequiredEnvironmentNames = @('SUPABASE_URL', 'SALESFORCE_CLIENT_ID')
$RuntimeRoot = Join-Path $RepoRoot '.runtime\node-v22.23.1-win-x64'
$NodeExe = Join-Path $RuntimeRoot 'node.exe'
$Node22Launcher = Join-Path $RepoRoot 'scripts\with-node22.ps1'
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutputRoot = Join-Path $RepoRoot ".runtime\deployment-preflight\$Timestamp"

if ($RequirePm2Node22) { $Phase = 'PostSwitch' }
if (-not $CheckOnly -and $Phase -eq 'PreSwitch' -and [string]::IsNullOrWhiteSpace($NoRollbackAcceptanceEvidence)) {
  throw 'PreSwitch requires -NoRollbackAcceptanceEvidence with the recorded operator acceptance reference.'
}
if ($Topology -eq 'ReverseProxyHttps' -and ([string]::IsNullOrWhiteSpace($AllowedOrigins) -or $SessionCookieSecure -ne 'true' -or [string]::IsNullOrWhiteSpace($TrustedProxyCidrs))) {
  throw 'ReverseProxyHttps requires explicit -AllowedOrigins, -SessionCookieSecure true, and -TrustedProxyCidrs parameters.'
}
if (-not $CheckOnly -and $Phase -eq 'PostSwitch' -and [string]::IsNullOrWhiteSpace($ReleaseValidationToken)) { throw 'PostSwitch requires -ReleaseValidationToken for session and socket validation.' }

function Get-PortListeners {
  param([int[]]$Ports = @(3001, 5173))
  $connections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $Ports })
  return @($connections | ForEach-Object {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
    [pscustomobject]@{
      address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess
      process = if ($owner) { $owner.Name } else { '<unavailable>' }
      command = if ($owner) { $owner.CommandLine } else { '<unavailable>' }
    }
  } | Sort-Object port, address, pid)
}

function Assert-ListenerOwnership {
  param([object[]]$Listeners, [object[]]$Pm2Apps, [int]$Pm2DaemonPid = 0)
  $expected = @{ 3001 = 'nexo-backend'; 5173 = 'nexo-frontend' }
  $problems = @()
  foreach ($listener in $Listeners) {
    $app = @($Pm2Apps | Where-Object { $_.name -eq $expected[[int]$listener.port] })
    $ownedByExpectedApp = $app.Count -eq 1 -and [int]$app[0].pid -eq [int]$listener.pid
    $ownedByClusterDaemon = $app.Count -eq 1 -and $Pm2DaemonPid -gt 0 -and [int]$listener.pid -eq $Pm2DaemonPid
    if (-not ($ownedByExpectedApp -or $ownedByClusterDaemon)) {
      $problems += "$($listener.address):$($listener.port) PID $($listener.pid) $($listener.process) $($listener.command)"
    }
  }
  foreach ($port in $expected.Keys) {
    if (@($Listeners | Where-Object { [int]$_.port -eq $port }).Count -eq 0) { $problems += "port $port has no listener" }
  }
  if ($problems.Count -gt 0) { throw "Listener ownership check failed (nothing was stopped):`n$($problems -join "`n")" }
}

function Resolve-EnvironmentTopology {
  $values = @{}
  if ($EnvironmentFile) {
    if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) { throw "Environment file not found: $EnvironmentFile" }
    foreach ($line in Get-Content -LiteralPath $EnvironmentFile) {
      if ($line -match '^\s*([^#][^=]*)=(.*)$') { $values[$matches[1].Trim()] = $matches[2].Trim() }
    }
  }
  if ($Topology -eq 'LocalLoopback') {
    $ecosystemPath = Join-Path $RepoRoot 'ecosystem.config.js'
    $reader = "const c=require(process.argv[1]);const app=c.apps.find(x=>x.name==='nexo-backend');process.stdout.write(JSON.stringify(app&&app.env_production||{}))"
    $configNode = if (Test-Path -LiteralPath $NodeExe -PathType Leaf) { $NodeExe } else { (Get-Command node -ErrorAction Stop).Source }
    $ecosystemJson = & $configNode -e $reader $ecosystemPath
    if ($LASTEXITCODE -ne 0) { throw "Ecosystem configuration reader failed with exit $LASTEXITCODE." }
    $ecosystem = $ecosystemJson | ConvertFrom-Json
    foreach ($name in @('ALLOWED_ORIGINS', 'SESSION_COOKIE_SECURE', 'ALLOW_INSECURE_LOCAL_COOKIE', 'HOST', 'TRUST_PROXY_CIDRS', 'SUPABASE_URL', 'SALESFORCE_CLIENT_ID')) {
      $property = $ecosystem.psobject.Properties[$name]
      if ($property) { $values[$name] = [string]$property.Value }
    }
  } else {
    $values['ALLOWED_ORIGINS'] = $AllowedOrigins
    $values['SESSION_COOKIE_SECURE'] = $SessionCookieSecure
    $values['TRUST_PROXY_CIDRS'] = $TrustedProxyCidrs
  }
  return $values
}

if ($CheckOnly) {
  $requiredFiles = @(
    'package.json', 'backend\package.json', 'package-lock.json', 'backend\package-lock.json',
    'scripts\dependency-topology.js', 'scripts\verify-production-dependencies.js', 'scripts\with-node22.ps1',
    'backend\server.js', 'serve-frontend.js', 'ecosystem.config.js'
  )
  $missing = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $RepoRoot $_) -PathType Leaf) })
  if ($missing.Count -gt 0) { throw "Deployment preflight contract is incomplete ($($missing.Count) required files missing)." }
  $rootManifest = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
  $backendManifest = Get-Content -LiteralPath (Join-Path $RepoRoot 'backend\package.json') -Raw | ConvertFrom-Json
  foreach ($manifest in @($rootManifest, $backendManifest)) {
    if ($manifest.scripts.'install:production' -ne 'npm ci --omit=dev --omit=optional') {
      throw 'Production install script must omit dev and optional dependencies.'
    }
    if (-not $manifest.scripts.'verify:production-deps') { throw 'Production dependency verifier script is required.' }
  }
  if ($rootManifest.scripts.start -ne 'node serve-frontend.js') { throw 'Root start must target the approved static frontend server.' }
  foreach ($contractFile in @('scripts\deployment-contract.js', 'scripts\release-contract.test.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $contractFile) -PathType Leaf)) { throw "Missing deployment contract file: $contractFile" }
  }
  $resolvedEnvironment = Resolve-EnvironmentTopology
  if (-not ($resolvedEnvironment.ContainsKey('ALLOWED_ORIGINS') -or $resolvedEnvironment.ContainsKey('FRONTEND_URL'))) { throw 'Missing static allowed-origin configuration.' }
  if ($Topology -eq 'LocalLoopback') {
    $localExact = $resolvedEnvironment['HOST'] -eq '127.0.0.1' -and $resolvedEnvironment['ALLOWED_ORIGINS'] -eq 'http://localhost:5173' -and $resolvedEnvironment['ALLOW_INSECURE_LOCAL_COOKIE'] -eq 'true' -and $resolvedEnvironment['SESSION_COOKIE_SECURE'] -eq 'false' -and $resolvedEnvironment['TRUST_PROXY_CIDRS'] -eq ''
    if (-not $localExact) { throw 'LocalLoopback static topology must exactly match the approved ecosystem configuration.' }
  }
  $frontendDistCheck = if ($FrontendDistPath) { Join-Path $FrontendDistPath 'index.html' } else { Join-Path $RepoRoot 'frontend\dist\index.html' }
  foreach ($checkPath in @((Join-Path $RepoRoot 'frontend\package-lock.json'), $frontendDistCheck)) {
    if (-not (Test-Path -LiteralPath $checkPath -PathType Leaf)) { throw "Missing deployment artifact: $checkPath" }
  }
  Write-Host 'Deployment preflight static contract, topology, and artifact check passed. CheckOnly performed no PM2 or live predecessor checks.'
  exit 0
}

function Invoke-NpmChecked {
  param([string]$WorkingDirectory, [string[]]$Arguments)
  Push-Location $WorkingDirectory
  try {
    & $Node22Launcher npm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm command failed in $WorkingDirectory`: npm $($Arguments -join ' ')" }
  } finally { Pop-Location }
}

function Add-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail)
  $script:Checks += [pscustomobject]@{ name = $Name; passed = $Passed; detail = $Detail }
  if (-not $Passed) { $script:Failed = $true }
}

function Get-Pm2Cli {
  $local = Join-Path $RepoRoot 'node_modules\pm2\bin\pm2'
  if (Test-Path -LiteralPath $local -PathType Leaf) { return $local }
  if (-not $env:APPDATA) { return $null }
  $global = Join-Path $env:APPDATA 'npm\node_modules\pm2\bin\pm2'
  if (Test-Path -LiteralPath $global -PathType Leaf) { return $global }
  return $null
}

$Checks = @()
$Failed = $false

Add-Check 'runtime.node-exists' (Test-Path -LiteralPath $NodeExe -PathType Leaf) $NodeExe
Add-Check 'runtime.launcher-exists' (Test-Path -LiteralPath $Node22Launcher -PathType Leaf) $Node22Launcher
if (Test-Path -LiteralPath $NodeExe -PathType Leaf) {
  $actualHash = (Get-FileHash -LiteralPath $NodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
  Add-Check 'runtime.node-sha256' ($actualHash -eq $ExpectedNodeSha256) $actualHash
  $actualVersion = (& $NodeExe --version).Trim()
  Add-Check 'runtime.node-version' ($actualVersion -eq $ExpectedNodeVersion) $actualVersion
}

$resolvedEnvironment = Resolve-EnvironmentTopology
foreach ($name in $RequiredEnvironmentNames) {
  Add-Check "env.$name" ($resolvedEnvironment.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace($resolvedEnvironment[$name])) 'presence only; value not recorded'
}
$originsPresent = $resolvedEnvironment.ContainsKey('ALLOWED_ORIGINS') -or $resolvedEnvironment.ContainsKey('FRONTEND_URL')
Add-Check 'env.allowed-origin' $originsPresent 'ALLOWED_ORIGINS or FRONTEND_URL must be present'
if ($Topology -eq 'LocalLoopback') {
  $localExact = $resolvedEnvironment['HOST'] -eq '127.0.0.1' -and $resolvedEnvironment['ALLOWED_ORIGINS'] -eq 'http://localhost:5173' -and $resolvedEnvironment['ALLOW_INSECURE_LOCAL_COOKIE'] -eq 'true' -and $resolvedEnvironment['SESSION_COOKIE_SECURE'] -eq 'false' -and $resolvedEnvironment['TRUST_PROXY_CIDRS'] -eq ''
  Add-Check 'env.topology.local-exact' $localExact 'ecosystem env_production must be exact loopback topology with no trusted proxy'
} else {
  Add-Check 'env.topology.reverse-proxy' ($AllowedOrigins -eq $resolvedEnvironment['ALLOWED_ORIGINS'] -and $SessionCookieSecure -eq 'true' -and -not [string]::IsNullOrWhiteSpace($TrustedProxyCidrs)) 'explicit HTTPS origins, secure cookie, and trusted proxy CIDRs required'
}

foreach ($path in @('package-lock.json', 'backend\package-lock.json', 'frontend\package-lock.json', 'ecosystem.config.js', 'frontend\dist\index.html')) {
  $fullPath = Join-Path $RepoRoot $path
  Add-Check "artifact.$path" (Test-Path -LiteralPath $fullPath -PathType Leaf) $fullPath
}
if ($VerificationEvidencePath) {
  Add-Check 'artifact.verification-evidence' (Test-Path -LiteralPath $VerificationEvidencePath -PathType Leaf) $VerificationEvidencePath
}

$pm2Cli = Get-Pm2Cli
$pm2State = $null
$pm2DaemonNodeVersion = $null
$pm2DaemonPid = 0
$inspectionFixture = $null
if ($RuntimeInspectionFixturePath) {
  $inspectionFixture = Get-Content -LiteralPath $RuntimeInspectionFixturePath -Raw | ConvertFrom-Json
  $pm2State = @($inspectionFixture.pm2Apps)
  $pm2DaemonNodeVersion = [string]$inspectionFixture.pm2DaemonNodeVersion
  $pm2DaemonPid = [int]$inspectionFixture.pm2DaemonPid
  $expectedApps = @($pm2State | Where-Object { $_.name -in @('nexo-backend', 'nexo-frontend') })
  Add-Check 'pm2.apps-exact' ($pm2State.Count -eq 2 -and $expectedApps.Count -eq 2) 'exactly nexo-backend and nexo-frontend are accepted'
  Add-Check 'pm2.apps-online' (@($pm2State | Where-Object { $_.status -ne 'online' }).Count -eq 0) 'runtime inspection fixture'
  $phaseNode = if ($Phase -eq 'PostSwitch') { '22.23.1' } else { '25.6.1' }
  Add-Check 'pm2.daemon-node-version' ($pm2DaemonNodeVersion -eq $phaseNode) "$Phase daemon must be Node $phaseNode; actual: $pm2DaemonNodeVersion"
  $wrongRuntime = @($expectedApps | Where-Object { $_.nodeVersion -ne $phaseNode })
  Add-Check 'pm2.app-node-version' ($wrongRuntime.Count -eq 0) "$($wrongRuntime.Count) expected app(s) not on Node $phaseNode"
  if ($Phase -eq 'PreSwitch') { Add-Check 'rollback.acceptance' (-not [string]::IsNullOrWhiteSpace($NoRollbackAcceptanceEvidence)) 'explicit operator acceptance reference supplied' }
} elseif ($pm2Cli -and (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  try {
    $projector = Join-Path $RepoRoot 'scripts\pm2-jlist-projector.js'
    $projectedJson = & $NodeExe $projector $pm2Cli 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'PM2 projection failed.' }
    $projectedApps = $projectedJson | ConvertFrom-Json
    $pm2State = @($projectedApps | ForEach-Object { $_ })
    $expectedApps = @($pm2State | Where-Object { $_.name -in @('nexo-backend', 'nexo-frontend') })
    Add-Check 'pm2.apps-exact' ($pm2State.Count -eq 2 -and $expectedApps.Count -eq 2) 'exactly nexo-backend and nexo-frontend are accepted'
    Add-Check 'pm2.apps-online' (@($pm2State | Where-Object { $_.status -ne 'online' }).Count -eq 0) 'read-only jlist inspection'
    $pm2Report = (& $NodeExe $pm2Cli report | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'PM2 daemon report invalid.' }
    $contract = Join-Path $RepoRoot 'scripts\deployment-contract.js'
    $daemonParser = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{try{process.stdout.write(require(process.argv[1]).parsePm2DaemonNodeVersion(s))}catch{process.stderr.write('PM2 daemon report invalid.');process.exitCode=1}});"
    $pm2DaemonNodeVersion = ($pm2Report | & $NodeExe -e $daemonParser $contract 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'PM2 daemon report invalid.' }
    $pm2PidPath = Join-Path $env:USERPROFILE '.pm2\pm2.pid'
    if (Test-Path -LiteralPath $pm2PidPath -PathType Leaf) { $pm2DaemonPid = [int](Get-Content -LiteralPath $pm2PidPath -Raw).Trim() }
    $phaseNode = if ($Phase -eq 'PostSwitch') { '22.23.1' } else { '25.6.1' }
    Add-Check 'pm2.daemon-node-version' ($pm2DaemonNodeVersion -eq $phaseNode) "$Phase daemon must be Node $phaseNode; actual: $pm2DaemonNodeVersion"
    $wrongRuntime = @($expectedApps | Where-Object { $_.nodeVersion -ne $phaseNode })
    Add-Check 'pm2.app-node-version' ($wrongRuntime.Count -eq 0) "$($wrongRuntime.Count) expected app(s) not on Node $phaseNode"
    if ($Phase -eq 'PreSwitch') { Add-Check 'rollback.acceptance' (-not [string]::IsNullOrWhiteSpace($NoRollbackAcceptanceEvidence)) 'explicit operator acceptance reference supplied' }
  } catch {
    Add-Check 'pm2.readable' $false $_.Exception.Message
  }
} else {
  Add-Check 'pm2.cli-found' $false 'No repository-local or current-user global PM2 CLI found'
}

$listeners = if ($inspectionFixture) { @($inspectionFixture.listeners) } else { @(Get-PortListeners) }
foreach ($listener in $listeners) { Write-Host "LISTENER $($listener.address):$($listener.port) PID=$($listener.pid) PROCESS=$($listener.process) COMMAND=$($listener.command)" }
if ($ValidateRunningServices -or $Phase -in @('PreSwitch','PostSwitch')) {
  try { Assert-ListenerOwnership $listeners @($pm2State) $pm2DaemonPid; Add-Check 'listeners.owner' $true 'all listeners map to exact PM2 app or Windows cluster-daemon PID' }
  catch { Add-Check 'listeners.owner' $false $_.Exception.Message }
}

if ($RollbackManifestPath) {
  if (-not (Test-Path -LiteralPath $RollbackManifestPath -PathType Leaf)) { Add-Check 'rollback.manifest' $false "not found: $RollbackManifestPath" }
  else {
    try {
      $rollback = Get-Content -LiteralPath $RollbackManifestPath -Raw | ConvertFrom-Json
      $validRollback = $rollback.gitCommit -and $rollback.frontendDistSha256 -and $rollback.expectedNodeVersion -eq $ExpectedNodeVersion
      Add-Check 'rollback.manifest' ([bool]$validRollback) 'requires gitCommit, frontendDistSha256, and exact Node version'
    } catch { Add-Check 'rollback.manifest' $false $_.Exception.Message }
  }
}

$frontendDist = Join-Path $RepoRoot 'frontend\dist'

$manifest = [ordered]@{
  createdAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  repoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
  gitCommit = (& git -C $RepoRoot rev-parse HEAD).Trim()
  gitDirty = [bool](& git -C $RepoRoot status --porcelain)
  expectedNodeVersion = $ExpectedNodeVersion
  nodeSha256 = if (Test-Path -LiteralPath $NodeExe) { (Get-FileHash -LiteralPath $NodeExe -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
  checks = $Checks
  pm2Apps = @($pm2State)
  pm2DaemonNodeVersion = $pm2DaemonNodeVersion
  listeners = @($listeners)
  frontendDistSha256 = if (Test-Path -LiteralPath $frontendDist -PathType Container) {
    $files = @(Get-ChildItem -LiteralPath $frontendDist -File -Recurse | Sort-Object FullName)
    $sha = [Security.Cryptography.SHA256]::Create()
    foreach ($file in $files) { $relative = $file.FullName.Substring($frontendDist.Length).TrimStart('\','/').Replace('\','/'); $bytes = [Text.Encoding]::UTF8.GetBytes($relative); $null = $sha.TransformBlock($bytes,0,$bytes.Length,$bytes,0); $content = [IO.File]::ReadAllBytes($file.FullName); $null = $sha.TransformBlock($content,0,$content.Length,$content,0) }
    $null = $sha.TransformFinalBlock([byte[]]@(),0,0); ([BitConverter]::ToString($sha.Hash)).Replace('-','').ToLowerInvariant()
  } else { $null }
  note = 'This preflight creates evidence and local backups only. It does not deploy, restart, stop, or mutate PM2.'
}
$Checks | Format-Table -AutoSize
if ($CheckOnly) { Write-Host 'Read-only current-state preflight completed; no installs, build, evidence, PM2, or deployment state were mutated.' }
else { Write-Host 'Live preflight completed read-only; no installs, build, files, PM2, or deployment state were mutated.' }
if ($Failed) { throw 'Deployment preflight failed. Review the checks above; no deployment was performed.' }
if ($Phase -eq 'PostSwitch') {
  & (Join-Path $RepoRoot 'scripts\validate-running-release.ps1') -RepoRoot $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw 'PostSwitch running release validation failed.' }
  $previousToken = $env:NEXO_RELEASE_VALIDATION_TOKEN
  $previousBase = $env:NEXO_RELEASE_BASE_URL
  $previousOrigin = $env:NEXO_RELEASE_ORIGIN
  try {
    $env:NEXO_RELEASE_VALIDATION_TOKEN = $ReleaseValidationToken
    $env:NEXO_RELEASE_BASE_URL = 'http://127.0.0.1:3001'
    $env:NEXO_RELEASE_ORIGIN = if ($Topology -eq 'LocalLoopback') { 'http://localhost:5173' } else { $AllowedOrigins.Split(',')[0].Trim() }
    & $NodeExe (Join-Path $RepoRoot 'scripts\validate-session-socket.js')
    if ($LASTEXITCODE -ne 0) { throw 'PostSwitch session/socket validation failed.' }
  } finally {
    $env:NEXO_RELEASE_VALIDATION_TOKEN = $previousToken
    $env:NEXO_RELEASE_BASE_URL = $previousBase
    $env:NEXO_RELEASE_ORIGIN = $previousOrigin
  }
}
