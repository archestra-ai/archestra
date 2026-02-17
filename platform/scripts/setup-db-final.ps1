# Final database setup - run with Postgres superuser password
# Usage: $env:PGPASSWORD='yourpassword'; .\scripts\setup-db-final.ps1
# Or: .\scripts\setup-db-final.ps1 -Password 'yourpassword'

param(
    [string]$Password = $env:PGPASSWORD
)

$ErrorActionPreference = "Stop"

if (-not $Password) {
    Write-Host "ERROR: Postgres superuser password required!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Usage:" -ForegroundColor Yellow
    Write-Host "  `$env:PGPASSWORD='yourpassword'; .\scripts\setup-db-final.ps1" -ForegroundColor White
    Write-Host "  Or: .\scripts\setup-db-final.ps1 -Password 'yourpassword'" -ForegroundColor White
    Write-Host ""
    Write-Host "If you don't know the password, run manually:" -ForegroundColor Yellow
    Write-Host "  psql -U postgres" -ForegroundColor White
    Write-Host "  Then paste:" -ForegroundColor White
    Write-Host "  CREATE USER archestra WITH PASSWORD 'archestra_dev_password';" -ForegroundColor White
    Write-Host "  CREATE DATABASE archestra_dev OWNER archestra;" -ForegroundColor White
    Write-Host "  GRANT ALL PRIVILEGES ON DATABASE archestra_dev TO archestra;" -ForegroundColor White
    exit 1
}

$psqlPath = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
if (-not (Test-Path $psqlPath)) {
    $found = Get-Command psql -ErrorAction SilentlyContinue
    if ($found) {
        $psqlPath = $found.Path
    } else {
        Write-Host "ERROR: psql not found!" -ForegroundColor Red
        exit 1
    }
}

Write-Host "=== Setting up Postgres database ===" -ForegroundColor Cyan
Write-Host "Creating user 'archestra' and database 'archestra_dev'..." -ForegroundColor Yellow

$env:PGPASSWORD = $Password

try {
    $sqlFile = Join-Path $PSScriptRoot "setup-db.sql"
    $result = & $psqlPath -U postgres -f $sqlFile 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "✓ Database setup completed successfully!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Next steps:" -ForegroundColor Cyan
        Write-Host "1. Run migrations: cd backend && pnpm db:migrate" -ForegroundColor Yellow
        Write-Host "2. Start the app: cd platform && pnpm dev" -ForegroundColor Yellow
        Write-Host "3. Run tests: cd platform && pnpm test:e2e" -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "ERROR: Setup failed:" -ForegroundColor Red
        Write-Host $result -ForegroundColor Red
        exit 1
    }
} finally {
    $env:PGPASSWORD = $null
}
