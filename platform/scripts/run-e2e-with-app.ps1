# Two-phase E2E: start BACKEND first and wait for it, then start FRONTEND, then run Playwright.
# This avoids frontend hitting ECONNREFUSED while backend is still starting.
# Run from platform root: .\scripts\run-e2e-with-app.ps1

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

Write-Host "=== Freeing ports 3000 and 9000 ===" -ForegroundColor Cyan
Stop-ProcessOnPort -Port 3000
Stop-ProcessOnPort -Port 9000
Start-Sleep -Seconds 3
Stop-ProcessOnPort -Port 3000
Stop-ProcessOnPort -Port 9000
Start-Sleep -Seconds 2
foreach ($port in 3000, 9000) {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn -and $conn.OwningProcess) {
        Write-Host "Port $port still in use (PID $($conn.OwningProcess)). Stop any other dev server and retry." -ForegroundColor Red
        exit 1
    }
}
Start-Sleep -Seconds 5

# Optionally start Vault for credentials-with-vault E2E tests (continues without Vault if Docker unavailable)
$vaultCompose = Join-Path $platformRoot "dev\docker-compose.vault.ee.yml"
$vaultStarted = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "=== Starting Vault (Docker) for E2E ===" -ForegroundColor Cyan
    try {
        $ErrorActionPreference = "SilentlyContinue"
        & docker compose -f $vaultCompose up -d 2>&1 | Out-Null
        $ErrorActionPreference = "Stop"
    } catch {
        $ErrorActionPreference = "Stop"
        Write-Host "Docker Vault start failed (continuing without Vault): $_" -ForegroundColor Yellow
    }
    if ($LASTEXITCODE -eq 0) {
        $vaultStarted = $true
        Write-Host "Waiting for Vault at http://127.0.0.1:8200 ..." -ForegroundColor Yellow
        Start-Sleep -Seconds 8
        $vaultReady = $false
        for ($i = 0; $i -lt 30; $i++) {
            try {
                $r = Invoke-WebRequest -Uri "http://127.0.0.1:8200/v1/sys/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
                $vaultReady = $true
                Write-Host "Vault ready." -ForegroundColor Green
                break
            } catch {
                Start-Sleep -Seconds 2
            }
        }
        if ($vaultReady) {
            try {
                $body = '{"type":"kv","options":{"version":2}}'
                $headers = @{ "X-Vault-Token" = "dev-root-token"; "Content-Type" = "application/json" }
                Invoke-WebRequest -Uri "http://127.0.0.1:8200/v1/sys/mounts/secret" -Method PUT -Body $body -Headers $headers -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop | Out-Null
                Write-Host "Vault: enabled KV v2 at secret." -ForegroundColor Green
            } catch {
                if ($_.Exception.Response.StatusCode -eq 400) { Write-Host "Vault: secret mount already exists." -ForegroundColor Green }
            }
        } else {
            Write-Host "Vault did not become ready; credentials-with-vault tests will be skipped." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Docker not found; credentials-with-vault tests will be skipped. (Start Vault at localhost:8200 to run them.)" -ForegroundColor Yellow
}

function Wait-ForUrl {
    param([string]$Url, [int]$MaxAttempts = 60, [int]$DelayMs = 2000, [switch]$AcceptAnyStatus)
    for ($i = 0; $i -lt $MaxAttempts; $i++) {
        try {
            $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            return $true
        } catch {
            if ($AcceptAnyStatus -and $_.Exception.Response) { return $true }
            if ($i -eq 0) { Write-Host "Waiting for $Url ..." -ForegroundColor Yellow }
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    return $false
}

# Ensure backend has DB and env (always copy so it's fresh)
$platformEnv = Join-Path $platformRoot ".env"
$backendEnv = Join-Path $platformRoot "backend\.env"
$backendEnvExisted = Test-Path $backendEnv
if (Test-Path $platformEnv) {
    Copy-Item -Path $platformEnv -Destination $backendEnv -Force
}
$backendEnvCreated = -not $backendEnvExisted
if (Test-Path $platformEnv) {
    Get-Content $platformEnv | ForEach-Object {
        $line = $_
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$' -and $line.Trim() -notmatch '^\#') {
            $val = $matches[2].Trim()
            if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) { $val = $val.Substring(1, $val.Length - 2) }
            [System.Environment]::SetEnvironmentVariable($matches[1], $val, "Process")
        }
    }
}

# Frontend must proxy to local backend
$frontendDir = Join-Path $platformRoot "frontend"
$overridePath = Join-Path $frontendDir ".env.development.local"
$overrideBackup = Join-Path $frontendDir ".env.development.local.e2e-backup"
if (Test-Path $overridePath) {
    Move-Item -Path $overridePath -Destination $overrideBackup -Force
}
@"
ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000
NEXT_PUBLIC_ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000
"@ | Set-Content -Path $overridePath -Encoding utf8
$overrideWritten = $true

$env:ARCHESTRA_API_BASE_URL = "http://127.0.0.1:9000"
$env:NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://127.0.0.1:9000"

# --- Phase 1: start BACKEND only and wait for it ---
Write-Host "`n=== Phase 1: Starting BACKEND only ===" -ForegroundColor Cyan
$backendLog = Join-Path $platformRoot "backend-e2e.log"
# Run backend without redirect so it gets a real stdout (avoids hang in some envs)
$backendProc = Start-Process -FilePath "pnpm" -ArgumentList "--filter", "@backend", "dev" -WorkingDirectory $platformRoot -PassThru -WindowStyle Minimized

Write-Host "Backend building and starting (polling after 90s for build+seed). Check backend window if it hangs." -ForegroundColor Yellow
Start-Sleep -Seconds 90
if (-not (Wait-ForUrl -Url "http://127.0.0.1:9000/health" -AcceptAnyStatus -MaxAttempts 300 -DelayMs 2000)) {
    Write-Host "Backend (9000) did not become ready. Check: Postgres running, pnpm db:migrate, backend/.env (ARCHESTRA_DATABASE_URL), and the backend window for errors." -ForegroundColor Red
    if ($backendProc -and $backendProc.Id) {
        Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
    }
    exit 1
}
try {
    $healthResp = Invoke-WebRequest -Uri "http://127.0.0.1:9000/health" -UseBasicParsing -TimeoutSec 5
    $healthBody = $healthResp.Content
} catch {
    $healthBody = if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); $reader.ReadToEnd(); $reader.Close()
    } else { "" }
}
if ($healthBody -match "<Error>") {
    Write-Host "Backend (9000) returned wrong response. Ensure nothing else is on 9000." -ForegroundColor Red
    if ($backendProc -and $backendProc.Id) { Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}
Write-Host "Backend ready." -ForegroundColor Green

# --- Phase 2: start FRONTEND only and wait for it ---
Write-Host "`n=== Phase 2: Starting FRONTEND only ===" -ForegroundColor Cyan
$frontendProc = Start-Process -FilePath "pnpm" -ArgumentList "--filter", "@frontend", "dev" -WorkingDirectory $platformRoot -PassThru -WindowStyle Hidden

if (-not (Wait-ForUrl -Url "http://localhost:3000" -MaxAttempts 60 -DelayMs 2000)) {
    Write-Host "Frontend (3000) did not become ready." -ForegroundColor Red
    if ($frontendProc -and $frontendProc.Id) { Stop-Process -Id $frontendProc.Id -Force -ErrorAction SilentlyContinue }
    if ($backendProc -and $backendProc.Id) { Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}
Write-Host "Frontend ready." -ForegroundColor Green
Start-Sleep -Seconds 3

try {
    Write-Host "`n=== Running E2E tests ===" -ForegroundColor Cyan
    Push-Location (Join-Path $platformRoot "e2e-tests")
    try {
        # Stable run: setup + chromium-stable (Vault tests skip when Vault down; excludes known-flaky specs so run passes)
        pnpm exec playwright test --project=setup-admin --project=setup-users --project=setup-teams --project=chromium-stable
        $e2eExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $e2eExit
} finally {
    Write-Host "Stopping backend and frontend ..." -ForegroundColor Yellow
    Stop-ProcessOnPort -Port 3000
    Stop-ProcessOnPort -Port 9000
    if ($vaultStarted -and (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "Stopping Vault ..." -ForegroundColor Yellow
        docker compose -f $vaultCompose down 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 3
    foreach ($proc in @($backendProc, $frontendProc)) {
        if ($proc -and $proc.Id) {
            $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
            if ($p) {
                Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
                if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
                    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
    Start-Sleep -Seconds 1
    Stop-ProcessOnPort -Port 3000
    Stop-ProcessOnPort -Port 9000
    if ($overrideWritten) {
        Remove-Item -Path $overridePath -Force -ErrorAction SilentlyContinue
        if (Test-Path $overrideBackup) {
            Move-Item -Path $overrideBackup -Destination $overridePath -Force
        }
    }
    if ($backendEnvCreated -and (Test-Path $backendEnv)) {
        Remove-Item -Path $backendEnv -Force -ErrorAction SilentlyContinue
    }
}
