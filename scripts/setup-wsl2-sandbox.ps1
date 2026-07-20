param(
  [string]$SourceDistribution = "Ubuntu",
  [string]$TargetDistribution = "AgenticResearcherSandbox",
  [string]$RuntimeRoot = "/opt/agentic/runtime",
  [switch]$PersistUserEnvironment
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($RuntimeRoot -notmatch '^/opt/agentic/[A-Za-z0-9._/-]+$' -or $RuntimeRoot -match '(?:^|/)\.\.(?:/|$)') {
  throw "RuntimeRoot must stay below /opt/agentic without parent traversal."
}
if ($TargetDistribution -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
  throw "TargetDistribution is invalid."
}

function Invoke-Wsl {
  param([string[]]$Arguments)
  & wsl.exe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "wsl.exe failed with exit code $LASTEXITCODE."
  }
}

$entrypoint = (Resolve-Path (Join-Path $PSScriptRoot "..\extensions\code\sandbox\runtime\sandbox-entrypoint.py")).Path
$runtimeSetup = (Resolve-Path (Join-Path $PSScriptRoot "setup-wsl2-sandbox-runtime.sh")).Path
$distributions = @(& wsl.exe --list --quiet) | ForEach-Object { $_.Trim([char]0).Trim() } | Where-Object { $_ }
if ($LASTEXITCODE -ne 0) { throw "Unable to list WSL distributions." }
if ($distributions -notcontains $SourceDistribution) {
  throw "Source WSL distribution '$SourceDistribution' is not installed."
}

$localRoot = Join-Path $env:LOCALAPPDATA "AgenticResearcher\wsl"
$installRoot = Join-Path $localRoot $TargetDistribution
$exportTar = Join-Path $localRoot "$TargetDistribution-source.tar"
New-Item -ItemType Directory -Path $localRoot -Force | Out-Null

if ($distributions -notcontains $TargetDistribution) {
  if (Test-Path -LiteralPath $installRoot) {
    throw "Target install directory already exists without a registered distribution: $installRoot"
  }
  Write-Host "Cloning $SourceDistribution into dedicated WSL2 distribution $TargetDistribution..."
  Invoke-Wsl @("--export", $SourceDistribution, $exportTar)
  try {
    Invoke-Wsl @("--import", $TargetDistribution, $installRoot, $exportTar, "--version", "2")
  } finally {
    Remove-Item -LiteralPath $exportTar -Force -ErrorAction SilentlyContinue
  }
}

$entrypointLinux = (& wsl.exe --distribution $TargetDistribution --user root --exec wslpath -a $entrypoint).Trim()
if ($LASTEXITCODE -ne 0 -or -not $entrypointLinux) {
  throw "Unable to resolve the sandbox entrypoint inside $TargetDistribution."
}
$runtimeSetupLinux = (& wsl.exe --distribution $TargetDistribution --user root --exec wslpath -a $runtimeSetup).Trim()
if ($LASTEXITCODE -ne 0 -or -not $runtimeSetupLinux) {
  throw "Unable to resolve the sandbox runtime setup helper inside $TargetDistribution."
}

Write-Host "Installing the fixed bubblewrap, Node/npm, and Python runtime boundary..."
Invoke-Wsl @("--distribution", $TargetDistribution, "--user", "root", "--exec", "bash", $runtimeSetupLinux, "provision", $RuntimeRoot, $entrypointLinux)

$runtimeDigest = (& wsl.exe --distribution $TargetDistribution --user root --exec bash $runtimeSetupLinux "fingerprint" $RuntimeRoot 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $runtimeDigest -notmatch '^sha256:[a-f0-9]{64}$') {
  throw "Unable to fingerprint the complete immutable sandbox runtime bundle."
}
Invoke-Wsl @("--distribution", $TargetDistribution, "--user", "root", "--exec", "bash", $runtimeSetupLinux, "identity", $RuntimeRoot, $runtimeDigest)

$environmentValues = [ordered]@{
  AGENTIC_SANDBOX_CI_EXECUTABLE = "wsl.exe"
  AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE = "agentic-language-runtime"
  AGENTIC_SANDBOX_CI_RUNTIME_DIGEST = $runtimeDigest
  AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION = $TargetDistribution
  AGENTIC_SANDBOX_CI_RUNTIME_ROOT = $RuntimeRoot
}
if ($PersistUserEnvironment) {
  foreach ($entry in $environmentValues.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "User")
  }
  Write-Host "Saved non-secret sandbox bindings to the current Windows user environment."
}

Write-Host "WSL2 sandbox runtime provisioned. Use these process-local values for live proof:"
foreach ($entry in $environmentValues.GetEnumerator()) {
  Write-Output "`$env:$($entry.Key) = '$($entry.Value)'"
}
