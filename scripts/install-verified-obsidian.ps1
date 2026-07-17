$ErrorActionPreference = "Stop"

$version = "1.12.7"
$expectedSha256 = "f35d2a35061098400a3fafc1bfd38d8bd33f1ad76df8b78b62ccdf20b0a30d26"
$installer = Join-Path $env:RUNNER_TEMP "Obsidian-$version.exe"
$installDir = Join-Path $env:RUNNER_TEMP "Obsidian"
$assetUrl = "https://github.com/obsidianmd/obsidian-releases/releases/download/v$version/Obsidian-$version.exe"

Invoke-WebRequest -Uri $assetUrl -OutFile $installer
$actualSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "Obsidian installer SHA-256 mismatch. Expected $expectedSha256, received $actualSha256."
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$process = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installDir") -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "Obsidian installer exited with code $($process.ExitCode)."
}

$obsidianExe = Join-Path $installDir "Obsidian.exe"
if (-not (Test-Path -LiteralPath $obsidianExe -PathType Leaf)) {
  throw "The verified installer completed, but $obsidianExe was not created."
}

$stream = [System.IO.File]::OpenRead($obsidianExe)
$reader = $null
try {
  $reader = [System.IO.BinaryReader]::new($stream)
  $stream.Position = 0x3c
  $peOffset = $reader.ReadInt32()
  $stream.Position = $peOffset + 4
  $machine = $reader.ReadUInt16()
} finally {
  if ($null -ne $reader) {
    $reader.Dispose()
  }
  $stream.Dispose()
}
if ($machine -ne 0x8664) {
  throw ("Installed Obsidian executable is not x64 (PE machine 0x{0:x4})." -f $machine)
}

$signature = Get-AuthenticodeSignature -LiteralPath $obsidianExe
if ($signature.Status -ne "Valid") {
  throw "Installed Obsidian Authenticode signature is $($signature.Status), expected Valid."
}

if ($env:GITHUB_ENV) {
  "OBSIDIAN_EXE=$obsidianExe" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
Write-Output $obsidianExe
