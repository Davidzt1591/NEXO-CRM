param([string]$RepoRoot = (Split-Path -Parent $PSScriptRoot), [int]$Attempts = 20)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$node = Join-Path $RepoRoot '.runtime\node-v22.23.1-win-x64\node.exe'
$pm2 = Join-Path $env:APPDATA 'npm\node_modules\pm2\bin\pm2'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node 22 runtime missing: $node" }
if (-not (Test-Path -LiteralPath $pm2 -PathType Leaf)) { throw "PM2 CLI missing: $pm2" }

function Invoke-ContractAssertion([string]$FunctionName, [object[]]$Arguments) {
  $contract = Join-Path $RepoRoot 'scripts\deployment-contract.js'
  $json = ConvertTo-Json -InputObject $Arguments -Depth 8 -Compress
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $script = "const c=require(process.argv[1]);const a=JSON.parse(Buffer.from(process.argv[2],'base64').toString('utf8'));c[process.argv[3]](...a);"
  $result = & $node -e $script $contract $payload $FunctionName 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($result | Out-String) }
}

$projector = Join-Path $RepoRoot 'scripts\pm2-jlist-projector.js'
$projectedJson = & $node $projector $pm2 2>$null
if ($LASTEXITCODE -ne 0) { throw 'PM2 projection failed.' }
$projectedApps = $projectedJson | ConvertFrom-Json
$apps = @($projectedApps | ForEach-Object { $_ })
$expected = @{ 3001 = @($apps | Where-Object name -eq 'nexo-backend')[0]; 5173 = @($apps | Where-Object name -eq 'nexo-frontend')[0] }
foreach ($app in $expected.Values) {
  if (-not $app -or $app.status -ne 'online' -or $app.nodeVersion -ne '22.23.1') { throw 'Expected PM2 apps must be online on Node 22.23.1.' }
}
$report = (& $node $pm2 report | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'PM2 daemon report invalid.' }
$contract = Join-Path $RepoRoot 'scripts\deployment-contract.js'
$daemonParser = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{try{process.stdout.write(require(process.argv[1]).parsePm2DaemonNodeVersion(s))}catch{process.stderr.write('PM2 daemon report invalid.');process.exitCode=1}});"
$pm2DaemonNodeVersion = ($report | & $node -e $daemonParser $contract 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'PM2 daemon report invalid.' }
if ($pm2DaemonNodeVersion -ne '22.23.1') { throw 'PM2 daemon is not running on Node 22.23.1.' }

$listeners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -in @(3001,5173) | ForEach-Object {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
  [pscustomobject]@{ address=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess; process=$owner.Name; command=$owner.CommandLine }
})
foreach ($item in $listeners) { Write-Host "LISTENER $($item.address):$($item.port) PID=$($item.pid) PROCESS=$($item.process) COMMAND=$($item.command)" }
$pm2PidPath = Join-Path $env:USERPROFILE '.pm2\pm2.pid'
$pm2DaemonPid = if (Test-Path -LiteralPath $pm2PidPath -PathType Leaf) { [int](Get-Content -LiteralPath $pm2PidPath -Raw).Trim() } else { 0 }
$listenerContract = @{
  '3001' = @{ pid = [int]$expected[3001].pid; commandFragment = 'backend' }
  '5173' = @{ pid = [int]$expected[5173].pid; commandFragment = 'serve-frontend.js' }
}
[object[]]$listenerArguments = New-Object object[] 3
$listenerArguments[0] = [object[]]$listeners
$listenerArguments[1] = $listenerContract
$listenerArguments[2] = @{ pm2DaemonPid = $pm2DaemonPid; pm2DaemonCommandFragment = 'Daemon.js' }
Invoke-ContractAssertion 'assertListenerOwnership' $listenerArguments

$healthHost = if ($expected[3001].host) { $expected[3001].host } else { '127.0.0.1' }
$healthUri = if ($healthHost -eq '::1') { 'http://[::1]:3001/health' } else { "http://$healthHost`:3001/health" }
$healthy = $false
for ($i=0; $i -lt $Attempts; $i++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUri -TimeoutSec 2
    $json = $response.Content | ConvertFrom-Json
    if ($response.StatusCode -eq 200) {
      Invoke-ContractAssertion 'assertHealthBody' @($json)
      $healthy = $true
      break
    }
  } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $healthy) { throw "Exact ready health contract failed at $healthUri" }

$manifest = Get-ChildItem -LiteralPath (Join-Path $RepoRoot '.runtime\deployment-preflight') -Filter deployment-manifest.json -File -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $manifest) { throw 'No deployment manifest exists for frontend hash attribution.' }
$expectedHash = (Get-Content -LiteralPath $manifest.FullName -Raw | ConvertFrom-Json).frontendDistSha256
Push-Location $RepoRoot
try { $actualHash = & $node -e "console.log(require('./scripts/deployment-contract').hashDirectory('./frontend/dist'))" }
finally { Pop-Location }
if (-not $expectedHash -or $actualHash.Trim() -ne $expectedHash) { throw "Frontend dist does not match deployment manifest $($manifest.FullName)." }
Write-Host "Running release validated: health=$healthUri backendPID=$($expected[3001].pid) frontendPID=$($expected[5173].pid) distSha256=$expectedHash"
