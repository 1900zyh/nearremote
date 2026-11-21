// Portable Windows FFmpeg, from a Windows build linked by ffmpeg.org/download.html.
// Downloads into a private temporary directory, verifies the publisher's SHA-256,
// then copies only the expected executable and license into this application.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('视频工具安装脚本目前仅支持 Windows。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsDirectory = path.join(root, 'tools');
const executable = path.join(toolsDirectory, 'ffmpeg.exe');
const archiveUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const checksumUrl = `${archiveUrl}.sha256`;
const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;

function powershell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`视频工具准备失败（退出码 ${code}）。请检查网络后重试。`)));
  });
}

if (!process.argv.includes('--force')) {
  try {
    await fs.access(executable);
    console.log(`视频工具已就绪：${executable}`);
    process.exit(0);
  } catch { /* Not yet installed. */ }
}

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nearremote-ffmpeg-'));
const archive = path.join(temporaryDirectory, 'ffmpeg.zip');
const checksum = path.join(temporaryDirectory, 'ffmpeg.sha256');
const stagedExecutable = path.join(temporaryDirectory, 'ffmpeg.exe');
const stagedLicense = path.join(temporaryDirectory, 'FFmpeg-LICENSE.txt');
console.log('正在下载 Windows 视频工具并验证 SHA-256，可能需要几分钟…');
try {
  await powershell(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri ${quotePowerShell(checksumUrl)} -OutFile ${quotePowerShell(checksum)} -UseBasicParsing -TimeoutSec 60
Invoke-WebRequest -Uri ${quotePowerShell(archiveUrl)} -OutFile ${quotePowerShell(archive)} -UseBasicParsing -TimeoutSec 300
$expectedHash = ([System.IO.File]::ReadAllText(${quotePowerShell(checksum)}).Trim() -split '\\s+')[0]
if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'Publisher checksum has an invalid format.' }
$actualHash = (Get-FileHash -LiteralPath ${quotePowerShell(archive)} -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'FFmpeg archive SHA-256 verification failed.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$videoArchive = [System.IO.Compression.ZipFile]::OpenRead(${quotePowerShell(archive)})
try {
  $executables = @($videoArchive.Entries | Where-Object { $_.FullName -match '^[^/]+/bin/ffmpeg\\.exe$' })
  $licenses = @($videoArchive.Entries | Where-Object { $_.FullName -match '^[^/]+/LICENSE(?:\\.txt)?$' })
  if ($executables.Count -ne 1 -or $licenses.Count -ne 1) { throw 'FFmpeg archive structure is not the expected essentials build.' }
  if ($executables[0].Length -gt 300MB -or $licenses[0].Length -gt 1MB) { throw 'FFmpeg archive entries exceed expected size.' }
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($executables[0], ${quotePowerShell(stagedExecutable)}, $false)
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($licenses[0], ${quotePowerShell(stagedLicense)}, $false)
} finally { $videoArchive.Dispose() }
`);
  await fs.mkdir(toolsDirectory, { recursive: true });
  await fs.copyFile(stagedExecutable, executable);
  await fs.copyFile(stagedLicense, path.join(toolsDirectory, 'FFmpeg-LICENSE.txt'));
  await fs.writeFile(path.join(toolsDirectory, 'FFmpeg-SOURCE.txt'), `FFmpeg Windows essentials build by Gyan Doshi.\nUpstream: https://ffmpeg.org/\nBuild/download/source information: https://www.gyan.dev/ffmpeg/builds/\nArchive: ${archiveUrl}\nPublisher SHA-256: ${(await fs.readFile(checksum, 'utf8')).trim()}\nLicense: see FFmpeg-LICENSE.txt\n`, 'utf8');
  console.log(`视频工具已准备完成：${executable}`);
} finally {
  // This directory was created by mkdtemp above, and contains only these known files.
  for (const filename of [archive, checksum, stagedExecutable, stagedLicense]) await fs.unlink(filename).catch(() => {});
  await fs.rmdir(temporaryDirectory).catch(() => {});
}
