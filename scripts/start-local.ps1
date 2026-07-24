# Start local broker stack (Redis + Redpanda + sandbox-runtime + Broker)
param(
  [switch]$Build
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deploy = Join-Path $root "deploy\local"

Push-Location $root
try {
  Write-Host "Building packages..."
  npm run build
  Write-Host "Ensuring E2B-compatible sandbox image..."
  & (Join-Path $PSScriptRoot "build-e2b-image.ps1")
} finally {
  Pop-Location
}

Push-Location $deploy
try {
  if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Warning "Created deploy/local/.env — default SANDBOX_PROVIDER=e2b; set DAYTONA_* only if using daytona"
  }
  if ($Build) {
    docker compose up -d --build
  } else {
    docker compose up -d
  }
  Write-Host "Waiting for broker + sandbox-runtime..."
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $h = Invoke-RestMethod http://localhost:8080/health -TimeoutSec 2
      $r = Invoke-RestMethod http://localhost:8090/health -TimeoutSec 2
      Write-Host "Broker: $($h | ConvertTo-Json -Compress)"
      Write-Host "Runtime: $($r | ConvertTo-Json -Compress)"
      break
    } catch {
      Start-Sleep -Seconds 2
    }
  }
} finally {
  Pop-Location
}
