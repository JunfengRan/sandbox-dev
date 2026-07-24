# Build the self-hosted E2B-compatible sandbox image
param(
  [string]$Tag = "sandbox-dev/e2b-runtime:0.1.0"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "Building $Tag ..."
docker build -t $Tag -f "$root\snapshots\Dockerfile.e2b-runtime" "$root\snapshots"
Write-Host "Done: $Tag"
