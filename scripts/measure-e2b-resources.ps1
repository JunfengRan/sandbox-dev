# Capture docker stats for E2B-compatible sandboxes and print CPU/memory estimates
param(
  [string]$BrokerUrl = "http://localhost:8080",
  [string]$RuntimeUrl = "http://localhost:8090",
  [int]$SampleSeconds = 3
)

$ErrorActionPreference = "Stop"

function Acquire($userId, $sessionId, $mode, $poolId) {
  $body = @{ userId = $userId; sessionId = $sessionId; mode = $mode }
  if ($poolId) { $body.poolId = $poolId }
  return Invoke-RestMethod "$BrokerUrl/v1/leases/acquire" -Method POST -Body ($body | ConvertTo-Json) -ContentType "application/json"
}

function Release($userId, $sessionId) {
  $body = @{ userId = $userId; sessionId = $sessionId; reason = "idle" } | ConvertTo-Json
  Invoke-RestMethod "$BrokerUrl/v1/leases/release" -Method POST -Body $body -ContentType "application/json" | Out-Null
}

function StatsForSandbox($sandboxId) {
  $name = "sandbox-dev-$sandboxId"
  $line = docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}" $name 2>$null
  if (-not $line) { return $null }
  $parts = $line -split '\|'
  return @{ Name = $parts[0]; Cpu = $parts[1]; Mem = $parts[2] }
}

Write-Host "== exclusive idle sample =="
$ex = Acquire "bench-ex" "bench-ex-1" "exclusive"
Start-Sleep -Seconds $SampleSeconds
$st = StatsForSandbox $ex.sandboxId
Write-Host "sandbox=$($ex.sandboxId) cpu=$($st.Cpu) mem=$($st.Mem)"
# light load
Invoke-RestMethod "$RuntimeUrl/v1/sandboxes/$($ex.sandboxId)/exec" -Method POST -ContentType "application/json" -Body (@{ command = "dd if=/dev/zero of=/tmp/load.bin bs=1M count=32 2>/dev/null; sync; rm -f /tmp/load.bin" } | ConvertTo-Json) | Out-Null
Start-Sleep -Seconds 1
$stLoad = StatsForSandbox $ex.sandboxId
Write-Host "after light write: cpu=$($stLoad.Cpu) mem=$($stLoad.Mem)"
Release "bench-ex" "bench-ex-1"

Write-Host "`n== user_shared 2 sessions =="
$a = Acquire "bench-share" "s-a" "user_shared"
$b = Acquire "bench-share" "s-b" "user_shared"
Start-Sleep -Seconds $SampleSeconds
$st2 = StatsForSandbox $a.sandboxId
Write-Host "shared sandbox=$($a.sandboxId) cpu=$($st2.Cpu) mem=$($st2.Mem) sessions=2"
Release "bench-share" "s-a"
Release "bench-share" "s-b"

Write-Host "`n== multi_user_shared 2 users =="
$ua = Acquire "bench-a" "m-a" "multi_user_shared" "bench-pool"
$ub = Acquire "bench-b" "m-b" "multi_user_shared" "bench-pool"
Start-Sleep -Seconds $SampleSeconds
$st3 = StatsForSandbox $ua.sandboxId
Write-Host "pool sandbox=$($ua.sandboxId) cpu=$($st3.Cpu) mem=$($st3.Mem) users=2"
Release "bench-a" "m-a"
Release "bench-b" "m-b"

Write-Host "`nDone. Paste numbers into docs/TESTING.md E2B section."
