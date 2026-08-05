param(
  [string]$Tag = 'sandbox-dev/aio-runtime:0.1.0',
  [string]$BaseImage = $(if ($env:AIO_BASE_IMAGE) { $env:AIO_BASE_IMAGE } else { 'ghcr.io/agent-infra/sandbox:1.11.0' })
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Write-Host "Building $Tag from BASE_IMAGE=$BaseImage ..."
docker build --build-arg "BASE_IMAGE=$BaseImage" -t $Tag -f "$root\snapshots\Dockerfile.aio-runtime" "$root\snapshots"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Built $Tag from $BaseImage"
