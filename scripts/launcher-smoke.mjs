// Extract the actual distribution into two locations and test its Windows launchers.
// Uses an isolated port and user-data directory; it never stops the user's service.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('This acceptance test requires Windows.');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.resolve(process.env.NEARREMOTE_TEST_ARCHIVE || path.join(project, '..', 'NearRemote.zip'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nearremote-portable-'));
const folders = [path.join(temporary, '副本 A 有空格'), path.join(temporary, '副本 B 有空格')];
const dataDirectory = path.join(temporary, '独立授权 data');
const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cscript = path.join(process.env.SystemRoot, 'System32', 'cscript.exe');
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let foreignServer;
let port;
let testServiceStarted = false;

function run(file, args, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env: { ...process.env, ...extraEnvironment }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-8000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-8000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Launcher acceptance step timed out.')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const chosen = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return chosen;
}
const status = () => fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) }).then((response) => response.json());
const launcher = (index, operation, extraEnvironment = {}) => run(cscript,
  ['//Nologo', path.join(folders[index], 'NearRemote', 'scripts', 'launcher.vbs'), operation, '--no-dialog', '--no-browser'],
  { REMOTE_PORT: String(port), REMOTE_DATA_DIR: dataDirectory, ...extraEnvironment });
async function waitStopped() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await status(); } catch { return; }
    await pause(150);
  }
  throw new Error('Isolated NearRemote service did not stop.');
}

try {
  port = await freePort();
  const extract = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead(${quote(archive)})
try {
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName -notmatch '^NearRemote/' -or $entry.FullName -match '(^|/)\.\.(/|$)|\\') { throw 'Unexpected archive path.' }
  }
} finally { $archive.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)}, ${quote(folders[0])})
[System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)}, ${quote(folders[1])})
`]);
  assert.equal(extract.code, 0, extract.output);
  assert.equal((await launcher(0, 'check')).code, 0, 'Packaged launcher dependencies must be present.');
  const firstStart = await launcher(0, 'start');
  assert.equal(firstStart.code, 0, firstStart.output);
  testServiceStarted = true;
  const first = await status();
  assert.equal(path.normalize(first.localProcess.projectDirectory), path.join(folders[0], 'NearRemote'));
  assert.ok(first.serverId);

  // Add one isolated approval to ensure portable start/stop preserves it.
  const panel = await fetch(`http://127.0.0.1:${port}/host`).then((response) => response.text());
  const hostToken = /name="host-token"\s+content="([^"]+)"/.exec(panel)[1];
  const hostHeaders = { 'X-Host-Token': hostToken, 'Content-Type': 'application/json' };
  const management = await fetch(`http://127.0.0.1:${port}/api/host/state`, { headers: hostHeaders }).then((response) => response.json());
  const request = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: management.code, name: 'Portable launcher test', deviceId: 'portable-launcher-test-device' }) }).then((response) => response.json());
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/host/decision`, { method: 'POST', headers: hostHeaders,
    body: JSON.stringify({ requestId: request.requestId, decision: 'approve' }) })).status, 200);
  const trustFile = path.join(dataDirectory, 'trusted-devices.json');
  const trustHash = createHash('sha256').update(await fs.readFile(trustFile)).digest('hex');

  const reused = await launcher(1, 'start');
  assert.equal(reused.code, 0, reused.output);
  assert.equal((await status()).localProcess.pid, first.localProcess.pid, 'A second extracted copy must reuse the running instance.');
  const wrongDirectory = path.join(temporary, 'different identity');
  await fs.mkdir(wrongDirectory);
  await fs.writeFile(path.join(wrongDirectory, 'server-id.json'), JSON.stringify({ version: 1, id: randomUUID() }));
  const rejectedStop = await launcher(1, 'stop', { REMOTE_DATA_DIR: wrongDirectory });
  assert.notEqual(rejectedStop.code, 0, 'An identity mismatch must not be silently accepted.');
  assert.ok(rejectedStop.output.trim(), 'Headless error verification must expose a useful failure message.');
  assert.equal((await status()).localProcess.pid, first.localProcess.pid, 'A mismatched copy must not stop the running service.');

  const stopped = await launcher(1, 'stop');
  assert.equal(stopped.code, 0, stopped.output);
  await waitStopped();
  testServiceStarted = false;
  assert.equal(createHash('sha256').update(await fs.readFile(trustFile)).digest('hex'), trustHash);
  const movedStart = await launcher(1, 'start');
  assert.equal(movedStart.code, 0, movedStart.output);
  testServiceStarted = true;
  const moved = await status();
  assert.equal(path.normalize(moved.localProcess.projectDirectory), path.join(folders[1], 'NearRemote'));
  assert.equal(moved.serverId, first.serverId, 'The same user-data directory preserves the identity across extracted copies.');
  assert.equal(createHash('sha256').update(await fs.readFile(trustFile)).digest('hex'), trustHash);
  assert.equal((await launcher(0, 'stop')).code, 0, 'The original copy must also stop the second copy.');
  await waitStopped();
  testServiceStarted = false;

  foreignServer = http.createServer((_req, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{"service":"unrelated-test-server"}'); });
  await new Promise((resolve) => foreignServer.listen(port, '127.0.0.1', resolve));
  assert.notEqual((await launcher(0, 'stop')).code, 0, 'An unrelated program on the port must not be stopped.');
  assert.equal((await status()).service, 'unrelated-test-server');
  assert.notEqual((await launcher(0, 'start')).code, 0, 'An occupied port must produce a visible failure.');
  assert.equal((await status()).service, 'unrelated-test-server');
  await new Promise((resolve) => foreignServer.close(resolve));
  foreignServer = null;
  const noNode = await launcher(0, 'start', { PATH: path.join(process.env.SystemRoot, 'System32') });
  assert.notEqual(noNode.code, 0, 'Missing Node.js must return failure instead of silently disappearing.');
  assert.ok(noNode.output.trim());
  const helper = path.join(folders[1], 'NearRemote', 'scripts', 'launcher-common.ps1');
  await fs.rename(helper, helper + '.disabled');
  const missingHelper = await launcher(1, 'check');
  assert.notEqual(missingHelper.code, 0, 'An incomplete extraction must show a failure before launching.');
  assert.ok(missingHelper.output.includes('launcher-common.ps1'), 'The failure must identify the missing launcher file.');
  await fs.rename(helper + '.disabled', helper);
  console.log('Passed: actual ZIP extraction into Chinese/space paths, silent start, cross-copy reuse/stop, identity and approvals preserved, wrong identity rejected, unrelated port protected, visible error output for missing Node.js and occupied ports.');
} finally {
  if (foreignServer) await new Promise((resolve) => foreignServer.close(resolve));
  if (testServiceStarted) await launcher(0, 'stop').catch(() => {});
  const resolved = await fs.realpath(temporary).catch(() => null);
  const expectedParent = await fs.realpath(os.tmpdir());
  if (resolved && path.dirname(resolved).toLowerCase() === expectedParent.toLowerCase() && path.basename(resolved).startsWith('nearremote-portable-')) {
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}
