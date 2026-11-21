param([string]$OutputPath = '')

$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputPath) { $OutputPath = Join-Path (Split-Path $projectDirectory -Parent) 'NearRemote.zip' }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.Path]::GetExtension($OutputPath) -ne '.zip') { throw 'The output file must have the .zip extension.' }
if (-not (Test-Path -LiteralPath (Split-Path $OutputPath -Parent) -PathType Container)) { throw 'The archive output directory does not exist.' }

$requiredFiles = @(
  'package.json', 'README.md', 'server.js', 'video-stream.js', 'windows-control.ps1',
  'start.bat', 'stop.bat', 'scripts\launcher.vbs', 'scripts\launcher-common.ps1',
  'scripts\start-background.ps1', 'scripts\stop-background.ps1',
  'public\index.html', 'public\app.js', 'tools\ffmpeg.exe',
  'tools\FFmpeg-LICENSE.txt', 'tools\FFmpeg-SOURCE.txt'
)
foreach ($relative in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory $relative) -PathType Leaf)) { throw "Required package file is missing: $relative" }
}

$files = @('README.md', 'package.json', 'start.bat', 'stop.bat', 'server.js', 'server.test.js', 'video-stream.js', 'video-stream.test.js', 'windows-control.ps1')
foreach ($file in Get-ChildItem -LiteralPath $projectDirectory -File -Filter '*.bat') { $files += $file.Name }
foreach ($folder in @('public', 'scripts', 'tools', '.github')) {
  foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectDirectory $folder) -Recurse -File -Force) {
    if ($file.Extension -in @('.log', '.tmp', '.zip') -or $file.Name -eq '.DS_Store') { continue }
    $files += $file.FullName.Substring($projectDirectory.Length + 1)
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporaryArchive = Join-Path (Split-Path $OutputPath -Parent) ('NearRemote-' + [guid]::NewGuid().ToString('N') + '.zip')
try {
  $archive = [System.IO.Compression.ZipFile]::Open($temporaryArchive, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($relative in ($files | Sort-Object -Unique)) {
      $source = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory $relative))
      if (-not $source.StartsWith($projectDirectory + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Package file is outside the project.' }
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, ('NearRemote/' + $relative.Replace('\', '/')), [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose() }
  $verification = [System.IO.Compression.ZipFile]::OpenRead($temporaryArchive)
  try {
    $entries = @($verification.Entries | ForEach-Object FullName)
    foreach ($relative in $requiredFiles) {
      if ($entries -notcontains ('NearRemote/' + $relative.Replace('\', '/'))) { throw "Archive verification failed: $relative" }
    }
    if ($entries | Where-Object { $_ -match '/(?:\.git|ios|test-results)/|trusted-devices\.json|server-id\.json' }) { throw 'Unexpected private state or development output in archive.' }
  } finally { $verification.Dispose() }
  Move-Item -LiteralPath $temporaryArchive -Destination $OutputPath -Force
  [pscustomobject]@{ Archive = $OutputPath; Files = $entries.Count; SizeMB = [math]::Round((Get-Item -LiteralPath $OutputPath).Length / 1MB, 1) } | ConvertTo-Json
} finally {
  if (Test-Path -LiteralPath $temporaryArchive -PathType Leaf) { [System.IO.File]::Delete($temporaryArchive) }
}
