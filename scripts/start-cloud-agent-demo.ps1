# Start Broker (Daytona OpenCode) + local demo gateway + packages/app web UI.
# Usage (from anywhere):
#   powershell -File E:\sandbox-dev\scripts\start-cloud-agent-demo.ps1
param(
  [switch]$SkipStack,
  [switch]$SkipInject,
  [int]$AppPort = 5173
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deploy = Join-Path $root "deploy\local"
$opencodeApp = "E:\opencode\packages\app"

function Wait-Http($url, $attempts = 40, $delaySec = 3) {
  for ($i = 1; $i -le $attempts; $i++) {
    try {
      Invoke-RestMethod $url -TimeoutSec 2 | Out-Null
      return
    } catch {
      Write-Host "waiting $url ($i/$attempts)"
      Start-Sleep -Seconds $delaySec
    }
  }
  throw "Timed out waiting for $url"
}

if (-not $SkipStack) {
  Write-Host "==> Daytona stack"
  Push-Location "E:\daytona"
  try { docker compose -f docker/docker-compose.yaml up -d } finally { Pop-Location }
  Wait-Http "http://127.0.0.1:3000/api/health"

  Write-Host "==> sandbox-dev broker (Daytona OpenCode env)"
  Push-Location $deploy
  try {
    # Shell DAYTONA_API_URL=localhost would break container networking; force host gateway.
    $env:DAYTONA_API_URL = "http://host.docker.internal:3000/api"
    if (-not (Test-Path ".env.daytona-opencode")) {
      throw "Missing deploy/local/.env.daytona-opencode (copy from .env.daytona-opencode.example and set DAYTONA_API_KEY)"
    }
    docker compose --env-file .env --env-file .env.daytona-opencode up -d --force-recreate broker
  } finally { Pop-Location }
  Wait-Http "http://127.0.0.1:8080/health"
}

Write-Host "==> free ports 4096 / $AppPort"
foreach ($port in 4096, $AppPort) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object {
      if ($_.OwningProcess) {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
}

Write-Host "==> demo gateway :4096"
Start-Process -FilePath "node" -ArgumentList "`"$root\scripts\demo-web-gateway.mjs`"" -WorkingDirectory $root -WindowStyle Minimized
Wait-Http "http://127.0.0.1:4096/api/health" 60 2

if (-not $SkipInject -and (Test-Path (Join-Path $root "deploy\local\.env.demo.secrets"))) {
  Write-Host "==> inject DeepSeek demo config"
  node (Join-Path $root "scripts\demo-inject-model-config.mjs")
}

Write-Host "==> markdown sync watcher → demo-output/"
New-Item -ItemType Directory -Force -Path (Join-Path $root "demo-output") | Out-Null
Start-Process -FilePath "node" -ArgumentList "`"$root\scripts\demo-pull-md.mjs`"","--watch" -WorkingDirectory $root -WindowStyle Minimized

Write-Host "==> OpenCode web UI :$AppPort"
if (-not (Test-Path $opencodeApp)) {
  throw "OpenCode app not found at $opencodeApp"
}
Start-Process -FilePath "bun" -ArgumentList "run","dev","--","--port","$AppPort","--strictPort" -WorkingDirectory $opencodeApp -WindowStyle Minimized

Write-Host ""
Write-Host "Demo ready:"
Write-Host "  Broker:   http://127.0.0.1:8080/health"
Write-Host "  Gateway:  http://127.0.0.1:4096/api/health"
Write-Host "  Web UI:   http://localhost:$AppPort/"
Write-Host "  Session:  http://localhost:$AppPort/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/<id>"
Write-Host "  Host MD:  $root\demo-output\  (auto-pull every 5s)"
Write-Host ""
Write-Host "Manual pull:  node $root\scripts\demo-pull-md.mjs"
Write-Host "If model missing, run: node $root\scripts\demo-inject-model-config.mjs"
