# ONE-LINER DATABASE SETUP - RUN THIS WITH YOUR POSTGRES PASSWORD
# Usage: $env:PGPASSWORD='yourpassword'; .\scripts\SETUP-DATABASE-NOW.ps1

param(
    [Parameter(Mandatory=$false)]
    [string]$Password = $env:PGPASSWORD
)

if (-not $Password) {
    Write-Host "ERROR: Postgres password required!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Run this command:" -ForegroundColor Yellow
    Write-Host '  $env:PGPASSWORD="yourpassword"; .\scripts\SETUP-DATABASE-NOW.ps1' -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Or provide password as parameter:" -ForegroundColor Yellow
    Write-Host '  .\scripts\SETUP-DATABASE-NOW.ps1 -Password "yourpassword"' -ForegroundColor Cyan
    exit 1
}

$psqlPath = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
if (-not (Test-Path $psqlPath)) {
    $found = Get-Command psql -ErrorAction SilentlyContinue
    if ($found) { $psqlPath = $found.Path } else {
        Write-Host "ERROR: psql not found!" -ForegroundColor Red
        exit 1
    }
}

Write-Host "=== Setting up database ===" -ForegroundColor Cyan

$env:PGPASSWORD = $Password

try {
    $sql = @"
CREATE USER archestra WITH PASSWORD 'archestra_dev_password';
CREATE DATABASE archestra_dev OWNER archestra;
GRANT ALL PRIVILEGES ON DATABASE archestra_dev TO archestra;
"@
    
    $result = $sql | & $psqlPath -U postgres 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "✓ DATABASE SETUP COMPLETE!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Running migrations..." -ForegroundColor Cyan
        Set-Location backend
        pnpm db:migrate
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "✓ MIGRATIONS COMPLETE!" -ForegroundColor Green
            Write-Host ""
            Write-Host "Starting app..." -ForegroundColor Cyan
            Set-Location ..
            Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; pnpm dev"
            Write-Host ""
            Write-Host "✓ APP STARTING IN NEW WINDOW!" -ForegroundColor Green
            Write-Host ""
            Write-Host "Waiting 10 seconds for app to start, then running tests..." -ForegroundColor Cyan
            Start-Sleep -Seconds 10
            Write-Host ""
            Write-Host "Running E2E tests..." -ForegroundColor Cyan
            pnpm test:e2e
        } else {
            Write-Host "ERROR: Migrations failed" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "ERROR: Database setup failed:" -ForegroundColor Red
        Write-Host $result -ForegroundColor Red
        exit 1
    }
} finally {
    $env:PGPASSWORD = $null
}
