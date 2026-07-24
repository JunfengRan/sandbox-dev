# Scenario 3: multiple users share one sandbox pool (experimental)
param(
  [string]$BrokerUrl = "http://localhost:8080",
  [string]$PoolId = "default",
  [switch]$SkipIsolation
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Acquire($userId, $sessionId) {
  $body = @{
    userId = $userId
    sessionId = $sessionId
    mode = "multi_user_shared"
    poolId = $PoolId
  } | ConvertTo-Json
  return Invoke-RestMethod "$BrokerUrl/v1/leases/acquire" -Method POST -Body $body -ContentType "application/json"
}

Write-Host "== Acquire user-a =="
$a = Acquire "user-a" "session-a"
Write-Host ($a | ConvertTo-Json -Compress)

Write-Host "`n== Acquire user-b =="
$b = Acquire "user-b" "session-b"
Write-Host ($b | ConvertTo-Json -Compress)

$apiPass = $true
if ($a.sandboxId -ne $b.sandboxId) {
  Write-Warning "Expected same sandboxId for multi_user_shared pool"
  $apiPass = $false
} else {
  Write-Host "OK: shared pool sandbox $($a.sandboxId)"
}

Write-Host "`nIsolation info:"
Write-Host "  user-a linuxUser: $($a.isolation.linuxUser) workDir: $($a.workDir)"
Write-Host "  user-b linuxUser: $($b.isolation.linuxUser) workDir: $($b.workDir)"

if ($a.isolation.linuxUser -eq $b.isolation.linuxUser) {
  Write-Warning "Different users mapped to same linux user (hash collision or missing snapshot)"
  $apiPass = $false
}

$isolationPass = $null
if (-not $SkipIsolation) {
  Write-Host "`n== OS isolation test =="
  $envFile = "$env:USERPROFILE\.config\opencode\daytona\.env"
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      if ($_ -match '^\s*([^#=]+)=(.*)$') {
        $name = $matches[1].Trim()
        $value = $matches[2].Trim().Trim('"')
        Set-Item -Path "env:$name" -Value $value
      }
    }
  }
  if (-not $env:DAYTONA_API_URL) { $env:DAYTONA_API_URL = "http://localhost:3000/api" }

  $isolationScript = Join-Path $PSScriptRoot "test-scenario3-isolation.mjs"
  node $isolationScript $a.sandboxId $a.isolation.linuxUser $b.isolation.linuxUser $a.workDir
  $isolationPass = ($LASTEXITCODE -eq 0)
}

Write-Host "`n== Summary =="
Write-Host "  API layer: $(if ($apiPass) { 'PASS' } else { 'FAIL' })"
if ($null -ne $isolationPass) {
  Write-Host "  OS isolation: $(if ($isolationPass) { 'PASS' } else { 'FAIL' })"
} else {
  Write-Host "  OS isolation: SKIPPED"
}

if (-not $apiPass -or ($isolationPass -eq $false)) { exit 1 }
exit 0
