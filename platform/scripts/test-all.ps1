# Run all tests: unit, integration, E2E, and optionally Playwright codegen for exploratory.
# E2E and codegen require the app to be running (pnpm dev in another terminal).

param(
    [switch]$SkipE2e,
    [switch]$Exploratory
)

$ErrorActionPreference = "Stop"
$platformRoot = Join-Path $PSScriptRoot ".."

Write-Host "=== 1. Unit + Integration (Vitest) ===" -ForegroundColor Cyan
Set-Location $platformRoot
pnpm test -- --run
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n=== 2. Type-check ===" -ForegroundColor Cyan
pnpm type-check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipE2e) {
    Write-Host "`n=== 3. E2E (Playwright) ===" -ForegroundColor Cyan
    Write-Host "Ensure app is running: pnpm dev (frontend :3000, backend :9000)" -ForegroundColor Yellow
    Set-Location (Join-Path $platformRoot "e2e-tests")
    pnpm exec playwright test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if ($Exploratory) {
    Write-Host "`n=== 4. Playwright Codegen (exploratory) ===" -ForegroundColor Cyan
    Write-Host "Opening browser at http://localhost:3000 - interact to record." -ForegroundColor Yellow
    Set-Location (Join-Path $platformRoot "e2e-tests")
    pnpm exec playwright codegen http://localhost:3000
}

Write-Host "`nAll requested tests completed." -ForegroundColor Green
