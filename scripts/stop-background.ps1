param(
  [ValidateRange(1, 65535)][int]$Port = $(if ($env:REMOTE_PORT) { [int]$env:REMOTE_PORT } else { 3211 }),
  [string]$DataDirectory = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-common.ps1')
$DataDirectory = Get-NearRemoteDataDirectory $DataDirectory

try {
  $running = Get-NearRemoteLocalStatus -Port $Port
  if (-not $running) { Write-Output 'NearRemote is not running on this port.'; exit 0 }
  # Any portable copy may stop the same user's verified application instance.
  # Only authenticated application shutdown is used, never arbitrary PID killing.
  $instance = Assert-NearRemoteRunningInstance -Status $running -DataDirectory $DataDirectory
  $panel = Invoke-NearRemoteLocalRequest -Port $Port -Path '/host'
  $match = [regex]::Match($panel, 'name="host-token"\s+content="([A-Za-z0-9_-]{40,})"')
  if (-not $match.Success) { throw 'Unable to read the local control token. No process was stopped.' }
  $result = (Invoke-NearRemoteLocalRequest -Port $Port -Path '/api/host/shutdown' -Method 'POST' -Token $match.Groups[1].Value) | ConvertFrom-Json
  if (-not $result.ok) { throw 'The service did not confirm the shutdown request.' }
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (-not (Get-Process -Id $instance.ProcessId -ErrorAction SilentlyContinue)) {
      Write-Output 'NearRemote stopped. Remembered device authorizations were kept.'
      exit 0
    }
    Start-Sleep -Milliseconds 150
  }
  throw 'NearRemote accepted shutdown but has not exited yet. Check its local logs; no unrelated process was terminated.'
} catch {
  $message = $_.Exception.Message
  try { Write-NearRemoteLauncherLog $DataDirectory 'stop-launcher.log' $message } catch { }
  Write-Error -Message $message -ErrorAction Continue
  exit 1
}
