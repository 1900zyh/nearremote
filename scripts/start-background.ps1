param(
  [string]$NodePath = '',
  [ValidateRange(1, 65535)][int]$Port = $(if ($env:REMOTE_PORT) { [int]$env:REMOTE_PORT } else { 3211 }),
  [string]$DataDirectory = '',
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-common.ps1')
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DataDirectory = Get-NearRemoteDataDirectory $DataDirectory
$launcherMutex = $null
$ownsLauncherMutex = $false

try {
  New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
  # All portable copies serialize launch, not the lifetime of the server.
  $launcherMutex = [System.Threading.Mutex]::new($false, "Local\NearRemoteBackgroundLauncher-$Port")
  try { $ownsLauncherMutex = $launcherMutex.WaitOne(5000) }
  catch [System.Threading.AbandonedMutexException] { $ownsLauncherMutex = $true }
  if (-not $ownsLauncherMutex) { throw 'Another NearRemote launcher is still starting. Please try again shortly.' }

  $running = Get-NearRemoteLocalStatus -Port $Port
  if ($running) {
    $instance = Assert-NearRemoteRunningInstance -Status $running -DataDirectory $DataDirectory
    if (-not [string]::Equals($instance.ProjectDirectory, $projectDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-NearRemoteLauncherLog $DataDirectory 'startup-launcher.log' ('Reusing the running NearRemote instance from ' + $instance.ProjectDirectory)
    }
    if ($OpenBrowser) { Start-Process -FilePath "http://localhost:$Port/host" }
    exit 0
  }

  if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
  $NodePath = [System.IO.Path]::GetFullPath($NodePath)
  $serverPath = Join-Path $projectDirectory 'server.js'
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js executable was not found.' }
  if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'NearRemote server.js was not found.' }
  $nodeVersion = & $NodePath --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20 or newer is required.' }

  $env:REMOTE_PORT = [string]$Port
  $env:REMOTE_DATA_DIR = $DataDirectory
  $outputLog = Join-Path $DataDirectory 'startup-output.log'
  $errorLog = Join-Path $DataDirectory 'startup-error.log'
  $arguments = '"' + $serverPath + '"'
  if ($OpenBrowser) { $arguments += ' --open' }
  $process = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
  [System.IO.File]::WriteAllText((Join-Path $DataDirectory 'startup.pid'), [string]$process.Id)
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $process.Refresh()
    if ($process.HasExited) { throw 'NearRemote exited during startup. Check startup-error.log and startup-output.log.' }
    $running = Get-NearRemoteLocalStatus -Port $Port -TimeoutMilliseconds 500
    if ($running -and $running.service -eq 'nearremote' -and $running.localProcess -and [int]$running.localProcess.pid -eq $process.Id) {
      $instance = Assert-NearRemoteRunningInstance -Status $running -DataDirectory $DataDirectory
      if ([string]::Equals($instance.ProjectDirectory, $projectDirectory, [System.StringComparison]::OrdinalIgnoreCase)) { exit 0 }
    }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'NearRemote has not confirmed startup. Check its local logs before retrying.'
} catch {
  $message = $_.Exception.Message
  try { Write-NearRemoteLauncherLog $DataDirectory 'startup-launcher.log' $message } catch { }
  Write-Error -Message $message -ErrorAction Continue
  exit 1
} finally {
  if ($ownsLauncherMutex -and $launcherMutex) { $launcherMutex.ReleaseMutex() }
  if ($launcherMutex) { $launcherMutex.Dispose() }
}
