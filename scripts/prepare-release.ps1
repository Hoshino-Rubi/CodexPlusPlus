# Requires PowerShell 7. Downloads only the pinned, checksum-verified Electron runtime.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$electronVersion = $manifest.devDependencies.electron
if ($electronVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Electron must have an exact release version' }
$archiveName = "electron-v$electronVersion-win32-x64.zip"
$outputRoot = Join-Path $projectRoot 'out'
$archivePath = Join-Path $outputRoot $archiveName
$distributionPath = Join-Path $outputRoot "electron-$electronVersion-win32-x64"
$hashes = Get-Content -LiteralPath (Join-Path $projectRoot 'node_modules/electron/checksums.json') -Raw | ConvertFrom-Json -AsHashtable
$expectedHash = $hashes[$archiveName]
if (-not $expectedHash) { throw 'Pinned Electron package has no Windows x64 checksum' }
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $archivePath)) {
    $downloadUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/$archiveName"
    if ($env:ELECTRON_MIRROR) {
        $mirrorUri = [Uri]$env:ELECTRON_MIRROR
        if ($mirrorUri.Scheme -ne 'https' -or $mirrorUri.UserInfo -or $mirrorUri.Query -or $mirrorUri.Fragment) { throw 'Electron mirror must be an HTTPS base URL without credentials' }
        $downloadUrl = $mirrorUri.AbsoluteUri.TrimEnd('/') + "/$electronVersion/$archiveName"
    }
    $downloadPath = "$archivePath.download"
    & curl.exe --fail --location --silent --show-error --retry 2 --max-time 300 --output $downloadPath $downloadUrl
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime download failed' }
    if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Downloaded Electron runtime checksum mismatch' }
    Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
}
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'Electron runtime checksum mismatch; archive was not extracted' }
Expand-Archive -LiteralPath $archivePath -DestinationPath $distributionPath -Force
Write-Output "Pinned Electron $electronVersion runtime verified."

# Seed builder's documented archive cache using curl, avoiding the stalled
# @electron/get download stream on this Windows host. Builder rechecks hashes.
$cacheRoot = if ($env:ELECTRON_BUILDER_CACHE) { [IO.Path]::GetFullPath($env:ELECTRON_BUILDER_CACHE) } else { Join-Path $outputRoot 'builder-cache' }
$toolsets = @(
    @{ Release = '7zip@1.0.0'; File = '7zip-win-x64.tar.gz'; Hash = 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3' },
    @{ Release = 'nsis@1.2.1'; File = 'nsis-bundle-3.12.tar.gz'; Hash = '56997fdefe25e7928a1a68b4583d08b240b66cf660234053b20131a74cc082f4' }
)
foreach ($toolset in $toolsets) {
    $toolDirectory = Join-Path $cacheRoot $toolset.Release
    $toolArchive = Join-Path $toolDirectory $toolset.File
    New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
    if (-not (Test-Path -LiteralPath $toolArchive)) {
        $toolDownload = "$toolArchive.download"
        $toolUrl = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/' + $toolset.Release + '/' + $toolset.File
        if ($env:ELECTRON_BUILDER_BINARIES_MIRROR) {
            $toolMirror = [Uri]$env:ELECTRON_BUILDER_BINARIES_MIRROR
            if ($toolMirror.Scheme -ne 'https' -or $toolMirror.UserInfo -or $toolMirror.Query -or $toolMirror.Fragment) { throw 'Builder mirror must be an HTTPS base URL without credentials' }
            $toolUrl = $toolMirror.AbsoluteUri.TrimEnd('/') + '/' + $toolset.Release + '/' + $toolset.File
        }
        & curl.exe --fail --location --silent --show-error --retry 2 --max-time 300 --output $toolDownload $toolUrl
        if ($LASTEXITCODE -ne 0) { throw "Builder toolset download failed: $($toolset.File)" }
        if ((Get-FileHash -LiteralPath $toolDownload -Algorithm SHA256).Hash -ne $toolset.Hash) { throw 'Builder toolset checksum mismatch' }
        Move-Item -LiteralPath $toolDownload -Destination $toolArchive -Force
    }
    if ((Get-FileHash -LiteralPath $toolArchive -Algorithm SHA256).Hash -ne $toolset.Hash) { throw 'Cached builder toolset checksum mismatch' }
    Write-Output "Verified builder toolset: $($toolset.File)"
}
