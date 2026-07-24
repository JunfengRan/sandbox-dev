# Load benchmark: average (~10 rw/user) vs extreme (many users, 1 op lock each)
# Works for both e2b and daytona via Broker /v1/sandboxes/:id/exec
param(
  [ValidateSet('e2b', 'daytona')]
  [string]$Provider = 'e2b',
  [string]$BrokerUrl = "http://localhost:8080",
  [int]$AvgUsers = 4,
  [int]$OpsPerUser = 10,
  [int]$ExtremeUsers = 8,
  [int]$ExtremeOps = 5,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $PSScriptRoot) "docs\bench-results" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Acquire($userId, $sessionId) {
  $body = @{ userId = $userId; sessionId = $sessionId; mode = "exclusive" } | ConvertTo-Json
  return Invoke-RestMethod "$BrokerUrl/v1/leases/acquire" -Method POST -Body $body -ContentType "application/json"
}

function Release($userId, $sessionId) {
  $body = @{ userId = $userId; sessionId = $sessionId; reason = "deleted" } | ConvertTo-Json
  try {
    Invoke-RestMethod "$BrokerUrl/v1/leases/release" -Method POST -Body $body -ContentType "application/json" | Out-Null
  } catch {}
}

function ExecViaBroker($sandboxId, $command) {
  $payload = @{ command = $command } | ConvertTo-Json
  return Invoke-RestMethod "$BrokerUrl/v1/sandboxes/$sandboxId/exec" -Method POST -Body $payload -ContentType "application/json"
}

function ParseMemMiB($memUsage) {
  if (-not $memUsage) { return 0 }
  $used = ($memUsage -split '/')[0].Trim()
  if ($used -match '([\d.]+)\s*GiB') { return [math]::Round([double]$Matches[1] * 1024, 2) }
  if ($used -match '([\d.]+)\s*MiB') { return [math]::Round([double]$Matches[1], 2) }
  if ($used -match '([\d.]+)\s*KiB') { return [math]::Round([double]$Matches[1] / 1024, 2) }
  return 0
}

function ParseCpuPct($cpu) {
  if (-not $cpu) { return 0 }
  return [double](($cpu -replace '%', '').Trim())
}

function SampleContainers([string[]]$names) {
  $rows = @()
  foreach ($n in $names) {
    if (-not $n) { continue }
    $line = docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}" $n 2>$null
    if (-not $line) { continue }
    $p = $line -split '\|'
    $rows += [pscustomobject]@{
      Name = $p[0]
      CpuPct = (ParseCpuPct $p[1])
      MemMiB = (ParseMemMiB $p[2])
      RawMem = $p[2]
      RawCpu = $p[1]
    }
  }
  return $rows
}

function ResolveSandboxContainerNames([string[]]$sandboxIds) {
  $names = @()
  foreach ($id in $sandboxIds) {
    if (-not $id) { continue }
    # e2b-compatible naming
    $e2b = "sandbox-dev-$id"
    $found = docker ps --format "{{.Names}}" --filter "name=$e2b" 2>$null
    if ($found) { $names += $found; continue }
    # Daytona: container often embeds sandbox id in name/label
    $byLabel = docker ps --format "{{.Names}}" --filter "label=daytona.sandbox.id=$id" 2>$null
    if ($byLabel) { $names += $byLabel; continue }
    $all = docker ps --format "{{.Names}}" 2>$null
    $match = $all | Where-Object { $_ -like "*$id*" } | Select-Object -First 1
    if ($match) { $names += $match }
  }
  return $names
}

function ControlPlaneNames {
  return @('local-broker-1', 'local-sandbox-runtime-1', 'local-redis-1', 'local-redpanda-1')
}

function WorkDirBase {
  if ($Provider -eq 'daytona') { return '/home/daytona/project' }
  return '/home/user/project'
}

Write-Host "Provider=$Provider"
$status = Invoke-RestMethod "$BrokerUrl/v1/status"
Write-Host ($status | ConvertTo-Json -Compress)
if ($status.provider -ne $Provider) {
  Write-Warning "Broker provider=$($status.provider) != requested $Provider — results still valid for active provider"
}
$maxConc = [int]$status.maxConcurrency
$base = WorkDirBase

# ---------- Average ----------
Write-Host "`n========== AVERAGE: $AvgUsers users x $OpsPerUser rw =========="
$avgN = [Math]::Min($AvgUsers, $maxConc)
$avgLeases = @()
for ($i = 1; $i -le $avgN; $i++) {
  $u = "avg-$Provider-$i"
  $lease = Acquire $u "avg-session-$i"
  if ($lease.status -ne 'granted') { throw "acquire failed: $($lease | ConvertTo-Json -Compress)" }
  $avgLeases += [pscustomobject]@{ UserId = $u; SessionId = "avg-session-$i"; SandboxId = $lease.sandboxId }
  Write-Host "acquired $($lease.sandboxId) for $u"
}

$avgPeakCpu = 0.0; $avgPeakMem = 0.0; $avgPeakCpMem = 0.0; $avgPeakCpCpu = 0.0
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$jobs = @()
foreach ($l in $avgLeases) {
  $jobs += Start-Job -ScriptBlock {
    param($BrokerUrl, $SandboxId, $UserId, $Ops, $Base)
    for ($k = 1; $k -le $Ops; $k++) {
      $path = "$Base/bench-$UserId-$k.txt"
      $w = @{ command = "echo content-$k-$UserId > $path && sync" } | ConvertTo-Json
      Invoke-RestMethod "$BrokerUrl/v1/sandboxes/$SandboxId/exec" -Method POST -Body $w -ContentType "application/json" | Out-Null
      $r = @{ command = "cat $path" } | ConvertTo-Json
      Invoke-RestMethod "$BrokerUrl/v1/sandboxes/$SandboxId/exec" -Method POST -Body $r -ContentType "application/json" | Out-Null
    }
    return $Ops
  } -ArgumentList $BrokerUrl, $l.SandboxId, $l.UserId, $OpsPerUser, $base
}

while ($jobs | Where-Object { $_.State -eq 'Running' }) {
  $cnames = ResolveSandboxContainerNames ($avgLeases.SandboxId)
  $sb = SampleContainers $cnames
  $cp = SampleContainers (ControlPlaneNames)
  $sbSum = ($sb | Measure-Object MemMiB -Sum).Sum
  $sbCpu = ($sb | Measure-Object CpuPct -Sum).Sum
  $cpSum = ($cp | Measure-Object MemMiB -Sum).Sum
  $cpCpu = ($cp | Measure-Object CpuPct -Sum).Sum
  if ($sbCpu -gt $avgPeakCpu) { $avgPeakCpu = $sbCpu }
  if ($sbSum -gt $avgPeakMem) { $avgPeakMem = $sbSum }
  if ($cpSum -gt $avgPeakCpMem) { $avgPeakCpMem = $cpSum }
  if ($cpCpu -gt $avgPeakCpCpu) { $avgPeakCpCpu = $cpCpu }
  Start-Sleep -Milliseconds 800
}
$jobs | Wait-Job | Receive-Job | Out-Null
$jobs | Remove-Job
$sw.Stop()
Write-Host "Average done in $($sw.Elapsed.TotalSeconds)s peakCpu%=$([math]::Round($avgPeakCpu,2)) peakMemMiB=$([math]::Round($avgPeakMem,2))"
foreach ($l in $avgLeases) { Release $l.UserId $l.SessionId }
Start-Sleep -Seconds 3

# ---------- Extreme ----------
Write-Host "`n========== EXTREME: $ExtremeUsers users, 1-op lock, $ExtremeOps ops =========="
$extN = [Math]::Min($ExtremeUsers, $maxConc)
$extLeases = @()
$queued = 0
for ($i = 1; $i -le $ExtremeUsers; $i++) {
  $u = "ext-$Provider-$i"
  $body = @{ userId = $u; sessionId = "ext-session-$i"; mode = "exclusive" } | ConvertTo-Json
  $resp = Invoke-WebRequest -Uri "$BrokerUrl/v1/leases/acquire" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
  $lease = $resp.Content | ConvertFrom-Json
  if ($lease.status -eq 'granted') {
    $extLeases += [pscustomobject]@{ UserId = $u; SessionId = "ext-session-$i"; SandboxId = $lease.sandboxId; TicketId = $null }
    Write-Host "granted $u -> $($lease.sandboxId)"
  } else {
    $queued++
    $extLeases += [pscustomobject]@{ UserId = $u; SessionId = "ext-session-$i"; SandboxId = $null; TicketId = $lease.ticketId }
    Write-Host "queued $u"
  }
}

$extPeakCpu = 0.0; $extPeakMem = 0.0; $extPeakCpMem = 0.0; $extPeakCpCpu = 0.0
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()

$mutexScript = {
  param($BrokerUrl, $UserId, $SandboxId, $TicketId, $Ops, $Base)
  $sid = $SandboxId
  if (-not $sid -and $TicketId) {
    for ($t = 0; $t -lt 90; $t++) {
      $poll = Invoke-RestMethod "$BrokerUrl/v1/leases/poll?ticketId=$TicketId"
      if ($poll.status -eq 'ready') { $sid = $poll.sandboxId; break }
      Start-Sleep -Seconds 1
    }
  }
  if (-not $sid) { throw "no sandbox for $UserId" }
  $lock = New-Object System.Threading.Mutex($false, "Local\sandbox-op-$UserId")
  try {
    for ($k = 1; $k -le $Ops; $k++) {
      [void]$lock.WaitOne()
      try {
        $path = "$Base/ext-$UserId-$k.txt"
        $w = @{ command = "dd if=/dev/urandom of=$path bs=4K count=8 2>/dev/null; wc -c $path" } | ConvertTo-Json
        Invoke-RestMethod "$BrokerUrl/v1/sandboxes/$sid/exec" -Method POST -Body $w -ContentType "application/json" | Out-Null
        $r = @{ command = "cat $path | wc -c" } | ConvertTo-Json
        Invoke-RestMethod "$BrokerUrl/v1/sandboxes/$sid/exec" -Method POST -Body $r -ContentType "application/json" | Out-Null
      } finally { $lock.ReleaseMutex() }
    }
  } finally { $lock.Dispose() }
  return $sid
}

$extJobs = @()
foreach ($l in $extLeases) {
  $extJobs += Start-Job -ScriptBlock $mutexScript -ArgumentList $BrokerUrl, $l.UserId, $l.SandboxId, $l.TicketId, $ExtremeOps, $base
}

while ($extJobs | Where-Object { $_.State -eq 'Running' }) {
  $active = @($extLeases | Where-Object { $_.SandboxId } | ForEach-Object { $_.SandboxId })
  $cnames = ResolveSandboxContainerNames $active
  if ($cnames.Count -eq 0) {
    $cnames = @(docker ps --format "{{.Names}}" --filter "label=sandbox-dev.managed=true" 2>$null)
  }
  $sb = SampleContainers $cnames
  $cp = SampleContainers (ControlPlaneNames)
  $sbSum = ($sb | Measure-Object MemMiB -Sum).Sum
  $sbCpu = ($sb | Measure-Object CpuPct -Sum).Sum
  $cpSum = ($cp | Measure-Object MemMiB -Sum).Sum
  $cpCpu = ($cp | Measure-Object CpuPct -Sum).Sum
  if ($sbCpu -gt $extPeakCpu) { $extPeakCpu = $sbCpu }
  if ($sbSum -gt $extPeakMem) { $extPeakMem = $sbSum }
  if ($cpSum -gt $extPeakCpMem) { $extPeakCpMem = $cpSum }
  if ($cpCpu -gt $extPeakCpCpu) { $extPeakCpCpu = $cpCpu }
  Start-Sleep -Milliseconds 800
}
$extJobs | Wait-Job | Receive-Job | Out-Null
$extJobs | Remove-Job
$sw2.Stop()
Write-Host "Extreme done in $($sw2.Elapsed.TotalSeconds)s queued=$queued peakCpu%=$([math]::Round($extPeakCpu,2)) peakMemMiB=$([math]::Round($extPeakMem,2))"
foreach ($l in $extLeases) { Release $l.UserId $l.SessionId }

$plannedCpu = if ($Provider -eq 'daytona') { 1.0 } else { [double]($status.defaultResources.cpu ?? 0.5) }
$plannedMem = if ($Provider -eq 'daytona') { 1024 } else { [int]($status.defaultResources.memoryMiB ?? 512) }

$report = [ordered]@{
  timestamp = (Get-Date).ToString('o')
  provider = $status.provider
  maxConcurrency = $maxConc
  defaultResources = $status.defaultResources
  average = [ordered]@{
    users = $avgN
    opsPerUser = $OpsPerUser
    durationSec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    peakSandboxCpuPct = [math]::Round($avgPeakCpu, 2)
    peakSandboxMemMiB = [math]::Round($avgPeakMem, 2)
    peakControlPlaneCpuPct = [math]::Round($avgPeakCpCpu, 2)
    peakControlPlaneMemMiB = [math]::Round($avgPeakCpMem, 2)
    perUserPeakCpuPct = [math]::Round($avgPeakCpu / [Math]::Max($avgN, 1), 2)
    perUserPeakMemMiB = [math]::Round($avgPeakMem / [Math]::Max($avgN, 1), 2)
    plannedCpuVcpu = [math]::Round($plannedCpu * $avgN, 2)
    plannedMemMiB = [int]($plannedMem * $avgN)
  }
  extreme = [ordered]@{
    requestedUsers = $ExtremeUsers
    concurrentSandboxes = $extN
    queuedUsers = $queued
    opsPerUser = $ExtremeOps
    singleOpLockPerUser = $true
    durationSec = [math]::Round($sw2.Elapsed.TotalSeconds, 2)
    peakSandboxCpuPct = [math]::Round($extPeakCpu, 2)
    peakSandboxMemMiB = [math]::Round($extPeakMem, 2)
    peakControlPlaneCpuPct = [math]::Round($extPeakCpCpu, 2)
    peakControlPlaneMemMiB = [math]::Round($extPeakCpMem, 2)
    perUserPeakCpuPct = [math]::Round($extPeakCpu / [Math]::Max($extN, 1), 2)
    perUserPeakMemMiB = [math]::Round($extPeakMem / [Math]::Max($extN, 1), 2)
    plannedCpuVcpu = [math]::Round($plannedCpu * $extN, 2)
    plannedMemMiB = [int]($plannedMem * $extN)
  }
}

$jsonPath = Join-Path $OutDir "load-bench-$Provider-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $jsonPath
Write-Host "`nWrote $jsonPath"
$report | ConvertTo-Json -Depth 4
