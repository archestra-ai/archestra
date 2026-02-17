# Simple database setup helper - provides SQL commands to run manually
# Run: .\scripts\setup-db-simple.ps1

Write-Host "=== Database Setup Instructions ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "The backend needs a Postgres user 'archestra' and database 'archestra_dev'." -ForegroundColor Yellow
Write-Host ""
Write-Host "Run these commands in psql (as Postgres superuser):" -ForegroundColor Green
Write-Host ""
Write-Host "  psql -U postgres" -ForegroundColor White
Write-Host ""
Write-Host "Then paste these SQL commands:" -ForegroundColor Green
Write-Host ""
Write-Host "  CREATE USER archestra WITH PASSWORD 'archestra_dev_password';" -ForegroundColor White
Write-Host "  CREATE DATABASE archestra_dev OWNER archestra;" -ForegroundColor White
Write-Host "  GRANT ALL PRIVILEGES ON DATABASE archestra_dev TO archestra;" -ForegroundColor White
Write-Host "  \q" -ForegroundColor White
Write-Host ""
Write-Host "After creating the database, run migrations:" -ForegroundColor Yellow
Write-Host "  cd backend && pnpm db:migrate" -ForegroundColor White
Write-Host ""
Write-Host "Then start the app:" -ForegroundColor Yellow
Write-Host "  cd platform && pnpm dev" -ForegroundColor White
Write-Host ""

# Try to open psql automatically
$psqlPath = $null
$possiblePaths = @(
    "psql",
    "C:\Program Files\PostgreSQL\*\bin\psql.exe",
    "$env:ProgramFiles\PostgreSQL\*\bin\psql.exe"
)

foreach ($path in $possiblePaths) {
    if ($path -like "*\*") {
        $found = Get-ChildItem -Path $path -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $psqlPath = $found.FullName
            break
        }
    } else {
        $found = Get-Command $path -ErrorAction SilentlyContinue
        if ($found) {
            $psqlPath = $found.Path
            break
        }
    }
}

if ($psqlPath) {
    Write-Host "Found psql at: $psqlPath" -ForegroundColor Green
    Write-Host ""
    $response = Read-Host "Would you like to open psql now? (y/n)"
    if ($response -eq "y" -or $response -eq "Y") {
        Write-Host "Opening psql. After connecting, paste the SQL commands above." -ForegroundColor Cyan
        Start-Process $psqlPath -ArgumentList "-U", "postgres"
    }
} else {
    Write-Host "psql not found. Install PostgreSQL or add it to PATH." -ForegroundColor Yellow
}
