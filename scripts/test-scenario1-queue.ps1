# Scenario 1: concurrency queue test
param(
  [string]$BrokerUrl = "http://localhost:8080",
  [ValidateSet('e2b', 'daytona')]
  [string]$Provider = $(if ($env:SANDBOX_PROVIDER) { $env:SANDBOX_PROVIDER } else { 'e2b' })
)

$ErrorActionPreference = "Stop"

Write-Host "== Broker health (provider hint=$Provider) =="
Invoke-RestMethod "$BrokerUrl/health"
$status = Invoke-RestMethod "$BrokerUrl/v1/status"
Write-Host "active provider=$($status.provider) max=$($status.maxConcurrency)"

function Acquire($userId, $sessionId) {
  $body = @{ userId = $userId; sessionId = $sessionId; mode = "exclusive" } | ConvertTo-Json
  return Invoke-WebRequest -Uri "$BrokerUrl/v1/leases/acquire" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
}

Write-Host "`n== Acquire 3 sessions with MAX_SANDBOX_CONCURRENCY=2 =="
$r1 = Acquire "user-a" "session-1"
$r2 = Acquire "user-b" "session-2"
$r3 = Acquire "user-c" "session-3"

Write-Host "user-a: $($r1.StatusCode) $($r1.Content)"
Write-Host "user-b: $($r2.StatusCode) $($r2.Content)"
Write-Host "user-c: $($r3.StatusCode) $($r3.Content)"

Write-Host "`n== Broker status =="
(Invoke-RestMethod "$BrokerUrl/v1/status") | ConvertTo-Json -Depth 5

Write-Host "`n== Release user-a (simulate idle) =="
$releaseBody = @{ userId = "user-a"; sessionId = "session-1"; reason = "idle" } | ConvertTo-Json
Invoke-RestMethod "$BrokerUrl/v1/leases/release" -Method POST -Body $releaseBody -ContentType "application/json"

Start-Sleep -Seconds 2

Write-Host "`n== Poll queued ticket for user-c =="
$c = $r3.Content | ConvertFrom-Json
if ($c.ticketId) {
  for ($i = 0; $i -lt 10; $i++) {
    $poll = Invoke-RestMethod "$BrokerUrl/v1/leases/poll?ticketId=$($c.ticketId)"
    Write-Host "poll $($i+1): $($poll | ConvertTo-Json -Compress)"
    if ($poll.status -eq "ready") { break }
    Start-Sleep -Seconds 2
  }
}

Write-Host "`n== Final status =="
(Invoke-RestMethod "$BrokerUrl/v1/status") | ConvertTo-Json -Depth 5

Write-Host "`nDone. Clean up with release calls if needed."
