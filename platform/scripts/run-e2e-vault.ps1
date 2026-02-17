# Run E2E with Vault: start Vault (Docker), app, then run credentials-with-vault tests only.
# Requires Docker Desktop running. Run from platform root: .\scripts\run-e2e-vault.ps1

$ErrorActionPreference = "Stop"
$platformRoot = if ($PSScriptRoot) { Join-Path $PSScriptRoot ".." } else { $PWD }

function Stop-ProcessOnPort {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn -and $conn.OwningProcess) {
            $procId = $conn.OwningProcess
            Write-Host "Stopping process on port $Port (PID $procId) ..." -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            cmd /c "taskkill /F /T /PID $procId" 2>$null
            Start-Sleep -Seconds 2
        }
    } catch {
        Write-Host "Could not free port $Port : $_" -ForegroundColor Yellow
    }
}

function Wait-ForUrl {
    param([string]$Url, [int]$MaxAttempts = 60, [int]$DelayMs = 2000)
    for ($i = 0; $i -lt $MaxAttempts; $i++) {
        try {
            $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            return $true
        } catch {
            if ($i -eq 0) { Write-Host "Waiting for $Url ..." -ForegroundColor Yellow }
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    return $false
}

# Require Docker and ensure daemon is running
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Docker not found. Install Docker Desktop and add it to PATH." -ForegroundColor Red
    exit 1
}
$dockerOk = $false
try {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
} catch {}
if (-not $dockerOk) {
    Write-Host "Docker daemon is not running. Start Docker Desktop and wait until it is ready, then re-run this script." -ForegroundColor Red
    exit 1
}

Write-Host "=== Freeing ports 3000, 9000, 8200 ===" -ForegroundColor Cyan
Stop-ProcessOnPort -Port 3000
Stop-ProcessOnPort -Port 9000
Stop-ProcessOnPort -Port 8200
Start-Sleep -Seconds 3

# Start real Vault via Docker (no mock fallback)
$vaultCompose = Join-Path $platformRoot "dev\docker-compose.vault.ee.yml"
if (-not (Test-Path $vaultCompose)) {
    Write-Host "Compose file not found: $vaultCompose" -ForegroundColor Red
    exit 1
}

Write-Host "=== Starting Vault (Docker) ===" -ForegroundColor Cyan
# docker compose sometimes writes status like "Container ... Running" to stderr even on success.
# Temporarily relax ErrorActionPreference so PowerShell doesn't treat that as a terminating error.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$composeOut = & docker compose -f $vaultCompose up -d 2>&1
$composeExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($composeExit -ne 0) {
    Write-Host "Docker Compose failed (exit $composeExit):" -ForegroundColor Red
    $composeOut | ForEach-Object { Write-Host $_ }
    Write-Host "Fix: ensure Docker Desktop is running and port 8200 is free, then re-run." -ForegroundColor Red
    exit 1
}
Write-Host ($composeOut | Out-String)

Write-Host "Waiting for Vault at http://127.0.0.1:8200 ..." -ForegroundColor Yellow
Start-Sleep -Seconds 5
$vaultReady = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8200/v1/sys/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        $vaultReady = $true
        Write-Host "Vault ready." -ForegroundColor Green
        break
    } catch {
        if ($i -eq 0) { Write-Host "Polling /v1/sys/health ..." -ForegroundColor Yellow }
        Start-Sleep -Seconds 2
    }
}
if (-not $vaultReady) {
    Write-Host "Vault did not become ready. Check: docker compose -f $vaultCompose logs" -ForegroundColor Red
    & docker compose -f $vaultCompose down 2>&1 | Out-Null
    exit 1
}

# Enable KV v2 at "secret" for credentials-with-vault tests
try {
    $body = '{"type":"kv","options":{"version":2}}'
    $headers = @{ "X-Vault-Token" = "dev-root-token"; "Content-Type" = "application/json" }
    Invoke-WebRequest -Uri "http://127.0.0.1:8200/v1/sys/mounts/secret" -Method PUT -Body $body -Headers $headers -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
    Write-Host "Vault: enabled KV v2 at secret." -ForegroundColor Green
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 400) { Write-Host "Vault: secret mount already exists." -ForegroundColor Green }
    else { Write-Host "Vault: could not enable secret mount: $_" -ForegroundColor Yellow }
}

# Same env/backend/frontend setup as run-e2e-with-app.ps1 (minimal copy)
$platformEnv = Join-Path $platformRoot ".env"
$backendEnv = Join-Path $platformRoot "backend\.env"
if (Test-Path $platformEnv) {
    Copy-Item -Path $platformEnv -Destination $backendEnv -Force
    Get-Content $platformEnv | ForEach-Object {
        $line = $_
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$' -and $line.Trim() -notmatch '^\#') {
            $val = $matches[2].Trim()
            if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) { $val = $val.Substring(1, $val.Length - 2) }
            [System.Environment]::SetEnvironmentVariable($matches[1], $val, "Process")
        }
    }
}
# Ensure backend can reach Vault (real or mock) at 8200
Add-Content -Path $backendEnv -Value "ARCHESTRA_HASHICORP_VAULT_ADDR=http://127.0.0.1:8200"
Add-Content -Path $backendEnv -Value "ARCHESTRA_HASHICORP_VAULT_TOKEN=dev-root-token"
$env:ARCHESTRA_HASHICORP_VAULT_ADDR = "http://127.0.0.1:8200"
$env:ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token"
$frontendDir = Join-Path $platformRoot "frontend"
$overridePath = Join-Path $frontendDir ".env.development.local"
$overrideBackup = Join-Path $frontendDir ".env.development.local.e2e-backup"
if (Test-Path $overridePath) { Move-Item -Path $overridePath -Destination $overrideBackup -Force }
@"
ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000
NEXT_PUBLIC_ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000
"@ | Set-Content -Path $overridePath -Encoding utf8
$env:ARCHESTRA_API_BASE_URL = "http://127.0.0.1:9000"
$env:NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://127.0.0.1:9000"

# Backend
Write-Host "`n=== Starting BACKEND ===" -ForegroundColor Cyan
$backendProc = Start-Process -FilePath "pnpm" -ArgumentList "--filter", "@backend", "dev" -WorkingDirectory $platformRoot -PassThru -WindowStyle Minimized
Write-Host "Waiting for backend (90s then poll) ..." -ForegroundColor Yellow
Start-Sleep -Seconds 90
if (-not (Wait-ForUrl -Url "http://127.0.0.1:9000/health" -MaxAttempts 300 -DelayMs 2000)) {
    Write-Host "Backend did not become ready." -ForegroundColor Red
    docker compose -f $vaultCompose down 2>&1 | Out-Null
    exit 1
}
Write-Host "Backend ready." -ForegroundColor Green

# Frontend
Write-Host "`n=== Starting FRONTEND ===" -ForegroundColor Cyan
$frontendProc = Start-Process -FilePath "pnpm" -ArgumentList "--filter", "@frontend", "dev" -WorkingDirectory $platformRoot -PassThru -WindowStyle Minimized
if (-not (Wait-ForUrl -Url "http://localhost:3000" -MaxAttempts 60 -DelayMs 2000)) {
    Write-Host "Frontend did not become ready." -ForegroundColor Red
    Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
    docker compose -f $vaultCompose down 2>&1 | Out-Null
    exit 1
}
Write-Host "Frontend ready." -ForegroundColor Green
Start-Sleep -Seconds 3

try {
    Write-Host "`n=== Running Vault E2E tests (credentials-with-vault) ===" -ForegroundColor Cyan
    Push-Location (Join-Path $platformRoot "e2e-tests")
    try {
        pnpm exec playwright test --project=setup-admin --project=setup-users --project=setup-teams --project=credentials-with-vault
        $e2eExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $e2eExit
} finally {
    Write-Host "Stopping backend, frontend, Vault ..." -ForegroundColor Yellow
    Stop-ProcessOnPort -Port 3000
    Stop-ProcessOnPort -Port 9000
    & docker compose -f $vaultCompose down 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    if ($backendProc -and $backendProc.Id) { Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue }
    if ($frontendProc -and $frontendProc.Id) { Stop-Process -Id $frontendProc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -Path $overridePath -Force -ErrorAction SilentlyContinue
    if (Test-Path $overrideBackup) { Move-Item -Path $overrideBackup -Destination $overridePath -Force }
}
