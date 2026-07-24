# Start local broker stack (Redis + Redpanda + Broker)
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
} finally {
  Pop-Location
}

Push-Location $deploy
try {
  if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Warn "Created deploy/local/.env — please set DAYTONA_API_KEY"
  }
  if ($Build) {
    docker compose up -d --build
  } else {
    docker compose up -d
  }
  Write-Host "Waiting for broker..."
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $h = Invoke-RestMethod http://localhost:8080/health -TimeoutSec 2
      Write-Host "Broker healthy: $($h | ConvertTo-Json -Compress)"
      break
    } catch {
      Start-Sleep -Seconds 2
    }
  }
} finally {
  Pop-Location
}
