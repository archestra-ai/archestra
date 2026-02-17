# Setup Postgres database for local development
# Creates user 'archestra' with password 'archestra_dev_password' and database 'archestra_dev'
# Run from platform root: .\scripts\setup-db.ps1
# Or with password: $env:PGPASSWORD='yourpass'; .\scripts\setup-db.ps1

param(
    [string]$SuperUser = "postgres",
    [string]$SuperPassword = $env:PGPASSWORD
)

$ErrorActionPreference = "Stop"
$platformRoot = if ($PSScriptRoot) { Join-Path $PSScriptRoot ".." } else { $PWD }

Write-Host "=== Setting up Postgres database ===" -ForegroundColor Cyan

# Database configuration (matches .env)
$DB_USER = "archestra"
$DB_PASSWORD = "archestra_dev_password"
$DB_NAME = "archestra_dev"
$DB_HOST = "localhost"
$DB_PORT = "5432"

# Try to find psql
$psqlPath = $null
$possiblePaths = @(
    "psql",
    "C:\Program Files\PostgreSQL\*\bin\psql.exe",
    "C:\Program Files (x86)\PostgreSQL\*\bin\psql.exe",
    "$env:ProgramFiles\PostgreSQL\*\bin\psql.exe",
    "$env:ProgramFiles(x86)\PostgreSQL\*\bin\psql.exe"
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

if (-not $psqlPath) {
    Write-Host "ERROR: psql not found. Please install PostgreSQL or add psql to PATH." -ForegroundColor Red
    Write-Host "Download from: https://www.postgresql.org/download/windows/" -ForegroundColor Yellow
    exit 1
}

Write-Host "Found psql at: $psqlPath" -ForegroundColor Green

# Try to connect - if password needed, prompt
if (-not $SuperPassword) {
    Write-Host "`nPostgres superuser password not provided." -ForegroundColor Yellow
    Write-Host "Attempting connection without password (trust/local auth)..." -ForegroundColor Yellow
    Write-Host "If this fails, set password: `$env:PGPASSWORD='yourpass'; .\scripts\setup-db.ps1" -ForegroundColor Yellow
}

# SQL commands to create user and database
$sql = @"
-- Create user if not exists
DO `$`$`$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DB_USER') THEN
        CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    ELSE
        ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    END IF;
END
`$`$`$;

-- Create database if not exists
SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
"@

Write-Host "`nCreating user '$DB_USER' and database '$DB_NAME'..." -ForegroundColor Cyan

$env:PGPASSWORD = $SuperPassword
$sqlFile = Join-Path $env:TEMP "setup-db-$(Get-Random).sql"
$sql | Out-File -FilePath $sqlFile -Encoding utf8

try {
    $cmd = "& `"$psqlPath`" -h $DB_HOST -p $DB_PORT -U $SuperUser -d postgres -f `"$sqlFile`" 2>&1"
    $output = Invoke-Expression $cmd
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Database setup completed successfully!" -ForegroundColor Green
        Write-Host "User: $DB_USER" -ForegroundColor Green
        Write-Host "Database: $DB_NAME" -ForegroundColor Green
        Write-Host "Connection string: postgresql://$DB_USER`:$DB_PASSWORD@$DB_HOST`:$DB_PORT/$DB_NAME?schema=public" -ForegroundColor Green
    } else {
        Write-Host "ERROR: Database setup failed:" -ForegroundColor Red
        Write-Host $output -ForegroundColor Red
        Write-Host "`nTry with password:" -ForegroundColor Yellow
        Write-Host "  `$env:PGPASSWORD='yourpassword'; .\scripts\setup-db.ps1" -ForegroundColor Yellow
        exit 1
    }
} finally {
    $env:PGPASSWORD = $null
    Remove-Item -Path $sqlFile -ErrorAction SilentlyContinue
}

Write-Host "`n=== Verifying connection ===" -ForegroundColor Cyan
$env:PGPASSWORD = $DB_PASSWORD
$verifyCmd = "& `"$psqlPath`" -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c `"SELECT version();`" 2>&1"
$verifyOutput = Invoke-Expression $verifyCmd
$env:PGPASSWORD = $null

if ($LASTEXITCODE -eq 0) {
    Write-Host "Connection verified! Database is ready." -ForegroundColor Green
} else {
    Write-Host "WARNING: Could not verify connection:" -ForegroundColor Yellow
    Write-Host $verifyOutput -ForegroundColor Yellow
    Write-Host "You may need to run migrations: cd backend && pnpm db:migrate" -ForegroundColor Yellow
}

Write-Host "`n=== Next steps ===" -ForegroundColor Cyan
Write-Host "1. Run migrations: cd backend && pnpm db:migrate" -ForegroundColor Yellow
Write-Host "2. Start the app: cd platform && pnpm dev" -ForegroundColor Yellow
Write-Host "3. Run tests: cd platform && pnpm test:e2e" -ForegroundColor Yellow
