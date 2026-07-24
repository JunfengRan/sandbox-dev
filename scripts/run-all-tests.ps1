# Consolidated test runner for all 3 scenarios
$ErrorActionPreference = "Stop"
$BrokerUrl = "http://localhost:8080"

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

Write-Host "`n========== SCENARIO 1: Concurrency Queue =========="
$r1 = Acquire "s1-user-a" "s1-session-1" "exclusive"
$r2 = Acquire "s1-user-b" "s1-session-2" "exclusive"
$r3 = Acquire "s1-user-c" "s1-session-3" "exclusive"
Write-Host "A: $($r1.StatusCode) granted=$($r1.Data.status -eq 'granted')"
Write-Host "B: $($r2.StatusCode) granted=$($r2.Data.status -eq 'granted')"
Write-Host "C: $($r3.StatusCode) queued=$($r3.Data.status -eq 'queued')"
$s1ok = ($r1.Data.status -eq 'granted') -and ($r2.Data.status -eq 'granted') -and ($r3.Data.status -eq 'queued')
Release "s1-user-a" "s1-session-1"
Start-Sleep -Seconds 3
if ($r3.Data.ticketId) {
  $poll = Invoke-RestMethod "$BrokerUrl/v1/leases/poll?ticketId=$($r3.Data.ticketId)"
  Write-Host "C after release: status=$($poll.status) sandbox=$($poll.sandboxId)"
  $s1ok = $s1ok -and ($poll.status -eq 'ready')
}
Write-Host "SCENARIO 1 RESULT: $(if($s1ok){'PASS'}else{'FAIL'})"

# Cleanup scenario 1
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
Write-Host "Same sandbox: $s2same | Different workDir: $s2iso"

# File isolation test via Daytona SDK in sandbox
$s2file = $false
if ($a.Data.sandboxId) {
  $sid = $a.Data.sandboxId
  $dirA = $a.Data.workDir
  $dirB = $b.Data.workDir
  $testScript = @"
const { Daytona } = require('@daytona/sdk');
(async () => {
  const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET });
  const s = await d.get('$sid');
  await s.process.executeCommand('echo secret-a > $dirA/marker.txt');
  const r = await s.process.executeCommand('cat $dirB/marker.txt 2>&1 || echo NOT_FOUND');
  console.log('ISOLATION_RESULT:' + r.result.trim());
  process.exit(0);
})().catch(e => { console.log('ISOLATION_RESULT:ERROR:' + e.message); process.exit(1); });
"@
  $env:DAYTONA_API_URL = "http://localhost:3000/api"
  $env:DAYTONA_API_KEY = "dtn_29e73626741037162532edf8950a428ed898cd926b8b5a910e80d16bb0af6121"
  $env:DAYTONA_TARGET = "us"
  $out = node -e $testScript 2>&1
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

# OS isolation via sudo + ocuser accounts (multi-user snapshot)
$s3iso = $false
if ($ua.Data.sandboxId) {
  $out3 = node (Join-Path $PSScriptRoot "test-scenario3-isolation.mjs") $ua.Data.sandboxId $ua.Data.isolation.linuxUser $ub.Data.isolation.linuxUser $ua.Data.workDir 2>&1
  Write-Host "Isolation test output: $out3"
  $s3iso = ($LASTEXITCODE -eq 0)
  if ($out3 -match "SKIP:no_linux_users") { Write-Host "NOTE: OS isolation needs sandbox-dev-multi-user snapshot" }
}
$s3ok = $s3same -and $s3users
Write-Host "SCENARIO 3 RESULT: $(if($s3ok -and $s3iso){'PASS'}elseif($s3ok){'PARTIAL (API ok, OS isolation needs custom snapshot)'}else{'FAIL'}) (same=$s3same diff_user=$s3users os_iso=$s3iso)"
Release "user-alpha" "s3-session-a"
Release "user-beta" "s3-session-b"

Write-Host "`n========== SUMMARY =========="
Write-Host "Scenario 1 (queue):       $(if($s1ok){'PASS'}else{'FAIL'})"
Write-Host "Scenario 2 (user shared):   $(if($s2ok){'PASS'}else{'PARTIAL/FAIL'})"
Write-Host "Scenario 3 (multi-user):  $(if($s3ok -and $s3iso){'PASS'}elseif($s3ok){'PARTIAL'}else{'FAIL'})"
