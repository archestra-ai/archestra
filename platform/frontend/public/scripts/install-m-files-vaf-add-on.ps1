<#
.SYNOPSIS
Builds and installs the Archestra VAF Add On on this machine.

.DESCRIPTION
Run this on the Windows machine that hosts M-Files Server (or Server Tools),
as a user who is an M-Files system administrator. The script:

  1. downloads the pre-built archestra-m-files-vaf-add-on.mfappx from the
     URL the platform resolved (-PackageUrl, normally the newest add-on
     release; or a local file via -PackagePath); with -BuildFromSource, with
     no package source given, or when the download is unavailable, it
     instead fetches the add-on source and compiles the package against the
     M-Files assemblies installed on this machine;
  2. installs the package into the chosen vault over the M-Files COM API and
     restarts the vault. The logged-on Windows user is the only credential
     the script needs.

Every step can be skipped and re-run; the script is idempotent. If the COM
install fails, install the printed .mfappx manually in M-Files Admin
(Document Vaults > right-click vault > Applications) - nothing else remains
to configure.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-m-files-vaf-add-on.ps1

.EXAMPLE
.\install-m-files-vaf-add-on.ps1 -VaultName "Sample Vault"
#>
[CmdletBinding()]
param(
    # Pre-built add-on package to install; skips download and build entirely.
    [string]$PackagePath,
    # Where the pre-built package is downloaded from. The platform's install
    # bootstrap passes the URL it verified; there is no default because no
    # fixed URL is guaranteed to exist (releases/latest is the platform
    # release, which does not carry the add-on package).
    [string]$PackageUrl,
    # Compile on this machine against the installed M-Files assemblies
    # instead of using the pre-built package (also the automatic fallback
    # when the download is unavailable).
    [switch]$BuildFromSource,
    # Git ref of archestra-ai/archestra to fetch the add-on source from.
    [string]$Ref = "main",
    # Local add-on source directory (integrations/m-files-vaf-add-on);
    # when set, nothing is downloaded.
    [string]$SourceDirectory,
    # M-Files installation directory, e.g. "C:\Program Files\M-Files\26.6.16115.13".
    # Auto-detected when omitted.
    [string]$MFilesInstallDirectory,
    # Vault to install into. Prompted interactively when omitted.
    [string]$VaultName,
    # Vault GUID (with braces). Selects the vault when VaultName is omitted.
    [string]$VaultGuid,
    [switch]$SkipBuild,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$addOnAppGuid = "c26bb1e2-62ca-4a75-8751-bcf0787b6f36"
$rawBase = "https://raw.githubusercontent.com/archestra-ai/archestra/$Ref/integrations/m-files-vaf-add-on"
$sourceFiles = @(
    "build-package.ps1",
    "appdef.xml",
    "Contracts.cs",
    "ChangeJournal.cs",
    "PermissionSnapshotService.cs",
    "VaultApplication.cs"
)

function Write-Step([string]$message) { Write-Host "==> $message" -ForegroundColor Cyan }

# The canonical Archestra mark, shared with the /connection setup banners and
# agent startup screens - keep in sync with
# platform/backend/src/services/archestra-mark.ts. Same capability switch as
# those surfaces: Windows Terminal and PowerShell 7 render the Unicode braille
# mark, the legacy console gets the ASCII rendition. The braille block ships
# base64-encoded because this FILE must stay pure ASCII end to end - it
# travels through Invoke-RestMethod without a charset declaration and any raw
# non-ASCII byte would be decoded as Latin-1 mojibake.
$archUtf8 = $false
try {
    if ($env:WT_SESSION -or $PSVersionTable.PSVersion.Major -ge 6) {
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
        $OutputEncoding = [System.Text.UTF8Encoding]::new()
        $archUtf8 = $true
    }
} catch { }
if ($archUtf8) {
    Write-Host ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(
        "CuKggOKggOKggOKigOKjpOKjtuKjtuKjpuKhgOKggOKggOKggOKggOKggArioIDioIDioIDio77io7/io7/io7/io7/io7fioIDioIDioIDioIDioIAK4qCA4qCA4qO44qO/4qO/4qO/4qO/4qO/4qCH4qCA4qCA4qCA4qCA4qCACuKggOKioOKjv+Kjv+Kjv+Kjv+Kjv+Khn+KggOKggOKggOKggOKggOKggCAgICAgQXJjaGVzdHJhCuKigOKjv+Kjv+Kjv+Kjv+Kjv+Khn+KggOKigOKjtOKjtuKjtuKjpuKhgCAgICAgU2VjdXJlIGFjY2VzcyB0byB5b3VyIEFJIHRvb2xzCuKiuOKjv+Kjv+Kjv+Kjv+Kjv+KggeKggOKiv+Kjv+Kjv+Kjv+Kjv+KhhwrioIDioJvioL/ioL/ioJ/ioIPioIDioIDioIjioLvioL/ioL/ioJvioIEK"
    )))
} else {
    Write-Host @'

   .------------------.
   |                  |
   |        ,##.      |
   |        ####      |     Archestra
   |       ####       |     Secure access to your AI tools
   |       #### ,.    |
   |       `##' `'    |
   |                  |
   '------------------'
'@
}
Write-Host @'

   Installs:  Archestra VAF Add On (vault application)
   Note:      run on the M-Files server as a system administrator

'@

if ($env:OS -ne "Windows_NT") {
    throw "This script must run on the Windows machine that hosts M-Files Server."
}

# --- 1. Acquire the package (pre-built preferred) ----------------------------

# Deliberately NOT named $packagePath: PowerShell identifiers are
# case-insensitive, so that would overwrite the -PackagePath parameter
# before it is read.
$resolvedPackagePath = $null
if (-not [string]::IsNullOrWhiteSpace($PackagePath)) {
    if (-not (Test-Path $PackagePath)) { throw "Package not found: $PackagePath" }
    $resolvedPackagePath = (Resolve-Path $PackagePath).Path
} elseif (-not $BuildFromSource -and [string]::IsNullOrWhiteSpace($SourceDirectory) -and
    -not [string]::IsNullOrWhiteSpace($PackageUrl)) {
    $downloadTarget = Join-Path $env:TEMP "archestra-m-files-vaf-add-on.mfappx"
    try {
        Write-Step "Downloading pre-built add-on package from $PackageUrl"
        Invoke-WebRequest -UseBasicParsing -Uri $PackageUrl -OutFile $downloadTarget
        $resolvedPackagePath = $downloadTarget
    } catch {
        Write-Warning "Pre-built package unavailable ($($_.Exception.Message)); falling back to building from source."
    }
}

# --- 2. Build from source when no pre-built package is available --------------

if ($null -eq $resolvedPackagePath) {
    if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
        $SourceDirectory = Join-Path $env:TEMP "archestra-m-files-vaf-add-on-$Ref"
        New-Item -ItemType Directory -Path $SourceDirectory -Force | Out-Null
        Write-Step "Downloading add-on source (ref: $Ref) to $SourceDirectory"
        foreach ($file in $sourceFiles) {
            Invoke-WebRequest -UseBasicParsing -Uri "$rawBase/$file" `
                -OutFile (Join-Path $SourceDirectory $file)
        }
    } else {
        Write-Step "Using local add-on source: $SourceDirectory"
        foreach ($file in $sourceFiles) {
            if (-not (Test-Path (Join-Path $SourceDirectory $file))) {
                throw "Missing source file in -SourceDirectory: $file"
            }
        }
    }

    $resolvedPackagePath = Join-Path $SourceDirectory "bin\Release\net472\archestra-m-files-vaf-add-on.mfappx"
    if (-not $SkipBuild) {
        Write-Step "Building the add-on against the local M-Files installation"
        $buildArgs = @{ Configuration = "Release" }
        if (-not [string]::IsNullOrWhiteSpace($MFilesInstallDirectory)) {
            $buildArgs.MFilesInstallDirectory = $MFilesInstallDirectory
        }
        & (Join-Path $SourceDirectory "build-package.ps1") @buildArgs
    }
    if (-not (Test-Path $resolvedPackagePath)) {
        throw "Package not found after build: $resolvedPackagePath"
    }
}
Write-Host "Package: $resolvedPackagePath"

# --- 3. Administrative COM session -------------------------------------------

# Connects as the logged-on Windows user and selects the vault. This session
# is the only credential the install needs. Returns a session hashtable, or
# $null (with a warning) when the COM connection is unavailable. State
# travels in the returned object on purpose: this script usually runs as a
# scriptblock (`irm | iex` bootstrap), where no script scope exists for
# `$script:` to round-trip variables through.
function Connect-VaultAdmin([string]$WantedVaultName, [string]$WantedVaultGuid) {
    try {
        Write-Step "Connecting to the local M-Files server (logged-on Windows user)"
        $null = [System.Reflection.Assembly]::LoadWithPartialName("Interop.MFilesAPI")
        $comServer = New-Object MFilesAPI.MFilesServerApplicationClass
        $tzi = New-Object MFilesAPI.TimeZoneInformationClass
        $tzi.LoadWithCurrentTimeZone()
        # 1 = MFAuthTypeLoggedOnWindowsUser
        $null = $comServer.ConnectAdministrativeEx($tzi, 1, "", "", "", "",
            "ncacn_ip_tcp", "localhost", 2266, $false, "")
        $onlineVaults = $comServer.GetOnlineVaults()
    } catch {
        Write-Warning "Administrative COM session unavailable: $($_.Exception.Message)"
        return $null
    }

    # Vault selection errors are the user's to see - never downgraded to
    # "COM unavailable".
    if ([string]::IsNullOrWhiteSpace($WantedVaultName) -and -not [string]::IsNullOrWhiteSpace($WantedVaultGuid)) {
        foreach ($v in $onlineVaults) {
            if ($v.GUID -eq $WantedVaultGuid) { $WantedVaultName = $v.Name; break }
        }
        if ([string]::IsNullOrWhiteSpace($WantedVaultName)) {
            throw "No online vault with GUID $WantedVaultGuid on this server."
        }
    }
    if ([string]::IsNullOrWhiteSpace($WantedVaultName)) {
        Write-Host "Online vaults:"
        $names = @()
        foreach ($v in $onlineVaults) { $names += $v.Name }
        for ($i = 0; $i -lt $names.Count; $i++) {
            Write-Host ("  [{0}] {1}" -f ($i + 1), $names[$i])
        }
        $choice = [int](Read-Host "Install into which vault (number)")
        if ($choice -lt 1 -or $choice -gt $names.Count) {
            throw "Invalid vault selection: $choice (expected 1..$($names.Count))"
        }
        $WantedVaultName = $names[$choice - 1]
    }
    $selected = $onlineVaults.GetVaultByName($WantedVaultName)
    return @{
        Server        = $comServer
        VaultOnServer = $selected
        Vault         = $selected.LogIn()
        VaultName     = $WantedVaultName
        VaultGuid     = $selected.GUID
    }
}

# --- 4. Install into the vault over COM -------------------------------------

if (-not $SkipInstall) {
    $session = Connect-VaultAdmin $VaultName $VaultGuid
    if ($null -eq $session) {
        throw "The install step needs the administrative COM session. Install the printed .mfappx manually in M-Files Admin (Document Vaults > right-click vault > Applications) - nothing else remains to configure."
    }
    $VaultName = $session.VaultName
    $VaultGuid = $session.VaultGuid

    try {
        Write-Step "Uninstalling any previous add-on version"
        $session.Vault.CustomApplicationManagementOperations.UninstallCustomApplication($addOnAppGuid)
        $session.Server.VaultManagementOperations.TakeVaultOffline($VaultGuid, $true)
        $session.Server.VaultManagementOperations.BringVaultOnline($VaultGuid)
        $session.Vault = $session.VaultOnServer.LogIn()
    } catch {
        # No previous installation - expected on first install.
    }

    Write-Step "Installing $resolvedPackagePath into vault '$VaultName'"
    $session.Vault.CustomApplicationManagementOperations.InstallCustomApplication($resolvedPackagePath)
    Write-Step "Restarting the vault"
    $session.Server.VaultManagementOperations.TakeVaultOffline($VaultGuid, $true)
    $session.Server.VaultManagementOperations.BringVaultOnline($VaultGuid)
    $session.Vault = $session.VaultOnServer.LogIn()
    Write-Host "VAF Add On installed. Vault GUID: $VaultGuid"
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
