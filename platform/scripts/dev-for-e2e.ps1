# Launcher for E2E: set backend URL to localhost so frontend proxies to local backend, then run pnpm dev.
# Called by run-e2e-with-app.ps1; do not run directly unless you want dev with forced local API.
$ErrorActionPreference = "Stop"
$platformRoot = if ($PSScriptRoot) { Join-Path $PSScriptRoot ".." } else { $PWD }
$env:ARCHESTRA_API_BASE_URL = "http://127.0.0.1:9000"
$env:NEXT_PUBLIC_ARCHESTRA_API_BASE_URL = "http://127.0.0.1:9000"
Set-Location $platformRoot
& pnpm run dev
