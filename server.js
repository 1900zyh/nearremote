import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createFFmpegVideoFactory, VIDEO_FRAME_RATES, VIDEO_PROFILES, videoCodecsByFps, videoDimensions, videoEncodingProfile } from './video-stream.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAIR_TTL_MS = 3 * 60_000;
const PAIR_CODE_TTL_MS = 10 * 60_000;
const PAIR_POLL_RETENTION_MS = 5 * 60_000;
const MAX_PAIR_ATTEMPTS_PER_WINDOW = 10;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_TRUSTED_DEVICES = 100;
const MAX_TRUST_STORE_BYTES = 128 * 1024;
const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const FRAME_CACHE_MS = 15;
const CURSOR_CACHE_MS = 25;
const CURSOR_SHAPES = new Set(['arrow', 'text', 'hand', 'wait', 'crosshair', 'size-we', 'size-ns', 'size-nwse', 'size-nesw', 'move', 'not-allowed']);
export const SCREEN_PROFILES = Object.freeze({
  balanced: Object.freeze({ maxWidth: 1920, maxHeight: 1080, quality: 88, label: '高清' }),
  sharp: Object.freeze({ maxWidth: 2560, maxHeight: 1440, quality: 92, label: '超清' }),
  native: Object.freeze({ maxWidth: 3840, maxHeight: 2160, quality: 95, label: '原画' }),
});
const screenProfileList = () => Object.entries(SCREEN_PROFILES).map(([id, profile]) => ({
  id, label: profile.label, width: profile.maxWidth, height: profile.maxHeight, quality: profile.quality,
}));
const ALLOWED_KEYS = new Set(['ENTER', 'TAB', 'BACKSPACE', 'ESC', 'SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT']);
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/host', ['host.html', 'text/html; charset=utf-8']],
  ['/host.js', ['host.js', 'text/javascript; charset=utf-8']],
  ['/host.css', ['host.css', 'text/css; charset=utf-8']],
]);
const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function writeJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    ...RESPONSE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1';
}

function openBrowser(url) {
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  const fallback = () => console.log(`未能自动打开浏览器，请在本机浏览器打开：${url}`);
  browser.once('error', fallback);
  browser.once('exit', (code) => { if (code) fallback(); });
  browser.unref();
}

async function existingRemoteHost(port) {
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!response.ok) return false;
    const status = await response.json();
    if (status.service === 'nearremote') return true;
    // Recognize a copy started before the launcher update without restarting it.
    if (typeof status.deviceName !== 'string' || !status.screen?.width || !status.screen?.height) return false;
    const panel = await fetch(`${base}/host`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!panel.ok) return false;
    const html = await panel.text();
    return html.includes('<title>NearRemote') && /name="host-token"\s+content="[A-Za-z0-9_-]{40,}"/.test(html);
  } catch { return false; }
}

function clientIp(req) {
  const address = req.socket.remoteAddress || 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function isPrivateAddress(address) {
  if (address === '127.0.0.1' || address === '::1' || address === 'localhost') return true;
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validDeviceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
}

function serverIdentity(filename, suppliedId) {
  const valid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  if (suppliedId !== undefined) {
    if (!valid(suppliedId)) throw new Error('serverId 必须是有效的 UUID');
    return suppliedId;
  }
  if (!filename) return randomUUID();
  const read = () => {
    if (fsSync.statSync(filename).size > 4096) throw new Error('电脑标识文件过大');
    const stored = JSON.parse(fsSync.readFileSync(filename, 'utf8'));
    if (stored?.version !== 1 || !valid(stored.id)) throw new Error('电脑标识文件格式无效');
    return stored.id;
  };
  try { return read(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取电脑标识：${error.message}。请检查 ${filename}，修复后重新启动。`);
  }
  const id = randomUUID();
  try {
    fsSync.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    // Exclusive creation also keeps two simultaneous launchers on one identity.
    fsSync.writeFileSync(filename, JSON.stringify({ version: 1, id }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return id;
  } catch (error) {
    if (error.code === 'EEXIST') {
      try { return read(); } catch (cause) { throw new Error(`无法读取电脑标识：${cause.message}。请检查 ${filename}，修复后重新启动。`); }
    }
    throw new Error(`无法保存电脑标识：${error.message}。请检查 ${filename} 所在目录是否可写。`);
  }
}

function readTrustStore(filename) {
  if (!filename) return new Map();
  try {
    if (fsSync.statSync(filename).size > MAX_TRUST_STORE_BYTES) throw new Error('授权文件过大');
    const data = JSON.parse(fsSync.readFileSync(filename, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.devices) || data.devices.length > MAX_TRUSTED_DEVICES) throw new Error('授权文件格式无效');
    const devices = new Map();
    const ids = new Set();
    for (const item of data.devices) {
      if (!item || typeof item !== 'object' || typeof item.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.tokenHash)
        || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id)
        || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 32 || /[\u0000-\u001F\u007F]/.test(item.name)
        || typeof item.ip !== 'string' || !isPrivateAddress(item.ip)
        || !Number.isSafeInteger(item.issuedAt) || item.issuedAt <= 0
        || (item.deviceId !== undefined && !validDeviceId(item.deviceId))
        || devices.has(item.tokenHash) || ids.has(item.id)) throw new Error('授权记录无效');
      ids.add(item.id);
      devices.set(item.tokenHash, {
        id: item.id, name: item.name, ip: item.ip, issuedAt: item.issuedAt,
        ...(item.deviceId ? { deviceId: item.deviceId } : {}),
      });
    }
    return devices;
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw new Error(`无法读取已记住的设备授权：${error.message}。请检查 ${filename}，修复后重新启动。`);
  }
}

function writeTrustStore(filename, devices) {
  if (!filename) return;
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fsSync.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const content = JSON.stringify({ version: 1, devices: [...devices.entries()].map(([hash, session]) => ({
      tokenHash: hash, id: session.id, name: session.name, ip: session.ip, issuedAt: session.issuedAt,
      ...(session.deviceId ? { deviceId: session.deviceId } : {}),
    })) }, null, 2);
    fsSync.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsSync.renameSync(temporary, filename);
  } catch (cause) {
    try { fsSync.unlinkSync(temporary); } catch { /* Only this write's private temporary file is eligible for cleanup. */ }
    const error = new Error('无法保存设备授权，请检查授权文件目录是否可写后重试。');
    error.status = 503;
    error.cause = cause;
    throw error;
  }
}

function localIPv4Addresses(interfaces = os.networkInterfaces()) {
  const result = new Set(['127.0.0.1', 'localhost', '::1']);
  for (const addresses of Object.values(interfaces)) {
    for (const item of addresses || []) {
      if (item.family === 'IPv4' && !item.internal && isPrivateAddress(item.address)) result.add(item.address);
    }
  }
  return result;
}

function hostWithoutPort(header) {
  if (typeof header !== 'string') return '';
  if (header.startsWith('[')) return header.slice(1, header.indexOf(']'));
  const separator = header.lastIndexOf(':');
  return separator > -1 ? header.slice(0, separator) : header;
}

function rateLimiter({ windowMs, max }) {
  const windows = new Map();
  return (key) => {
    const now = Date.now();
    let item = windows.get(key);
    if (!item || now - item.startedAt >= windowMs) {
      item = { startedAt: now, count: 0 };
      windows.set(key, item);
    }
    item.count++;
    if (windows.size > 2048) {
      for (const [candidate, value] of windows) {
        if (now - value.startedAt >= windowMs) windows.delete(candidate);
      }
    }
    return item.count <= max;
  };
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const error = new Error('请使用 JSON 格式发送请求');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error('请求内容过长');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error('请求格式无效');
    error.status = 400;
    throw error;
  }
}

export function createPowerShellBridge({ spawnProcess = spawn, executable = 'powershell.exe' } = {}) {
  const child = spawnProcess(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'windows-control.ps1'),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let buffer = '';
  const failAll = (error) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response);
    else entry.reject(new Error(response.error || 'Windows 控制操作失败'));
  });
  child.stderr.on('data', (chunk) => {
    buffer = (buffer + chunk.toString('utf8')).slice(-4000);
  });
  child.once('error', (error) => failAll(error));
  child.once('exit', (code) => failAll(new Error(`Windows 控制进程已退出 (${code ?? 'unknown'})${buffer ? `: ${buffer.trim()}` : ''}`)));

  return {
    send(action, data = {}) {
      if (closed) return Promise.reject(new Error('Windows 控制进程未运行'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Windows 控制操作超时'));
        }, action === 'screen' ? 8000 : 3000);
        pending.set(id, { resolve, reject, timer });
        const line = JSON.stringify({ id, action, ...data });
        child.stdin.write(`${line}\n`, (error) => {
          if (!error) return;
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(error);
        });
      });
    },
    close() {
      if (closed) return;
      child.stdin.end();
      const killTimer = setTimeout(() => child.kill(), 1000);
      killTimer.unref();
    },
  };
}

function normalizeInput(value) {
  const invalid = (message) => {
    const error = new Error(message);
    error.status = 400;
    throw error;
  };
  if (!value || typeof value !== 'object') invalid('控制指令无效');
  const unit = (number) => Number.isFinite(number) && number >= 0 && number <= 1;
  switch (value.action) {
    case 'pointer':
      if (!unit(value.x) || !unit(value.y)) invalid('鼠标坐标无效');
      return { action: 'pointer', x: value.x, y: value.y };
    case 'button':
      if (!['left', 'right'].includes(value.button) || typeof value.down !== 'boolean') invalid('鼠标按键无效');
      return { action: 'button', button: value.button, down: value.down };
    case 'click':
      if (!['left', 'right'].includes(value.button) || !unit(value.x) || !unit(value.y)) invalid('鼠标点击无效');
      return { action: 'click', button: value.button, x: value.x, y: value.y };
    case 'scroll':
      if (!Number.isFinite(value.deltaX) || !Number.isFinite(value.deltaY)
        || Math.abs(value.deltaX) > 1200 || Math.abs(value.deltaY) > 1200) invalid('滚动距离无效');
      return { action: 'scroll', deltaX: value.deltaX, deltaY: value.deltaY };
    case 'text':
      if (typeof value.text !== 'string' || value.text.length > 2000) invalid('文字最多 2000 个字符');
      return { action: 'text', text: value.text };
    case 'key':
      if (!ALLOWED_KEYS.has(value.key)) invalid('不支持这个按键');
      return { action: 'key', key: value.key };
    default:
      invalid('不支持这个控制指令');
  }
}

function attachLocalApproval(serverState, input = process.stdin, output = process.stdout) {
  const prompt = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  prompt.on('line', (line) => {
    if (/^revoke\s+all$/i.test(line.trim())) {
      void serverState.revokeAll()
        .then(() => output.write('已撤销全部已记住的设备授权与控制会话。\n'))
        .catch((error) => output.write(`撤销失败：${error.message}\n`));
      return;
    }
    const match = /^(approve|deny)\s+([a-f0-9]{4})$/i.exec(line.trim());
    if (!match) return;
    const request = [...serverState.pairRequests.values()].find((item) => item.approvalCode === match[2].toLowerCase());
    if (!request || request.status !== 'pending' || Date.now() > request.expiresAt) {
      output.write('该配对请求不存在或已过期。\n');
      return;
    }
    try {
      if (match[1].toLowerCase() === 'approve') {
        serverState.decide(request.requestId, 'approve');
        output.write(`已授权并记住 ${request.name}。该设备现在可以控制本机。\n`);
      } else {
        serverState.decide(request.requestId, 'deny');
        output.write(`已拒绝 ${request.name} 的配对。\n`);
      }
    } catch (error) { output.write(`操作失败：${error.message}\n`); }
  });
  return prompt;
}

export function createRemoteServer(options = {}) {
  if (process.platform !== 'win32' && !options.bridge) {
    throw new Error('远程控制主机端目前仅支持 Windows。');
  }
  const trustStorePath = options.trustStorePath ? path.resolve(options.trustStorePath) : null;
  const identityPath = options.identityPath ? path.resolve(options.identityPath) : null;
  const serverId = serverIdentity(identityPath, options.serverId);
  let trustedDevices = readTrustStore(trustStorePath);
  const state = {
    serverId,
    deviceName: options.deviceName || os.hostname(),
    screen: options.screen || null,
    code: options.pairCode || String(randomInt(100000, 1_000_000)),
    codeExpiresAt: Date.now() + PAIR_CODE_TTL_MS,
    pairRequests: new Map(),
    tokens: new Map(),
    closed: false,
    onPairRequest: options.onPairRequest || ((message) => process.stdout.write(`\n${message}\n`)),
  };
  const bridge = options.bridge || createPowerShellBridge(options.bridgeOptions);
  const captureBridge = options.captureBridge || bridge;
  const cursorBridge = options.cursorBridge || bridge;
  const videoFactory = options.videoFactory || createFFmpegVideoFactory(options.videoOptions);
  const videoCapabilities = videoFactory.capabilities || {
    available: videoFactory.available !== false, endpoint: '/api/video.mp4', codec: VIDEO_PROFILES.balanced.codec,
    codecs: Object.fromEntries(Object.entries(VIDEO_PROFILES).map(([id, profile]) => [id, profile.codec])), maxFps: 90,
  };
  const videoStreams = new Map();
  const stopVideo = (token) => { videoStreams.get(token)?.stop(); };
  const saveTrustedDevices = (next) => {
    if (next.size > MAX_TRUSTED_DEVICES) {
      const error = new Error('已记住的设备已达上限，请先在电脑管理页撤销不再使用的设备。');
      error.status = 409;
      throw error;
    }
    writeTrustStore(trustStorePath, next);
    trustedDevices = next;
  };
  const authenticate = (req) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!token) return null;
    const active = state.tokens.get(token);
    if (active) return active;
    const remembered = trustedDevices.get(tokenHash(token));
    if (!remembered) return null;
    const session = { ...remembered, token, ip: clientIp(req) };
    state.tokens.set(token, session);
    return session;
  };
  const knownSessions = () => {
    const sessions = new Map([...trustedDevices.values()].map((session) => [session.id, { ...session, remembered: Boolean(trustStorePath), connected: false }]));
    for (const session of state.tokens.values()) sessions.set(session.id, { ...session, remembered: Boolean(trustStorePath), connected: true });
    return [...sessions.values()];
  };
  const hostToken = randomBytes(32).toString('base64url');
  const heldButtons = new Map();
  let inputWork = Promise.resolve();
  let queuedInputs = 0;
  const frameCache = new Map();
  const pendingCaptures = new Map();
  const captureQueue = [];
  let captureRunning = false;
  let cursorSample = null;
  let cursorSampling = null;
  const cursorUnavailable = () => Object.assign(new Error('暂时无法读取电脑鼠标状态'), { status: 503 });
  const getCursor = () => {
    if (state.closed) return Promise.reject(cursorUnavailable());
    if (cursorSample && Date.now() - cursorSample.sampledAt < CURSOR_CACHE_MS) return Promise.resolve(cursorSample);
    if (cursorSampling) return cursorSampling;
    cursorSampling = Promise.resolve().then(() => cursorBridge.send('cursor')).then((result) => {
      const value = result?.data;
      if (state.closed || !value || typeof value !== 'object'
        || !Number.isFinite(value.x) || value.x < 0 || value.x > 1
        || !Number.isFinite(value.y) || value.y < 0 || value.y > 1
        || ['visible', 'leftDown', 'rightDown'].some((key) => typeof value[key] !== 'boolean')
        || !CURSOR_SHAPES.has(value.shape)) throw cursorUnavailable();
      cursorSample = {
        cursor: { x: value.x, y: value.y, visible: value.visible, leftDown: value.leftDown, rightDown: value.rightDown, shape: value.shape },
        sampledAt: Date.now(),
      };
      return cursorSample;
    }).catch(() => { throw cursorUnavailable(); }).finally(() => { cursorSampling = null; });
    return cursorSampling;
  };
  const queueInput = (action, data = {}, ownerToken) => {
    const limit = action === 'button' && data.down === false ? 128 : 64;
    if (queuedInputs >= limit) {
      const error = new Error('控制请求繁忙，请稍候');
      error.status = 429;
      return Promise.reject(error);
    }
    queuedInputs++;
    const result = inputWork.then(() => {
      if (ownerToken && !state.tokens.has(ownerToken)) {
        const error = new Error('控制授权已撤销');
        error.status = 401;
        throw error;
      }
      return bridge.send(action, data);
    });
    inputWork = result.catch(() => {}).finally(() => { queuedInputs--; });
    return result;
  };
  const closedCaptureError = () => Object.assign(new Error('屏幕采集正在关闭'), { status: 503 });
  const runCaptures = async () => {
    if (captureRunning || state.closed) return;
    captureRunning = true;
    try {
      while (captureQueue.length && !state.closed) {
        const job = captureQueue.shift();
        const profile = SCREEN_PROFILES[job.profileId];
        try {
          const started = performance.now();
          const result = await captureBridge.send('screen', { maxWidth: profile.maxWidth, maxHeight: profile.maxHeight, quality: profile.quality });
          if (state.closed) throw closedCaptureError();
          if (typeof result.data !== 'string' || result.data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) throw new Error('屏幕图像过大或格式无效');
          const image = Buffer.from(result.data, 'base64');
          if (image.length > MAX_FRAME_BYTES) throw new Error('屏幕图像过大');
          const screen = state.screen || { width: 1920, height: 1080 };
          const scale = Math.min(1, profile.maxWidth / screen.width, profile.maxHeight / screen.height);
          const frame = {
            image, capturedAt: Date.now(), captureMs: Math.round((performance.now() - started) * 10) / 10,
            width: Math.max(1, Math.round(screen.width * scale)), height: Math.max(1, Math.round(screen.height * scale)),
          };
          frameCache.set(job.profileId, frame);
          job.resolve(frame);
        } catch (error) { job.reject(error); }
        finally { pendingCaptures.delete(job.profileId); }
      }
    } finally { captureRunning = false; }
  };
  const getFrame = (profileId) => {
    if (state.closed) return Promise.reject(closedCaptureError());
    const cached = frameCache.get(profileId);
    if (cached && Date.now() - cached.capturedAt < FRAME_CACHE_MS) return Promise.resolve(cached);
    if (pendingCaptures.has(profileId)) return pendingCaptures.get(profileId);
    // Only the three allowlisted profiles can enter this FIFO. Requests for the
    // same profile share its pending capture, keeping native work bounded.
    const promise = new Promise((resolve, reject) => { captureQueue.push({ profileId, resolve, reject }); });
    pendingCaptures.set(profileId, promise);
    void runCaptures();
    return promise;
  };
  const releaseButtons = async (token) => {
    const entries = token ? [[token, heldButtons.get(token)]] : [...heldButtons.entries()];
    for (const [owner, active] of entries) {
      if (!active) continue;
      heldButtons.delete(owner);
      for (const [button, timer] of active) {
        clearTimeout(timer);
        await queueInput('button', { button, down: false }).catch(() => {});
      }
    }
  };
  const expireRequest = (request, status = 'expired') => {
    request.status = status;
    request.finishedAt = Date.now();
    delete request.token;
  };
  const cleanPairRequests = () => {
    const now = Date.now();
    for (const [id, request] of state.pairRequests) {
      if (request.status === 'pending' && now > request.expiresAt) expireRequest(request);
      if (request.status !== 'pending' && now - request.finishedAt > PAIR_POLL_RETENTION_MS) state.pairRequests.delete(id);
    }
    while (state.pairRequests.size >= 100) {
      const oldest = [...state.pairRequests.values()].find((request) => request.status !== 'pending');
      if (!oldest) break;
      state.pairRequests.delete(oldest.requestId);
    }
  };
  const isSameDevice = (session, request) => {
    if (request.deviceId && session.deviceId) return request.deviceId === session.deviceId;
    // A new browser identifier may replace its pre-identifier session. Legacy
    // clients only replace legacy sessions, never distinct identified browsers.
    if (!request.deviceId && session.deviceId) return false;
    return session.ip === request.ip && session.name === request.name;
  };
  state.decide = (requestId, decision) => {
    cleanPairRequests();
    const request = state.pairRequests.get(requestId);
    if (!request || request.status !== 'pending') return false;
    if (decision === 'approve') {
      // Device identity only deduplicates after local approval. A pairing
      // request alone must never revoke a currently authorized controller.
      const next = new Map(trustedDevices);
      for (const [hash, session] of next) {
        if (isSameDevice(session, request)) next.delete(hash);
      }
      const token = randomBytes(32).toString('base64url');
      const session = {
        id: randomUUID(), name: request.name, ip: request.ip, issuedAt: Date.now(),
        ...(request.deviceId ? { deviceId: request.deviceId } : {}),
      };
      next.set(tokenHash(token), session);
      // Persist before changing an existing authorization or the pending request.
      // A failed disk write leaves the old device and approval state intact.
      saveTrustedDevices(next);
      for (const [token, session] of state.tokens) {
        if (isSameDevice(session, request)) void invalidateActiveToken(token);
      }
      request.status = 'approved';
      request.finishedAt = Date.now();
      request.token = token;
      state.tokens.set(token, { ...session, token });
    } else expireRequest(request, 'denied');
    return true;
  };
  const invalidateActiveToken = async (token) => {
    state.tokens.delete(token);
    stopVideo(token);
    for (const request of state.pairRequests.values()) {
      if (request.token === token) expireRequest(request);
    }
    await releaseButtons(token);
  };
  state.revokeToken = async (token) => {
    const next = new Map(trustedDevices);
    next.delete(tokenHash(token));
    saveTrustedDevices(next);
    await invalidateActiveToken(token);
  };
  state.revokeSession = async (id) => {
    const next = new Map(trustedDevices);
    for (const [hash, session] of next) if (session.id === id) next.delete(hash);
    saveTrustedDevices(next);
    await Promise.all([...state.tokens.entries()].filter(([, session]) => session.id === id).map(([token]) => invalidateActiveToken(token)));
  };
  state.revokeAll = async () => {
    saveTrustedDevices(new Map());
    state.tokens.clear();
    for (const stream of [...videoStreams.values()]) stream.stop();
    for (const request of state.pairRequests.values()) {
      if (request.status === 'pending') expireRequest(request, 'denied');
      else if (request.status === 'approved') expireRequest(request);
    }
    await releaseButtons();
  };
  state.refreshCode = () => {
    let nextCode;
    do { nextCode = String(randomInt(100000, 1_000_000)); } while (nextCode === state.code);
    state.code = nextCode;
    state.codeExpiresAt = Date.now() + PAIR_CODE_TTL_MS;
    for (const request of state.pairRequests.values()) {
      if (request.status === 'pending') expireRequest(request);
    }
  };
  const addresses = options.addresses || localIPv4Addresses();
  const allowRequest = rateLimiter({ windowMs: 1000, max: 120 });
  const pairAttempts = rateLimiter({ windowMs: 10 * 60_000, max: MAX_PAIR_ATTEMPTS_PER_WINDOW });
  const pollAttempts = rateLimiter({ windowMs: 1000, max: 30 });
  const screenAttempts = rateLimiter({ windowMs: 1000, max: 45 });
  const cursorAttempts = rateLimiter({ windowMs: 1000, max: 45 });
  const videoAttempts = rateLimiter({ windowMs: 10_000, max: 10 });
  const cleanupTimer = setInterval(cleanPairRequests, 30_000);
  cleanupTimer.unref();

  const server = http.createServer(async (req, res) => {
    if (state.closed) return writeJson(res, 503, { error: '控制服务正在关闭' });
    const ip = clientIp(req);
    if (!isPrivateAddress(ip)) return writeJson(res, 403, { error: '仅允许局域网设备连接' });
    if (!addresses.has(hostWithoutPort(req.headers.host))) return writeJson(res, 421, { error: '此地址不属于本机局域网服务' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return writeJson(res, 403, { error: '跨站请求不允许' });
    try {
      let url;
      try { url = new URL(req.url, `http://${req.headers.host}`); }
      catch { return writeJson(res, 400, { error: '请求地址无效' }); }
      const local = isLoopback(ip);
      const hostRoute = url.pathname === '/host' || url.pathname === '/host.js' || url.pathname === '/host.css' || url.pathname.startsWith('/api/host/');
      if (hostRoute && !local) return writeJson(res, 403, { error: '管理面板只允许在这台电脑上打开' });
      if (STATIC_FILES.has(url.pathname) && req.method === 'GET') {
        const [filename, contentType] = STATIC_FILES.get(url.pathname);
        let body;
        try { body = await fs.readFile(path.join(ROOT, 'public', filename)); }
        catch (error) {
          if (error.code === 'ENOENT') return writeJson(res, 404, { error: '页面暂不可用' });
          throw error;
        }
        if (url.pathname === '/host') body = Buffer.from(body.toString('utf8').replaceAll('__HOST_TOKEN__', hostToken));
        res.writeHead(200, { ...RESPONSE_HEADERS, 'Content-Type': contentType, 'Content-Length': body.length });
        return res.end(body);
      }
      if (url.pathname.startsWith('/api/host/')) {
        if (!safeEqual(req.headers['x-host-token'], hostToken)) return writeJson(res, 403, { error: '管理凭证无效，请重新打开本机管理页' });
        if (req.method === 'GET' && url.pathname === '/api/host/state') {
          cleanPairRequests();
          return writeJson(res, 200, {
            deviceName: state.deviceName,
            code: state.code,
            codeExpiresAt: new Date(state.codeExpiresAt).toISOString(),
            screen: state.screen || { width: 1920, height: 1080 },
            urls: getLocalUrls(server.address()?.port || 3211),
            requests: [...state.pairRequests.values()].map(({ requestId, name, ip: address, status, expiresAt }) => ({ requestId, name, ip: address, status, expiresAt: new Date(expiresAt).toISOString() })),
            sessions: knownSessions().map(({ id, name, ip: address, issuedAt, remembered, connected }) => ({ id, name, ip: address, issuedAt: new Date(issuedAt).toISOString(), remembered, connected })),
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/host/decision') {
          const body = await readJson(req, 2048);
          if (typeof body.requestId !== 'string' || !['approve', 'deny'].includes(body.decision)) return writeJson(res, 400, { error: '授权操作无效' });
          if (!state.decide(body.requestId, body.decision)) return writeJson(res, 409, { error: '配对请求已过期或已处理' });
          return writeJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/host/revoke') {
          const body = await readJson(req, 2048);
          if (body.all === true) await state.revokeAll();
          else {
            const session = knownSessions().find((item) => item.id === body.tokenId);
            if (!session) return writeJson(res, 404, { error: '控制设备不存在或已撤销' });
            await state.revokeSession(session.id);
          }
          return writeJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/host/code') {
          await readJson(req, 2048);
          state.refreshCode();
          return writeJson(res, 200, { ok: true, code: state.code, codeExpiresAt: new Date(state.codeExpiresAt).toISOString() });
        }
        if (req.method === 'POST' && url.pathname === '/api/host/shutdown') {
          await readJson(req, 2048);
          // Finish the local authenticated request before closing its listener.
          res.once('finish', () => setImmediate(() => {
            void server.shutdown().then(() => server.emit('shutdown-complete')).catch((error) => server.emit('shutdown-error', error));
          }));
          return writeJson(res, 200, { ok: true });
        }
        return writeJson(res, 404, { error: '未找到管理接口' });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const codecsByFps = videoCodecsByFps(state.screen);
        return writeJson(res, 200, {
          service: 'nearremote',
          serverId: state.serverId,
          ...(local ? { localProcess: { pid: process.pid, projectDirectory: ROOT } } : {}),
          deviceName: state.deviceName,
          screen: state.screen || { width: 1920, height: 1080 },
          screenProfiles: screenProfileList(),
          video: { ...videoCapabilities, codecs: codecsByFps['60'], codecsByFps },
          pairingExpiresAt: new Date(state.codeExpiresAt).toISOString(),
          urls: getLocalUrls(server.address()?.port || 3211),
          isLocalHost: local,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        cleanPairRequests();
        if (!pairAttempts(ip)) return writeJson(res, 429, { error: '尝试次数过多，请稍后再试' });
        const body = await readJson(req, 2048);
        if (Date.now() > state.codeExpiresAt || !safeEqual(body.code, state.code)) return writeJson(res, 401, { error: '配对码错误或已过期' });
        const name = typeof body.name === 'string' ? body.name.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 32) : '';
        if (!name) return writeJson(res, 400, { error: '请填写设备名称' });
        if (body.deviceId !== undefined && !validDeviceId(body.deviceId)) {
          return writeJson(res, 400, { error: '设备标识格式无效，请刷新页面后重试' });
        }
        const deviceId = body.deviceId;
        if (deviceId) {
          const existing = [...state.pairRequests.values()].find((item) => item.status === 'pending' && item.deviceId === deviceId && item.ip === ip);
          if (existing) return writeJson(res, 202, { requestId: existing.requestId, expiresAt: new Date(existing.expiresAt).toISOString() });
        }
        const pendingCount = [...state.pairRequests.values()].filter((item) => item.status === 'pending' && Date.now() <= item.expiresAt).length;
        if (pendingCount >= 3) return writeJson(res, 429, { error: '待确认的配对请求已满，请在电脑前先处理' });
        const requestId = randomUUID();
        let approvalCode;
        do { approvalCode = randomBytes(2).toString('hex'); }
        while ([...state.pairRequests.values()].some((item) => item.approvalCode === approvalCode && item.status === 'pending'));
        const pairRequest = { requestId, approvalCode, name, ip, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + PAIR_TTL_MS, ...(deviceId ? { deviceId } : {}) };
        state.pairRequests.set(requestId, pairRequest);
        state.onPairRequest(`手机「${name}」请求配对（${ip}）。确认设备确实是你的手机后，在此窗口输入：approve ${approvalCode}\n拒绝请输入：deny ${approvalCode}`);
        return writeJson(res, 202, { requestId, expiresAt: new Date(pairRequest.expiresAt).toISOString() });
      }
      const pairCancel = /^\/api\/pair\/([a-f0-9-]{36})\/cancel$/i.exec(url.pathname);
      if (req.method === 'POST' && pairCancel) {
        await readJson(req, 2048);
        const request = state.pairRequests.get(pairCancel[1]);
        if (!request || request.ip !== ip) return writeJson(res, 404, { error: '配对请求不存在' });
        if (request.status === 'pending') expireRequest(request, 'denied');
        return writeJson(res, 200, { ok: true });
      }
      const pairPoll = /^\/api\/pair\/([a-f0-9-]{36})$/i.exec(url.pathname);
      if (req.method === 'GET' && pairPoll) {
        if (!pollAttempts(ip)) return writeJson(res, 429, { error: '查询过于频繁' });
        const request = state.pairRequests.get(pairPoll[1]);
        if (!request || request.ip !== ip) return writeJson(res, 404, { error: '配对请求不存在' });
        if (request.status === 'approved' && !state.tokens.has(request.token)) expireRequest(request);
        if (request.status === 'pending' && Date.now() > request.expiresAt) {
          request.status = 'expired';
          request.finishedAt = Date.now();
        }
        if (request.status !== 'pending' && Date.now() - request.finishedAt > PAIR_POLL_RETENTION_MS) {
          state.pairRequests.delete(request.requestId);
          return writeJson(res, 404, { error: '配对请求已失效' });
        }
        return writeJson(res, 200, { status: request.status, ...(request.status === 'approved' ? { token: request.token } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/api/video.mp4') {
        const session = authenticate(req);
        if (!session) return writeJson(res, 401, { error: '请先配对并授权' });
        const profiles = url.searchParams.getAll('profile');
        const rates = url.searchParams.getAll('fps');
        const profileId = profiles[0] || 'balanced';
        const fps = rates.length ? Number(rates[0]) : 60;
        if (profiles.length > 1 || !Object.hasOwn(VIDEO_PROFILES, profileId) || (profiles.length && !profiles[0])
          || rates.length > 1 || (rates.length && !['30', '60', '90'].includes(rates[0])) || !VIDEO_FRAME_RATES.includes(fps)) return writeJson(res, 400, { error: '视频画质或帧率无效' });
        if (!videoCapabilities.available) return writeJson(res, 503, { error: '高速视频组件尚未就绪，请使用截图预览。' });
        if (!videoAttempts(session.token)) return writeJson(res, 429, { error: '视频切换过于频繁，请稍候重试' });
        stopVideo(session.token);
        if (videoStreams.size >= 2) return writeJson(res, 429, { error: '正在查看视频的设备已达上限' });
        let source;
        let startupTimer;
        let stallTimer;
        let authTimer;
        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          clearTimeout(startupTimer);
          clearTimeout(stallTimer);
          clearInterval(authTimer);
          if (videoStreams.get(session.token) === entry) videoStreams.delete(session.token);
          source?.stop?.();
          source?.stdout?.destroy();
          if (!res.destroyed) res.destroy();
        };
        const entry = { stop };
        videoStreams.set(session.token, entry);
        req.once('aborted', stop);
        res.once('close', stop);
        try {
          source = await videoFactory({ profileId, fps, screen: state.screen || { width: 1920, height: 1080 } });
          if (stopped) { source.stop?.(); return; }
          const timeout = new Promise((_, reject) => {
            startupTimer = setTimeout(() => reject(Object.assign(new Error('视频采集启动超时'), { status: 503 })), 11_000);
            startupTimer.unref();
          });
          const metadata = source.ready ? await Promise.race([source.ready, timeout]) : source;
          clearTimeout(startupTimer);
          if (stopped || state.closed || !state.tokens.has(session.token)) { stop(); return; }
          const dimensions = videoDimensions(state.screen || { width: 1920, height: 1080 }, VIDEO_PROFILES[profileId]);
          res.writeHead(200, {
            ...RESPONSE_HEADERS, 'Content-Type': 'video/mp4', 'X-Video-Codec': metadata.codec || source.codec || videoEncodingProfile(profileId, fps, state.screen).codec,
            'X-Video-Width': metadata.width || dimensions.width, 'X-Video-Height': metadata.height || dimensions.height,
            'X-Video-Fps': fps, 'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();
          authTimer = setInterval(() => { if (!state.tokens.has(session.token) || state.closed) stop(); }, 1000);
          authTimer.unref();
          source.stdout.on('data', (chunk) => {
            if (stopped) return;
            if (!state.tokens.has(session.token) || chunk.length > 2 * 1024 * 1024 || res.writableLength > 2 * 1024 * 1024) { stop(); return; }
            if (!res.write(chunk)) {
              source.stdout.pause();
              clearTimeout(stallTimer);
              stallTimer = setTimeout(stop, 1500);
              stallTimer.unref();
            }
          });
          res.on('drain', () => { clearTimeout(stallTimer); if (!stopped) source.stdout.resume(); });
          source.stdout.once('error', stop);
          source.stdout.once('end', () => { if (!stopped) res.end(); });
          source.stdout.resume();
        } catch (error) {
          clearTimeout(startupTimer);
          if (videoStreams.get(session.token) === entry) videoStreams.delete(session.token);
          source?.stop?.();
          if (stopped || res.destroyed) return;
          if (res.headersSent) return stop();
          writeJson(res, error.status || 503, { error: '无法启动高速视频，请切回截图预览或检查显卡编码器。' });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/cursor') {
        const session = authenticate(req);
        if (!session) return writeJson(res, 401, { error: '请先配对并授权' });
        if (!cursorAttempts(session.token || session.ip)) return writeJson(res, 429, { error: '鼠标状态查询过于频繁' });
        const sample = await getCursor();
        if (!state.tokens.has(session.token)) return writeJson(res, 401, { error: '控制授权已撤销' });
        return writeJson(res, 200, sample);
      }
      if (req.method === 'GET' && url.pathname === '/api/screen.jpg') {
        const session = authenticate(req);
        if (!session) return writeJson(res, 401, { error: '请先配对并授权' });
        const requestedProfiles = url.searchParams.getAll('profile');
        if (requestedProfiles.length > 1 || (requestedProfiles.length && !Object.hasOwn(SCREEN_PROFILES, requestedProfiles[0]))) return writeJson(res, 400, { error: '画质档位无效' });
        const profileId = requestedProfiles[0] || 'balanced';
        if (!screenAttempts(session.token || session.ip)) return writeJson(res, 429, { error: '屏幕刷新过于频繁' });
        const frame = await getFrame(profileId);
        if (!state.tokens.has(session.token)) return writeJson(res, 401, { error: '控制授权已撤销' });
        res.writeHead(200, {
          ...RESPONSE_HEADERS,
          'Content-Type': 'image/jpeg', 'Content-Length': frame.image.length,
          'X-Frame-Width': frame.width, 'X-Frame-Height': frame.height,
          'X-Frame-Profile': profileId, 'X-Frame-Quality': SCREEN_PROFILES[profileId].quality,
          'X-Capture-Ms': frame.captureMs,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        });
        return res.end(frame.image);
      }
      if (req.method === 'POST' && url.pathname === '/api/input') {
        const session = authenticate(req);
        if (!session) return writeJson(res, 401, { error: '请先配对并授权' });
        if (!allowRequest(session.ip)) return writeJson(res, 429, { error: '请求过于频繁' });
        const command = normalizeInput(await readJson(req));
        let active;
        let holdTimer;
        if (command.action === 'button') {
          active = heldButtons.get(session.token);
          if (!active) heldButtons.set(session.token, active = new Map());
          holdTimer = active.get(command.button);
          if (command.down) {
            clearTimeout(holdTimer);
            holdTimer = setTimeout(() => {
              active.delete(command.button);
              if (!active.size) heldButtons.delete(session.token);
              void queueInput('button', { button: command.button, down: false }).catch(() => {});
            }, 8000);
            holdTimer.unref();
            active.set(command.button, holdTimer);
          }
        }
        await queueInput(command.action, command, session.token);
        if (command.action === 'button' && !command.down) {
          clearTimeout(holdTimer);
          active.delete(command.button);
          if (!active.size) heldButtons.delete(session.token);
        }
        return writeJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/disconnect') {
        const session = authenticate(req);
        if (!session) return writeJson(res, 401, { error: '配对设备不存在' });
        await state.revokeToken(session.token);
        return writeJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/release') {
        const session = authenticate(req);
        if (!session) return writeJson(res, 401, { error: '配对设备不存在' });
        await releaseButtons(session.token);
        return writeJson(res, 200, { ok: true });
      }
      return writeJson(res, 404, { error: '未找到接口' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return writeJson(res, error.status || 500, { error: error.status ? error.message : '服务端发生错误' });
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  const prompt = options.approvalInput ? attachLocalApproval(state, options.approvalInput, options.approvalOutput || process.stdout) : null;
  server.remoteState = state;
  server.initializeVideo = (configuration = {}) => videoFactory.initialize?.(configuration) || Promise.resolve(videoCapabilities);
  Object.defineProperty(server, 'videoReady', { get: () => server.initializeVideo() });
  server.shutdown = async () => {
    if (state.closed) return;
    state.closed = true;
    clearInterval(cleanupTimer);
    for (const pair of state.pairRequests.values()) pair.status = 'expired';
    state.tokens.clear();
    for (const stream of [...videoStreams.values()]) stream.stop();
    videoFactory.close?.();
    prompt?.close();
    for (const job of captureQueue.splice(0)) {
      pendingCaptures.delete(job.profileId);
      job.reject(closedCaptureError());
    }
    if (captureBridge !== bridge) captureBridge.close?.();
    if (cursorBridge !== bridge && cursorBridge !== captureBridge) cursorBridge.close?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await releaseButtons();
    bridge.close?.();
  };
  return server;
}

function getLocalUrls(port) {
  const urls = [];
  for (const [name, items] of Object.entries(os.networkInterfaces())) {
    for (const item of items || []) {
      if (item.family !== 'IPv4' || item.internal || item.address.startsWith('169.254.') || !isPrivateAddress(item.address)) continue;
      urls.push({ preferred: /wi-?fi|wlan|ethernet|以太网|无线/i.test(name), url: `http://${item.address}:${port}` });
    }
  }
  return [...new Map(urls.sort((a, b) => Number(b.preferred) - Number(a.preferred)).map((item) => [item.url, item])).values()]
    .map((item) => item.url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') {
    console.error('NearRemote 主机端目前仅支持 Windows 10/11。');
    process.exitCode = 1;
  } else {
    const bridge = createPowerShellBridge();
    const captureBridge = createPowerShellBridge();
    let server;
    try {
      const dataDir = process.env.REMOTE_DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'NearRemote');
      server = createRemoteServer({ bridge, captureBridge, trustStorePath: path.join(dataDir, 'trusted-devices.json'), identityPath: path.join(dataDir, 'server-id.json') });
    } catch (error) {
      console.error(`无法启动服务：${error.message}`);
      bridge.close();
      captureBridge.close();
      process.exit(1);
    }
    const port = Number(process.env.REMOTE_PORT || 3211);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error('REMOTE_PORT 必须为 1–65535 的整数。');
      bridge.close();
      captureBridge.close();
      process.exit(1);
    }
    server.on('error', async (error) => {
      if (error.code === 'EADDRINUSE' && process.argv.includes('--open') && await existingRemoteHost(port)) {
        console.log('NearRemote 已在运行，正在打开电脑管理页。');
        openBrowser(`http://localhost:${port}/host`);
        await server.shutdown();
        process.exitCode = 0;
        return;
      }
      console.error(`无法启动服务：${error.message}`);
      server.shutdown().finally(() => process.exit(1));
    });
    server.listen(port, '0.0.0.0', async () => {
      try {
        const dimensions = await captureBridge.send('dimensions');
        const preview = await captureBridge.send('screen', SCREEN_PROFILES.balanced);
        const image = Buffer.from(preview.data, 'base64');
        server.remoteState.screen = dimensions.data;
        const video = await server.initializeVideo({ screen: dimensions.data, displays: dimensions.data.displays });
        console.log('\nNearRemote 已启动。请让 iPhone 与此电脑连接同一 Wi-Fi。');
        console.log(`配对码（10 分钟内有效）：${server.remoteState.code}`);
        console.log('在 iPhone Safari 中打开下列地址之一：');
        for (const url of getLocalUrls(server.address().port)) console.log(`  ${url}`);
        console.log(`屏幕预览已就绪（${server.remoteState.screen.width} × ${server.remoteState.screen.height}，预览 ${image.length.toLocaleString()} 字节）。`);
        console.log(video.available ? `视频加速已就绪：${video.capture} / ${video.encoder}，最高目标 ${video.maxFps} 帧。` : `视频加速：${video.reason || '不可用，使用兼容截图。'}`);
        const hostUrl = `http://localhost:${server.address().port}/host`;
        console.log(`电脑管理面板：${hostUrl}`);
        console.log('连接请求需要在此窗口逐个批准。输入 `approve XXXX` 授权，`deny XXXX` 拒绝；输入 `revoke all` 紧急撤销全部控制；按 Ctrl+C 停止。\n');
        attachLocalApproval(server.remoteState);
        if (process.argv.includes('--open')) openBrowser(hostUrl);
      } catch (error) {
        console.error(`无法初始化 Windows 屏幕/输入控制：${error.message}`);
        await server.shutdown();
        process.exitCode = 1;
      }
    });
    process.once('SIGINT', () => server.shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => server.shutdown().finally(() => process.exit(0)));
    server.once('shutdown-complete', () => process.exit(0));
    server.once('shutdown-error', (error) => {
      console.error(`无法正常停止服务：${error.message}`);
      process.exit(1);
    });
  }
}
