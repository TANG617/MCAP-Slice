param(
    [string]$BuildDir,
    [string]$DistDir
)

$ErrorActionPreference = "Stop"

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $BuildDir) {
    $BuildDir = Join-Path $ProjectDir "build/release-windows-x86_64"
}
if (-not $DistDir) {
    $DistDir = Join-Path $ProjectDir "dist"
}

$QtRoot = $env:QT_PREFIX
if (-not $QtRoot) {
    $QtRoot = $env:QT_ROOT_DIR
}
if (-not $QtRoot) {
    throw "Set QT_PREFIX or QT_ROOT_DIR to a Qt 6 installation."
}

$WinDeployQt = Join-Path $QtRoot "bin/windeployqt.exe"
if (-not (Test-Path -LiteralPath $WinDeployQt)) {
    throw "windeployqt was not found at $WinDeployQt."
}

& cmake `
    -S $ProjectDir `
    -B $BuildDir `
    -G "Visual Studio 17 2022" `
    -A x64 `
    "-DCMAKE_PREFIX_PATH=$QtRoot" `
    -DBUILD_TESTING=ON
if ($LASTEXITCODE -ne 0) {
    throw "CMake configure failed with exit code $LASTEXITCODE."
}

& cmake --build $BuildDir --config Release --parallel
if ($LASTEXITCODE -ne 0) {
    throw "CMake build failed with exit code $LASTEXITCODE."
}

& ctest --test-dir $BuildDir -C Release --output-on-failure
if ($LASTEXITCODE -ne 0) {
    throw "CTest failed with exit code $LASTEXITCODE."
}

$StageDir = Join-Path $DistDir ".stage-windows-x86_64"
$InstallDir = Join-Path $StageDir "install"
$PackageDir = Join-Path $StageDir "MCAP-Slice"
$ArchivePath = Join-Path $DistDir "MCAP-Slice-Windows-x86_64.zip"

if (Test-Path -LiteralPath $StageDir) {
    Remove-Item -LiteralPath $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $PackageDir -Force | Out-Null
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null

& cmake --install $BuildDir --config Release --prefix $InstallDir
if ($LASTEXITCODE -ne 0) {
    throw "CMake install failed with exit code $LASTEXITCODE."
}

$InstalledExe = Join-Path $InstallDir "bin/mcap-slice.exe"
if (-not (Test-Path -LiteralPath $InstalledExe)) {
    throw "Installed executable was not found at $InstalledExe."
}

$PackagedExe = Join-Path $PackageDir "mcap-slice.exe"
Copy-Item -LiteralPath $InstalledExe -Destination $PackagedExe

& $WinDeployQt `
    --release `
    --compiler-runtime `
    --no-translations `
    --dir $PackageDir `
    $PackagedExe
if ($LASTEXITCODE -ne 0) {
    throw "windeployqt failed with exit code $LASTEXITCODE."
}

$RequiredRuntimeFiles = @(
    "Qt6Core.dll",
    "Qt6Gui.dll",
    "Qt6Widgets.dll",
    "platforms/qwindows.dll"
)
foreach ($RuntimeFile in $RequiredRuntimeFiles) {
    $RuntimePath = Join-Path $PackageDir $RuntimeFile
    if (-not (Test-Path -LiteralPath $RuntimePath)) {
        throw "windeployqt did not produce $RuntimePath."
    }
}

$Process = $null
try {
    $Process = Start-Process -FilePath $PackagedExe -PassThru
    Start-Sleep -Seconds 3
    $Process.Refresh()
    if ($Process.HasExited) {
        throw "The packaged application exited during the smoke test with code $($Process.ExitCode)."
    }
}
finally {
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force
        $Process.WaitForExit()
    }
}

if (Test-Path -LiteralPath $ArchivePath) {
    Remove-Item -LiteralPath $ArchivePath -Force
}
Compress-Archive -Path (Join-Path $PackageDir "*") -DestinationPath $ArchivePath

Write-Host "Created:"
Write-Host "  $PackageDir"
Write-Host "  $ArchivePath"
