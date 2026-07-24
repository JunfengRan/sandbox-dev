# Consolidated test runner for all 3 scenarios (provider-aware)
param(
  [ValidateSet('e2b', 'daytona')]
  [string]$Provider = $(if ($env:SANDBOX_PROVIDER) { $env:SANDBOX_PROVIDER } else { 'e2b' }),
  [string]$BrokerUrl = "http://localhost:8080",
  [string]$RuntimeUrl = $(if ($env:E2B_RUNTIME_URL) { $env:E2B_RUNTIME_URL } else { 'http://localhost:8090' })
)

$ErrorActionPreference = "Stop"
$env:SANDBOX_PROVIDER = $Provider
$env:E2B_RUNTIME_URL = $RuntimeUrl

function Acquire($userId, $sessionId, $mode, $poolId) {
  $body = @{ userId = $userId; sessionId = $sessionId; mode = $mode }
  if ($poolId) { $body.poolId = $poolId }
  $json = $body | ConvertTo-Json
  $r = Invoke-WebRequest -Uri "$BrokerUrl/v1/leases/acquire" -Method POST -Body $json -ContentType "application/json" -UseBasicParsing
  return @{ StatusCode = $r.StatusCode; Data = ($r.Content | ConvertFrom-Json) }
}

function Release($userId, $sessionId) {
  $body = @{ userId = $userId; sessionId = $sessionId; reason = "idle" } | ConvertTo-Json
  Invoke-RestMethod "$BrokerUrl/v1/leases/release" -Method POST -Body $body -ContentType "application/json" | Out-Null
}

function ExecInSandbox($sandboxId, $command) {
  if ($Provider -eq 'e2b') {
    $payload = @{ command = $command } | ConvertTo-Json
    $res = Invoke-RestMethod -Uri "$RuntimeUrl/v1/sandboxes/$sandboxId/exec" -Method POST -Body $payload -ContentType "application/json"
    return "$($res.stdout)$($res.stderr)"
  }
  $script = @"
const { Daytona } = require('@daytona/sdk');
(async () => {
  const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET });
  const s = await d.get('$sandboxId');
  const r = await s.process.executeCommand($([System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($command)));
  process.stdout.write(r.result || '');
})().catch(e => { console.error(e); process.exit(1); });
"@
  return (node -e $script 2>&1 | Out-String)
}

Write-Host "Provider=$Provider BrokerUrl=$BrokerUrl"
$status = Invoke-RestMethod "$BrokerUrl/v1/status"
Write-Host "Broker status provider=$($status.provider) active=$($status.activeCount)"

Write-Host "`n========== SCENARIO 1: Concurrency Queue =========="
$r1 = Acquire "s1-user-a" "s1-session-1" "exclusive"
$r2 = Acquire "s1-user-b" "s1-session-2" "exclusive"
$r3 = Acquire "s1-user-c" "s1-session-3" "exclusive"
Write-Host "A: $($r1.StatusCode) status=$($r1.Data.status) provider=$($r1.Data.provider)"
Write-Host "B: $($r2.StatusCode) status=$($r2.Data.status)"
Write-Host "C: $($r3.StatusCode) status=$($r3.Data.status)"
$s1ok = ($r1.Data.status -eq 'granted') -and ($r2.Data.status -eq 'granted') -and ($r3.Data.status -eq 'queued')
Release "s1-user-a" "s1-session-1"
Start-Sleep -Seconds 3
if ($r3.Data.ticketId) {
  $poll = Invoke-RestMethod "$BrokerUrl/v1/leases/poll?ticketId=$($r3.Data.ticketId)"
  Write-Host "C after release: status=$($poll.status) sandbox=$($poll.sandboxId)"
  $s1ok = $s1ok -and ($poll.status -eq 'ready')
}
Write-Host "SCENARIO 1 RESULT: $(if($s1ok){'PASS'}else{'FAIL'})"
Release "s1-user-b" "s1-session-2"
Release "s1-user-c" "s1-session-3"
Start-Sleep -Seconds 2

Write-Host "`n========== SCENARIO 2: Same User Multi-Session =========="
$a = Acquire "shared-user" "s2-session-a" "user_shared"
$b = Acquire "shared-user" "s2-session-b" "user_shared"
Write-Host "A: sandbox=$($a.Data.sandboxId) workDir=$($a.Data.workDir)"
Write-Host "B: sandbox=$($b.Data.sandboxId) workDir=$($b.Data.workDir)"
$s2same = ($a.Data.sandboxId -eq $b.Data.sandboxId) -and ($a.Data.sandboxId)
$s2iso = ($a.Data.workDir -ne $b.Data.workDir) -and ($a.Data.workDir -like "*/sessions/*")
$s2file = $false
if ($a.Data.sandboxId) {
  $sid = $a.Data.sandboxId
  $dirA = $a.Data.workDir
  $dirB = $b.Data.workDir
  ExecInSandbox $sid "mkdir -p $dirA $dirB && echo secret-a > $dirA/marker.txt" | Out-Null
  $out = ExecInSandbox $sid "cat $dirB/marker.txt 2>&1 || echo NOT_FOUND"
  Write-Host "Isolation test output: $out"
  $s2file = ($out -match "NOT_FOUND|No such file|cannot open")
}
$s2ok = $s2same -and $s2iso -and $s2file
Write-Host "SCENARIO 2 RESULT: $(if($s2ok){'PASS'}else{'PARTIAL/FAIL'}) (same=$s2same iso_dir=$s2iso file_iso=$s2file)"
Release "shared-user" "s2-session-a"
Release "shared-user" "s2-session-b"
Start-Sleep -Seconds 2

Write-Host "`n========== SCENARIO 3: Multi-User Shared Pool =========="
$ua = Acquire "user-alpha" "s3-session-a" "multi_user_shared" "default"
$ub = Acquire "user-beta" "s3-session-b" "multi_user_shared" "default"
Write-Host "A: sandbox=$($ua.Data.sandboxId) linuxUser=$($ua.Data.isolation.linuxUser) workDir=$($ua.Data.workDir)"
Write-Host "B: sandbox=$($ub.Data.sandboxId) linuxUser=$($ub.Data.isolation.linuxUser) workDir=$($ub.Data.workDir)"
$s3same = ($ua.Data.sandboxId -eq $ub.Data.sandboxId) -and ($ua.Data.sandboxId)
$s3users = ($ua.Data.isolation.linuxUser -ne $ub.Data.isolation.linuxUser) -and ($ua.Data.isolation.linuxUser -like "ocuser_*")
$s3iso = $false
if ($ua.Data.sandboxId) {
  $out3 = node (Join-Path $PSScriptRoot "test-scenario3-isolation.mjs") $ua.Data.sandboxId $ua.Data.isolation.linuxUser $ub.Data.isolation.linuxUser $ua.Data.workDir $Provider 2>&1
  Write-Host "Isolation test output: $out3"
  $s3iso = ($LASTEXITCODE -eq 0) -and ($out3 -match "ISOLATION_PASS:yes")
}
$s3ok = $s3same -and $s3users -and $s3iso
Write-Host "SCENARIO 3 RESULT: $(if($s3ok){'PASS'}else{'FAIL'}) (same=$s3same diff_user=$s3users os_iso=$s3iso)"
Release "user-alpha" "s3-session-a"
Release "user-beta" "s3-session-b"

Write-Host "`n========== SUMMARY ($Provider) =========="
Write-Host "Scenario 1 (queue):       $(if($s1ok){'PASS'}else{'FAIL'})"
Write-Host "Scenario 2 (user shared): $(if($s2ok){'PASS'}else{'FAIL'})"
Write-Host "Scenario 3 (multi-user):  $(if($s3ok){'PASS'}else{'FAIL'})"

if (-not ($s1ok -and $s2ok -and $s3ok)) { exit 1 }
exit 0
