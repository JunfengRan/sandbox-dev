# Build and push OpenCode Daytona snapshot, then register/activate via API.
param(
  [string]$Tag = "1.18.13",
  [string]$Registry = "localhost:6000",
  [string]$ImageName = "daytona/sandbox-dev-opencode",
  [string]$SnapshotName = "sandbox-dev-opencode",
  [string]$DaytonaApiUrl = "http://localhost:3000/api",
  [string]$DaytonaApiKey = $env:DAYTONA_API_KEY
)

$ErrorActionPreference = "Stop"
if (-not $DaytonaApiKey) {
  throw "DAYTONA_API_KEY is required"
}

$root = Split-Path -Parent $PSScriptRoot
$dockerfile = Join-Path $root "snapshots\Dockerfile.opencode-daytona"
$context = Join-Path $root "snapshots"
$localTag = "sandbox-dev/opencode-daytona:$Tag"
$remoteTag = "${Registry}/${ImageName}:$Tag"
$registryImage = "registry:6000/${ImageName}:$Tag"

Write-Host "== Build OpenCode Daytona snapshot =="
docker build --platform linux/amd64 `
  --build-arg OPENCODE_VERSION=$Tag `
  -t $localTag `
  -f $dockerfile `
  $context
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

Write-Host "`n== Push to local Daytona registry =="
docker tag $localTag $remoteTag
docker push $remoteTag
if ($LASTEXITCODE -ne 0) { throw "docker push failed (docker login $Registry -u admin -p password)" }

$headers = @{
  Authorization = "Bearer $DaytonaApiKey"
  "Content-Type" = "application/json"
}

Write-Host "`n== Register snapshot $SnapshotName =="
$existing = Invoke-RestMethod -Headers @{ Authorization = "Bearer $DaytonaApiKey" } "$DaytonaApiUrl/snapshots"
$found = @($existing.items) | Where-Object { $_.name -eq $SnapshotName } | Select-Object -First 1
if (-not $found) {
  $body = @{
    name = $SnapshotName
    imageName = $registryImage
  } | ConvertTo-Json
  $found = Invoke-RestMethod -Method Post -Headers $headers -Body $body "$DaytonaApiUrl/snapshots"
}

Write-Host "snapshot id=$($found.id) image=$registryImage state=$($found.state)"
Write-Host "Set DAYTONA_SNAPSHOT=$SnapshotName and restart broker."
