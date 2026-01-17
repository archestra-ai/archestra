#!/bin/bash
# Test CI/CD checks locally before opening a PR
# This script runs the same checks that GitHub Actions runs on pull requests

set -e

SKIP_E2E=false
SKIP_LICENSE=false
SKIP_CODEGEN=false
SKIP_DB_MIGRATIONS=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-e2e)
            SKIP_E2E=true
            shift
            ;;
        --skip-license)
            SKIP_LICENSE=true
            shift
            ;;
        --skip-codegen)
            SKIP_CODEGEN=true
            shift
            ;;
        --skip-db-migrations)
            SKIP_DB_MIGRATIONS=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--skip-e2e] [--skip-license] [--skip-codegen] [--skip-db-migrations]"
            exit 1
            ;;
    esac
done

PLATFORM_DIR="platform"

echo "🚀 Running CI checks locally..."
echo ""

# Check if we're in the right directory
if [ ! -d "$PLATFORM_DIR" ]; then
    echo "❌ Error: 'platform' directory not found. Please run this script from the repository root."
    exit 1
fi

# Change to platform directory
cd "$PLATFORM_DIR"

# 1. Type checking, linting, formatting, tests, knip
echo "📋 Step 1/5: Running type-check, lint, test, and knip..."
echo "   (This runs: type-check, test, knip, biome ci)"
pnpm check:ci
echo "✅ Type checking, linting, and tests passed"
echo ""

# 2. Codegen validation
if [ "$SKIP_CODEGEN" = false ]; then
    echo "📦 Step 2/5: Validating codegen..."
    echo "   (Running: pnpm codegen && pnpm lint:fix)"
    
    # Check for uncommitted changes before codegen
    git diff --exit-code > /dev/null 2>&1 || true
    git diff --cached --exit-code > /dev/null 2>&1 || true
    
    # Run codegen
    CODEGEN=true pnpm codegen
    pnpm lint:fix
    
    # Check for changes
    if ! git diff --exit-code > /dev/null 2>&1 || ! git diff --cached --exit-code > /dev/null 2>&1; then
        echo "❌ Generated code is not up to date!"
        echo "   Please run 'pnpm codegen && pnpm lint:fix' and commit the changes."
        echo ""
        echo "   Changed files:"
        git diff --name-only
        exit 1
    fi
    
    echo "✅ Codegen is up to date"
    echo ""
else
    echo "⏭️  Step 2/5: Skipping codegen validation (--skip-codegen)"
    echo ""
fi

# 3. Database migration validation
if [ "$SKIP_DB_MIGRATIONS" = false ]; then
    echo "🗄️  Step 3/5: Validating database migrations..."
    echo "   (Running: pnpm db:generate to check for pending migrations)"
    
    # Check for uncommitted changes before db:generate
    git diff --exit-code > /dev/null 2>&1 || true
    
    # Run db:generate with timeout (15 seconds like CI)
    if timeout 15s pnpm db:generate > /tmp/db_generate_output.txt 2>&1; then
        output=$(cat /tmp/db_generate_output.txt)
        echo "$output"
        
        # Check for interactive prompts
        if echo "$output" | grep -q "❯\|Is.*table created or renamed"; then
            echo "❌ Interactive prompt detected - pending database migrations need to be committed"
            echo "   Please run 'pnpm db:generate' locally and commit the migration files."
            exit 1
        fi
    else
        exit_code=$?
        cat /tmp/db_generate_output.txt 2>/dev/null || true
        if [ $exit_code -eq 124 ]; then
            echo "❌ Command timed out - likely waiting for interactive input about pending migrations"
        else
            echo "❌ pnpm db:generate failed with exit code $exit_code"
        fi
        exit 1
    fi
    
    # Check for uncommitted migration files
    if ! git diff --exit-code > /dev/null 2>&1 || ! git diff --cached --exit-code > /dev/null 2>&1; then
        echo "❌ Database schema has changed but migrations are missing!"
        echo "   Please run 'pnpm db:generate' locally and commit the migration files."
        echo ""
        echo "   Changed files:"
        git diff --name-only
        exit 1
    fi
    
    echo "✅ No pending database migrations"
    echo ""
else
    echo "⏭️  Step 3/5: Skipping database migration validation (--skip-db-migrations)"
    echo ""
fi

# 4. License compliance check
if [ "$SKIP_LICENSE" = false ]; then
    echo "📜 Step 4/5: Running license compliance check..."
    echo "   (This checks for GPL/AGPL/Unknown licenses)"
    pnpm license-check --ci
    echo "✅ License compliance check passed"
    echo ""
else
    echo "⏭️  Step 4/5: Skipping license compliance check (--skip-license)"
    echo ""
fi

# 5. E2E tests (optional, as they require Docker/Kubernetes)
if [ "$SKIP_E2E" = false ]; then
    echo "🧪 Step 5/5: E2E tests..."
    echo "   ⚠️  E2E tests require Docker and Kubernetes setup."
    echo "   ⚠️  This is complex to run locally. Consider running in CI or skipping with --skip-e2e"
    echo ""
    read -p "   Do you want to skip E2E tests? (Y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
        echo "⏭️  Skipping E2E tests"
    else
        echo "   Running E2E tests..."
        echo "   ⚠️  Make sure Docker and Kubernetes are set up first!"
        pnpm test:e2e
        echo "✅ E2E tests passed"
    fi
    echo ""
else
    echo "⏭️  Step 5/5: Skipping E2E tests (--skip-e2e)"
    echo ""
fi

echo "🎉 All CI checks passed!"
echo ""
echo "✅ Your PR should pass CI/CD checks."
echo ""
echo "💡 Additional checks you can run manually:"
echo "   - PR Title Linting: Use commitlint to validate PR title format"
echo "   - Docker Image Scanning: Build and scan Docker image (requires Docker Hub auth)"
echo "   - Helm Chart Linting: Run 'helm lint' in platform/helm/archestra"
