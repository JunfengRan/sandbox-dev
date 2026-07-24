# Build and push multi-user snapshot to local Daytona registry
param(
  [string]$Tag = "0.1.1",
  [string]$Registry = "localhost:6000",
  [string]$ImageName = "daytona/sandbox-dev-multi-user"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dockerfile = Join-Path $root "snapshots\Dockerfile.multi-user"
$context = Join-Path $root "snapshots"
$localTag = "sandbox-dev/multi-user:$Tag"
$remoteTag = "${Registry}/${ImageName}:$Tag"

Write-Host "== Build multi-user snapshot =="
docker build --platform linux/amd64 -t $localTag -f $dockerfile $context
if ($LASTEXITCODE -ne 0) { throw "docker build failed (ensure sandbox-dev/multi-user:0.1.0 exists as BASE_IMAGE)" }

Write-Host "`n== Tag for local Daytona registry =="
docker tag $localTag $remoteTag

Write-Host "`n== Push to registry ($Registry) =="
Write-Host "If push fails, login with: docker login $Registry -u admin -p password"
docker push $remoteTag
if ($LASTEXITCODE -ne 0) {
  Write-Warn "Push failed. Ensure Daytona registry is running (docker ps | findstr registry)"
  Write-Host "Manual steps:"
  Write-Host "  1. docker login $Registry -u admin -p password"
  Write-Host "  2. docker push $remoteTag"
  exit 1
}

Write-Host "`n== Next: register in Daytona Dashboard =="
Write-Host "  1. Open http://localhost:3000/dashboard/snapshots"
Write-Host "  2. Create Snapshot"
Write-Host "     Name: sandbox-dev-multi-user"
Write-Host "     Image: $remoteTag"
Write-Host "  3. Set snapshot state to ACTIVE"
Write-Host ""
Write-Host "  4. Set in deploy/local/.env:"
Write-Host "     DAYTONA_SNAPSHOT=sandbox-dev-multi-user"
Write-Host "  5. Restart Broker and run: .\scripts\test-scenario3-multi-user.ps1"
