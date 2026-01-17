# Local CI/CD Testing Scripts

These scripts help you test CI/CD checks locally before opening a PR, ensuring your PR will pass all GitHub Actions checks.

## Quick Start

### Windows (PowerShell)
```powershell
.\scripts\test-ci-locally.ps1
```

### Linux/macOS (Bash)
```bash
./scripts/test-ci-locally.sh
```

### Cross-platform (Node.js)
```bash
cd platform
node ../scripts/test-ci-locally.js
```

Or use the npm script:
```bash
cd platform
pnpm test:ci
```

## What It Checks

The script runs the same checks that GitHub Actions runs on pull requests:

1. **Type checking, linting, formatting, tests, knip** (`pnpm check:ci`)
   - TypeScript type checking
   - Unit tests
   - Knip (unused code detection)
   - Biome CI (linting and formatting)

2. **Codegen validation**
   - Runs `pnpm codegen && pnpm lint:fix`
   - Checks if generated code is up to date
   - Fails if there are uncommitted changes to generated files

3. **Database migration validation**
   - Runs `pnpm db:generate` with timeout
   - Checks for pending database migrations
   - Fails if schema changes aren't committed

4. **License compliance check** (`pnpm license-check --ci`)
   - Checks for GPL/AGPL/Unknown licenses in dependencies

5. **E2E tests** (optional)
   - Requires Docker and Kubernetes setup
   - Usually skipped locally

## Options

### PowerShell
```powershell
.\scripts\test-ci-locally.ps1 -SkipE2E -SkipLicense -SkipCodegen -SkipDbMigrations
```

### Bash
```bash
./scripts/test-ci-locally.sh --skip-e2e --skip-license --skip-codegen --skip-db-migrations
```

### Node.js
```bash
node scripts/test-ci-locally.js --skip-e2e --skip-license --skip-codegen --skip-db-migrations
```

## Additional Checks

Some checks are harder to run locally but are still validated in CI:

- **PR Title Linting**: Uses commitlint to validate PR title format
  - Format: `type(scope): subject`
  - Types: `feat`, `fix`, `perf`, `docs`, `deps`, `ci`, `refactor`, `revert`, `test`, `chore`
  - Example: `feat(minimax): add MiniMax LLM provider support`

- **Docker Image Scanning**: Builds and scans Docker image for CVEs
  - Requires Docker Hub authentication
  - Usually only runs on merge queue

- **Helm Chart Linting**: Validates Helm chart syntax
  ```bash
  cd platform/helm/archestra
  helm lint .
  helm unittest .
  ```

## Troubleshooting

### Codegen fails
```bash
cd platform
pnpm codegen
pnpm lint:fix
git add .
git commit -m "chore: update generated code"
```

### Database migrations pending
```bash
cd platform
pnpm db:generate
# Review the generated migration files
git add backend/src/database/migrations/
git commit -m "chore: add database migration"
```

### License check fails
```bash
cd platform
pnpm license-check
# Review the output and update dependencies if needed
```

### Type errors
```bash
cd platform
pnpm type-check
# Fix TypeScript errors
```

### Linting errors
```bash
cd platform
pnpm lint:fix
# Review and commit auto-fixes
```

## CI/CD Workflow Reference

The main workflows that run on PRs:
- `.github/workflows/on-pull-requests.yml` - Main PR workflow
- `.github/workflows/platform-linting-and-tests.yml` - Platform checks

See these files for the exact commands and checks that run in CI.
