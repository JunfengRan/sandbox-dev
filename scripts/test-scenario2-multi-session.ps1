# Scenario 2: same user, multiple OpenCode sessions share one sandbox
param(
  [string]$BrokerUrl = "http://localhost:8080",
  [string]$UserId = "shared-user"
)

$ErrorActionPreference = "Stop"

function Acquire($sessionId) {
  $body = @{ userId = $UserId; sessionId = $sessionId; mode = "user_shared" } | ConvertTo-Json
  return Invoke-RestMethod "$BrokerUrl/v1/leases/acquire" -Method POST -Body $body -ContentType "application/json"
}

Write-Host "== Acquire session A =="
$a = Acquire "session-a"
Write-Host ($a | ConvertTo-Json -Compress)

Write-Host "`n== Acquire session B (same user) =="
$b = Acquire "session-b"
Write-Host ($b | ConvertTo-Json -Compress)

if ($a.sandboxId -ne $b.sandboxId) {
  Write-Warning "Expected same sandboxId for user_shared mode"
} else {
  Write-Host "OK: both sessions share sandbox $($a.sandboxId)"
}

Write-Host "`nWork dirs:"
Write-Host "  A: $($a.workDir)"
Write-Host "  B: $($b.workDir)"

if ($a.workDir -eq $b.workDir) {
  Write-Warning "Expected different session work directories"
} else {
  Write-Host "OK: isolated work directories"
}

Write-Host "`nTo validate in OpenCode:"
Write-Host "  set DAYTONA_BROKER_MODE=user_shared and OPENCODE_USER_ID=$UserId"
Write-Host "  start two sessions and write marker files; they should not see each other's files"
