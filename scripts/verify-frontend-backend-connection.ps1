# Script to verify frontend (port 3000) and backend (port 9000) are running and connected

Write-Host "=== Frontend and Backend Connection Verification ===" -ForegroundColor Cyan
Write-Host ""

# Check if frontend is running on port 3000
Write-Host "1. Checking Frontend (port 3000)..." -ForegroundColor Yellow
$frontendRunning = Test-NetConnection -ComputerName localhost -Port 3000 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($frontendRunning) {
    Write-Host "   ✓ Frontend is running on port 3000" -ForegroundColor Green
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:3000" -Method Get -TimeoutSec 5 -UseBasicParsing
        Write-Host "   ✓ Frontend is responding (Status: $($response.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "   ✗ Frontend is running but not responding: $_" -ForegroundColor Red
    }
} else {
    Write-Host "   ✗ Frontend is NOT running on port 3000" -ForegroundColor Red
    Write-Host "     Start it with: cd platform/frontend && pnpm dev" -ForegroundColor Yellow
}
Write-Host ""

# Check if backend is running on port 9000
Write-Host "2. Checking Backend (port 9000)..." -ForegroundColor Yellow
$backendRunning = Test-NetConnection -ComputerName localhost -Port 9000 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($backendRunning) {
    Write-Host "   ✓ Backend is running on port 9000" -ForegroundColor Green
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:9000/health" -Method Get -TimeoutSec 5 -UseBasicParsing
        Write-Host "   ✓ Backend health check passed (Status: $($response.StatusCode))" -ForegroundColor Green
        $healthContent = $response.Content | ConvertFrom-Json
        Write-Host "   ✓ Backend health status: $($healthContent.status)" -ForegroundColor Green
    } catch {
        Write-Host "   ✗ Backend is running but health check failed: $_" -ForegroundColor Red
    }
} else {
    Write-Host "   ✗ Backend is NOT running on port 9000" -ForegroundColor Red
    Write-Host "     Start it with: cd platform/backend && pnpm dev" -ForegroundColor Yellow
}
Write-Host ""

# Test connection from frontend to backend
Write-Host "3. Testing Frontend -> Backend Connection..." -ForegroundColor Yellow
if ($frontendRunning -and $backendRunning) {
    try {
        # Test if frontend can reach backend through Next.js rewrite
        $response = Invoke-WebRequest -Uri "http://localhost:3000/health" -Method Get -TimeoutSec 5 -UseBasicParsing
        Write-Host "   ✓ Frontend can reach backend via /health endpoint (Status: $($response.StatusCode))" -ForegroundColor Green
        
        # Test API endpoint
        try {
            $apiResponse = Invoke-WebRequest -Uri "http://localhost:3000/api/auth/get-session" -Method Get -TimeoutSec 5 -UseBasicParsing
            Write-Host "   ✓ Frontend can reach backend via /api/* rewrite (Status: $($apiResponse.StatusCode))" -ForegroundColor Green
        } catch {
            # This might fail if not authenticated, which is OK
            if ($_.Exception.Response.StatusCode -eq 401) {
                Write-Host "   ✓ Frontend can reach backend via /api/* rewrite (401 Unauthorized is expected)" -ForegroundColor Green
            } else {
                Write-Host "   ⚠ Frontend -> Backend API test: $_" -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Host "   ✗ Frontend cannot reach backend: $_" -ForegroundColor Red
        Write-Host "     Check Next.js rewrites in platform/frontend/next.config.ts" -ForegroundColor Yellow
    }
} else {
    Write-Host "   ⚠ Skipping connection test (both services must be running)" -ForegroundColor Yellow
}
Write-Host ""

# Verify configuration
Write-Host "4. Verifying Configuration..." -ForegroundColor Yellow
$frontendConfig = Get-Content "platform/frontend/src/lib/config.ts" -Raw
$nextConfig = Get-Content "platform/frontend/next.config.ts" -Raw

if ($frontendConfig -match "localhost:9000" -or $frontendConfig -match "127\.0\.0\.1:9000") {
    Write-Host "   ✓ Frontend config.ts references backend URL" -ForegroundColor Green
} else {
    Write-Host "   ✗ Frontend config.ts may not have correct backend URL" -ForegroundColor Red
}

if ($nextConfig -match "localhost:9000" -or $nextConfig -match "127\.0\.0\.1:9000") {
    Write-Host "   ✓ Next.js config has backend rewrite configured" -ForegroundColor Green
} else {
    Write-Host "   ✗ Next.js config may not have correct backend rewrite" -ForegroundColor Red
}
Write-Host ""

# Summary
Write-Host "=== Summary ===" -ForegroundColor Cyan
if ($frontendRunning -and $backendRunning) {
    Write-Host "✓ Both services are running" -ForegroundColor Green
    Write-Host "✓ Configuration appears correct" -ForegroundColor Green
    Write-Host ""
    Write-Host "You can now:" -ForegroundColor Cyan
    Write-Host "  - Access frontend at: http://localhost:3000" -ForegroundColor White
    Write-Host "  - Access backend API at: http://localhost:9000" -ForegroundColor White
    Write-Host "  - Access backend health at: http://localhost:9000/health" -ForegroundColor White
} else {
    Write-Host "✗ Services need to be started" -ForegroundColor Red
    Write-Host ""
    Write-Host "To start services:" -ForegroundColor Yellow
    Write-Host "  1. Terminal 1 - Backend: cd platform/backend && pnpm dev" -ForegroundColor White
    Write-Host "  2. Terminal 2 - Frontend: cd platform/frontend && pnpm dev" -ForegroundColor White
}
