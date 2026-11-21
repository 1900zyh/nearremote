# Shared, read-only checks for a local NearRemote instance. Requests bypass proxies.
function Get-NearRemoteDataDirectory([string]$DataDirectory = '') {
  if (-not $DataDirectory) {
    $DataDirectory = if ($env:REMOTE_DATA_DIR) { $env:REMOTE_DATA_DIR } else { Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'NearRemote' }
  }
  return [System.IO.Path]::GetFullPath($DataDirectory)
}

function Write-NearRemoteLauncherLog([string]$DataDirectory, [string]$Filename, [string]$Message) {
  New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
  Add-Content -LiteralPath (Join-Path $DataDirectory $Filename) -Value ('[{0}] {1}' -f (Get-Date -Format 'o'), $Message) -Encoding UTF8
}

function Invoke-NearRemoteLocalRequest {
  param([ValidateRange(1, 65535)][int]$Port, [string]$Path, [ValidateSet('GET', 'POST')][string]$Method = 'GET', [string]$Token = '', [int]$TimeoutMilliseconds = 2500)
  $request = [System.Net.WebRequest]::Create("http://127.0.0.1:$Port$Path")
  $request.Proxy = $null
  $request.Timeout = $TimeoutMilliseconds
  $request.Method = $Method
  if ($Token) { $request.Headers['X-Host-Token'] = $Token }
  if ($Method -eq 'POST') {
    $body = [System.Text.Encoding]::UTF8.GetBytes('{}')
    $request.ContentType = 'application/json'
    $request.ContentLength = $body.Length
    $stream = $request.GetRequestStream()
    try { $stream.Write($body, 0, $body.Length) } finally { $stream.Dispose() }
  }
  $response = $request.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $response.Dispose() }
}

function Get-NearRemoteLocalStatus([int]$Port, [int]$TimeoutMilliseconds = 2000) {
  try { return ((Invoke-NearRemoteLocalRequest -Port $Port -Path '/api/status' -TimeoutMilliseconds $TimeoutMilliseconds) | ConvertFrom-Json) }
  catch { return $null }
}

function Get-NearRemoteCommandArguments([string]$CommandLine) {
  if (-not ('NearRemoteLauncher.NativeCommandLine' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace NearRemoteLauncher {
    public static class NativeCommandLine {
        [DllImport("shell32.dll", SetLastError = true)]
        private static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        public static string[] Arguments(string commandLine) {
            int argc;
            IntPtr memory = CommandLineToArgvW(commandLine, out argc);
            if (memory == IntPtr.Zero) throw new InvalidOperationException("Could not inspect the service command line.");
            try {
                string[] result = new string[argc];
                for (int i = 0; i < argc; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
                return result;
            } finally { LocalFree(memory); }
        }
    }
}
'@
  }
  return [NearRemoteLauncher.NativeCommandLine]::Arguments($CommandLine)
}

function Assert-NearRemoteRunningInstance($Status, [string]$DataDirectory) {
  if (-not $Status -or $Status.service -ne 'nearremote' -or -not $Status.localProcess) { throw 'This port is not a supported local NearRemote service. No process was stopped.' }
  $identity = [guid]::Empty
  if (-not [guid]::TryParse([string]$Status.serverId, [ref]$identity)) { throw 'The running service has no valid NearRemote computer identity.' }
  $identityPath = Join-Path $DataDirectory 'server-id.json'
  if (Test-Path -LiteralPath $identityPath) {
    if ((Get-Item -LiteralPath $identityPath).Length -gt 4096) { throw 'The local computer identity file is invalid.' }
    $storedIdentity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
    if ($storedIdentity.version -ne 1 -or [string]$storedIdentity.id -ne [string]$Status.serverId) { throw 'This port belongs to a NearRemote service using a different data directory. No process was stopped.' }
  }
  if (-not [System.IO.Path]::IsPathRooted([string]$Status.localProcess.projectDirectory)) { throw 'The running service reported an invalid project location.' }
  $runningProjectDirectory = [System.IO.Path]::GetFullPath([string]$Status.localProcess.projectDirectory)
  $runningServerPath = Join-Path $runningProjectDirectory 'server.js'
  $serviceProcessId = 0
  if (-not [int]::TryParse([string]$Status.localProcess.pid, [ref]$serviceProcessId) -or $serviceProcessId -lt 1) { throw 'The service process identifier is invalid.' }
  $serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serviceProcessId"
  if (-not $serviceProcess -or $serviceProcess.Name -ne 'node.exe' -or -not $serviceProcess.CommandLine) { throw 'The service process no longer matches Node.js. No process was stopped.' }
  $arguments = @(Get-NearRemoteCommandArguments ([string]$serviceProcess.CommandLine))
  if ($arguments.Count -lt 2 -or -not [System.IO.Path]::IsPathRooted($arguments[1]) -or -not [string]::Equals([System.IO.Path]::GetFullPath($arguments[1]), $runningServerPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The service process command line does not match its reported NearRemote project. No process was stopped.'
  }
  $owner = Invoke-CimMethod -InputObject $serviceProcess -MethodName GetOwnerSid
  $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $currentUserSid) { throw 'The running service belongs to another Windows user. No process was stopped.' }
  # Do not require the original directory to still exist: a running portable
  # instance must remain stoppable after its files have been moved or removed.
  return [pscustomobject]@{ ProcessId = $serviceProcessId; ProjectDirectory = $runningProjectDirectory; ServerPath = $runningServerPath; ServerId = [string]$Status.serverId }
}
