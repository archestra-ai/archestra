param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [string]$MFilesInstallDirectory
)

$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputDirectory = Join-Path $projectDirectory "bin\$Configuration\net472"
$assemblyPath = Join-Path $outputDirectory "Archestra.MFiles.VAFAddOn.dll"
$manifestPath = Join-Path $outputDirectory "appdef.xml"
$packagePath = Join-Path $outputDirectory "archestra-m-files-vaf-add-on.mfappx"
$zipPath = [IO.Path]::ChangeExtension($packagePath, ".zip")

if ([string]::IsNullOrWhiteSpace($MFilesInstallDirectory)) {
    $mFilesRoot = Join-Path $env:ProgramFiles "M-Files"
    $MFilesInstallDirectory = Get-ChildItem $mFilesRoot -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName "Bin\anycpu\MFiles.VAF.dll") } |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if ([string]::IsNullOrWhiteSpace($MFilesInstallDirectory)) {
    throw "An M-Files Server or Server Tools installation was not found."
}

$assemblyDirectory = Join-Path $MFilesInstallDirectory "Bin\anycpu"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$references = @(
    Join-Path $assemblyDirectory "Interop.MFilesApi.dll"
    Join-Path $assemblyDirectory "MFiles.VAF.dll"
    Join-Path $assemblyDirectory "MFiles.VAF.Configuration.Interfaces.dll"
    Join-Path $assemblyDirectory "MFiles.VAF.Configuration.dll"
    Join-Path $assemblyDirectory "Newtonsoft.Json.dll"
)
$sources = @(
    Join-Path $projectDirectory "Contracts.cs"
    Join-Path $projectDirectory "ChangeJournal.cs"
    Join-Path $projectDirectory "PermissionSnapshotService.cs"
    Join-Path $projectDirectory "VaultApplication.cs"
)
foreach ($path in @($compiler) + $references + $sources) {
    if (-not (Test-Path $path)) {
        throw "Required build input not found: $path"
    }
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$compilerArguments = @(
    "/nologo"
    "/target:library"
    "/langversion:5"
    "/warn:4"
    "/out:$assemblyPath"
)
if ($Configuration -eq "Release") {
    $compilerArguments += "/optimize+"
}
foreach ($reference in $references) {
    $compilerArguments += "/reference:$reference"
}
$compilerArguments += $sources

& $compiler $compilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "The VAF add-on compilation failed with exit code $LASTEXITCODE."
}

Copy-Item (Join-Path $projectDirectory "appdef.xml") $manifestPath -Force

$runtimeDependencyPaths = @()
foreach ($reference in $references) {
    $dependencyPath = Join-Path $outputDirectory (Split-Path -Leaf $reference)
    Copy-Item $reference $dependencyPath -Force
    $runtimeDependencyPaths += $dependencyPath
}

Remove-Item $zipPath, $packagePath -Force -ErrorAction SilentlyContinue

$packageFiles = @(
    $manifestPath
    $assemblyPath
) + $runtimeDependencyPaths

Compress-Archive -Path $packageFiles -DestinationPath $zipPath -CompressionLevel Optimal
Move-Item $zipPath $packagePath
Write-Output $packagePath
