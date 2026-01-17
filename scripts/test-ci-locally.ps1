# Test CI/CD checks locally before opening a PR
# This script runs the same checks that GitHub Actions runs on pull requests

param(
    [switch]$SkipE2E,
    [switch]$SkipLicense,
    [switch]$SkipCodegen,
    [switch]$SkipDbMigrations
)

$ErrorActionPreference = "Stop"
$platformDir = "platform"

Write-Host "🚀 Running CI checks locally..." -ForegroundColor Cyan
Write-Host ""

# Check if we're in the right directory
if (-not (Test-Path $platformDir)) {
    Write-Host "❌ Error: 'platform' directory not found. Please run this script from the repository root." -ForegroundColor Red
    exit 1
}

# Change to platform directory
Push-Location $platformDir

try {
    # 1. Type checking, linting, formatting, tests, knip
    Write-Host "📋 Step 1/5: Running type-check, lint, test, and knip..." -ForegroundColor Yellow
    Write-Host "   (This runs: type-check, test, knip, biome ci)" -ForegroundColor Gray
    pnpm check:ci
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ check:ci failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Type checking, linting, and tests passed" -ForegroundColor Green
    Write-Host ""

    # 2. Codegen validation
    if (-not $SkipCodegen) {
        Write-Host "📦 Step 2/5: Validating codegen..." -ForegroundColor Yellow
        Write-Host "   (Running: pnpm codegen && pnpm lint:fix)" -ForegroundColor Gray
        
        # Check for uncommitted changes before codegen
        $beforeChanges = git diff --exit-code 2>&1
        $beforeStaged = git diff --cached --exit-code 2>&1
        
        # Run codegen
        $env:CODEGEN = "true"
        pnpm codegen
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ codegen failed" -ForegroundColor Red
            exit 1
        }
        
        pnpm lint:fix
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ lint:fix failed" -ForegroundColor Red
            exit 1
        }
        
        # Check for changes
        $afterChanges = git diff --exit-code 2>&1
        $afterStaged = git diff --cached --exit-code 2>&1
        
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ Generated code is not up to date!" -ForegroundColor Red
            Write-Host "   Please run 'pnpm codegen && pnpm lint:fix' and commit the changes." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "   Changed files:" -ForegroundColor Yellow
            git diff --name-only
            exit 1
        }
        
        Write-Host "✅ Codegen is up to date" -ForegroundColor Green
        Write-Host ""
    } else {
        Write-Host "⏭️  Step 2/5: Skipping codegen validation (--SkipCodegen)" -ForegroundColor Gray
        Write-Host ""
    }

    # 3. Database migration validation
    if (-not $SkipDbMigrations) {
        Write-Host "🗄️  Step 3/5: Validating database migrations..." -ForegroundColor Yellow
        Write-Host "   (Running: pnpm db:generate to check for pending migrations)" -ForegroundColor Gray
        
        # Check for uncommitted changes before db:generate
        $beforeChanges = git diff --exit-code 2>&1
        
        # Run db:generate with timeout (15 seconds like CI)
        $dbGenerateOutput = ""
        $dbGenerateProcess = Start-Process -FilePath "pnpm" -ArgumentList "db:generate" -NoNewWindow -PassThru -RedirectStandardOutput "db_generate_output.txt" -RedirectStandardError "db_generate_error.txt"
        
        # Wait up to 15 seconds
        $timeout = 15
        $elapsed = 0
        while (-not $dbGenerateProcess.HasExited -and $elapsed -lt $timeout) {
            Start-Sleep -Seconds 1
            $elapsed++
        }
        
        if (-not $dbGenerateProcess.HasExited) {
            Stop-Process -Id $dbGenerateProcess.Id -Force -ErrorAction SilentlyContinue
            Write-Host "❌ db:generate timed out (likely waiting for interactive input)" -ForegroundColor Red
            Write-Host "   This usually means there are pending database migrations." -ForegroundColor Yellow
            Write-Host "   Please run 'pnpm db:generate' locally and commit the migration files." -ForegroundColor Yellow
            exit 1
        }
        
        # Read output
        if (Test-Path "db_generate_output.txt") {
            $dbGenerateOutput = Get-Content "db_generate_output.txt" -Raw
            Remove-Item "db_generate_output.txt" -ErrorAction SilentlyContinue
        }
        Remove-Item "db_generate_error.txt" -ErrorAction SilentlyContinue
        
        # Check for interactive prompts
        if ($dbGenerateOutput -match "❯|Is.*table created or renamed") {
            Write-Host "❌ Interactive prompt detected - pending database migrations need to be committed" -ForegroundColor Red
            Write-Host "   Please run 'pnpm db:generate' locally and commit the migration files." -ForegroundColor Yellow
            exit 1
        }
        
        # Check for uncommitted migration files
        $afterChanges = git diff --exit-code 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ Database schema has changed but migrations are missing!" -ForegroundColor Red
            Write-Host "   Please run 'pnpm db:generate' locally and commit the migration files." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "   Changed files:" -ForegroundColor Yellow
            git diff --name-only
            exit 1
        }
        
        Write-Host "✅ No pending database migrations" -ForegroundColor Green
        Write-Host ""
    } else {
        Write-Host "⏭️  Step 3/5: Skipping database migration validation (--SkipDbMigrations)" -ForegroundColor Gray
        Write-Host ""
    }

    # 4. License compliance check
    if (-not $SkipLicense) {
        Write-Host "📜 Step 4/5: Running license compliance check..." -ForegroundColor Yellow
        Write-Host "   (This checks for GPL/AGPL/Unknown licenses)" -ForegroundColor Gray
        pnpm license-check --ci
        if ($LASTEXITCODE -ne 0) {
            Write-Host "❌ License compliance check failed" -ForegroundColor Red
            Write-Host "   Run 'pnpm license-check' to see full details." -ForegroundColor Yellow
            exit 1
        }
        Write-Host "✅ License compliance check passed" -ForegroundColor Green
        Write-Host ""
    } else {
        Write-Host "⏭️  Step 4/5: Skipping license compliance check (--SkipLicense)" -ForegroundColor Gray
        Write-Host ""
    }

    # 5. E2E tests (optional, as they require Docker/Kubernetes)
    if (-not $SkipE2E) {
        Write-Host "🧪 Step 5/5: E2E tests..." -ForegroundColor Yellow
        Write-Host "   ⚠️  E2E tests require Docker and Kubernetes setup." -ForegroundColor Yellow
        Write-Host "   ⚠️  This is complex to run locally. Consider running in CI or skipping with --SkipE2E" -ForegroundColor Yellow
        Write-Host ""
        $response = Read-Host "   Do you want to skip E2E tests? (Y/n)"
        if ($response -eq "" -or $response -eq "Y" -or $response -eq "y") {
            Write-Host "⏭️  Skipping E2E tests" -ForegroundColor Gray
        } else {
            Write-Host "   Running E2E tests..." -ForegroundColor Yellow
            Write-Host "   ⚠️  Make sure Docker and Kubernetes are set up first!" -ForegroundColor Yellow
            pnpm test:e2e
            if ($LASTEXITCODE -ne 0) {
                Write-Host "❌ E2E tests failed" -ForegroundColor Red
                exit 1
            }
            Write-Host "✅ E2E tests passed" -ForegroundColor Green
        }
        Write-Host ""
    } else {
        Write-Host "⏭️  Step 5/5: Skipping E2E tests (--SkipE2E)" -ForegroundColor Gray
        Write-Host ""
    }

    Write-Host "🎉 All CI checks passed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "✅ Your PR should pass CI/CD checks." -ForegroundColor Green
    Write-Host ""
    Write-Host "💡 Additional checks you can run manually:" -ForegroundColor Cyan
    Write-Host "   - PR Title Linting: Use commitlint to validate PR title format" -ForegroundColor Gray
    Write-Host "   - Docker Image Scanning: Build and scan Docker image (requires Docker Hub auth)" -ForegroundColor Gray
    Write-Host "   - Helm Chart Linting: Run 'helm lint' in platform/helm/archestra" -ForegroundColor Gray

} catch {
    Write-Host "❌ Error: $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
