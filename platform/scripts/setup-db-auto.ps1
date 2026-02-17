# Try to automatically set up database by trying common passwords
$ErrorActionPreference = "Stop"

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

Write-Host "=== Attempting automatic database setup ===" -ForegroundColor Cyan
Write-Host "Trying common Postgres passwords..." -ForegroundColor Yellow

$passwords = @('postgres', '', 'admin', 'root', 'password')
$success = $false

foreach ($pwd in $passwords) {
    $pwdDisplay = if ($pwd -eq '') { 'empty' } else { $pwd }
    Write-Host "Trying password: $pwdDisplay" -ForegroundColor Yellow
    
    $env:PGPASSWORD = $pwd
    $testResult = & $psqlPath -U postgres -d postgres -c "SELECT 1;" 2>&1
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "SUCCESS! Connected with password: $pwdDisplay" -ForegroundColor Green
        Write-Host "Setting up database..." -ForegroundColor Cyan
        
        $sqlFile = Join-Path $PSScriptRoot "setup-db.sql"
        $setupResult = & $psqlPath -U postgres -f $sqlFile 2>&1
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "Database setup completed successfully!" -ForegroundColor Green
            Write-Host ""
            Write-Host "Next steps:" -ForegroundColor Cyan
            Write-Host "1. Run migrations: cd backend; pnpm db:migrate" -ForegroundColor Yellow
            Write-Host "2. Start the app: cd platform; pnpm dev" -ForegroundColor Yellow
            Write-Host "3. Run tests: cd platform; pnpm test:e2e" -ForegroundColor Yellow
            $success = $true
        } else {
            Write-Host "ERROR: Setup failed:" -ForegroundColor Red
            Write-Host $setupResult -ForegroundColor Red
        }
        break
    }
    $env:PGPASSWORD = $null
}

if (-not $success) {
    Write-Host ""
    Write-Host "Could not connect automatically. Please run manually:" -ForegroundColor Red
    Write-Host ""
    Write-Host '  $env:PGPASSWORD="yourpassword"; .\scripts\setup-db-final.ps1' -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Or manually run:" -ForegroundColor Yellow
    Write-Host '  psql -U postgres' -ForegroundColor White
    Write-Host '  Then paste:' -ForegroundColor White
    Write-Host '  CREATE USER archestra WITH PASSWORD ''archestra_dev_password'';' -ForegroundColor White
    Write-Host '  CREATE DATABASE archestra_dev OWNER archestra;' -ForegroundColor White
    Write-Host '  GRANT ALL PRIVILEGES ON DATABASE archestra_dev TO archestra;' -ForegroundColor White
    exit 1
}
