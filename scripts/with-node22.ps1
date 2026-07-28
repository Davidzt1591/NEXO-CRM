param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Command,
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$CommandArguments
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot '.runtime\node-v22.23.1-win-x64'
$nodeExe = Join-Path $runtimeRoot 'node.exe'
$npmCmd = Join-Path $runtimeRoot 'npm.cmd'
$expectedNodeVersion = 'v22.23.1'
$expectedNpmVersion = '10.9.8'
$expectedNodeSha256 = 'f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed'

if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { throw "Node 22 runtime not found: $nodeExe" }
if (-not (Test-Path -LiteralPath $npmCmd -PathType Leaf)) { throw "npm launcher not found: $npmCmd" }

$actualHash = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedNodeSha256) {
  throw "Node runtime checksum mismatch. Expected $expectedNodeSha256, got $actualHash."
}

# PATH is the contract: npm lifecycle scripts and nested child processes must resolve this Node first.
$env:PATH = "$runtimeRoot$([IO.Path]::PathSeparator)$env:PATH"
$actualNodeVersion = (& node --version).Trim()
$actualNpmVersion = (& $npmCmd --version).Trim()
if ($actualNodeVersion -ne $expectedNodeVersion) { throw "Node runtime mismatch. Expected $expectedNodeVersion, got $actualNodeVersion." }
if ($actualNpmVersion -ne $expectedNpmVersion) { throw "npm runtime mismatch. Expected $expectedNpmVersion, got $actualNpmVersion." }

if ($Command -in @('npm', 'npm.cmd')) { $Command = $npmCmd }

& $Command @CommandArguments
exit $LASTEXITCODE
