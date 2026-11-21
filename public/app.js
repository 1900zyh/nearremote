'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'nearremote.session';
const NAME_KEY = 'nearremote.deviceName';
const DEVICE_ID_KEY = 'nearremote.deviceId';
const DISPLAY_KEY = 'nearremote.display';
const AUTO_RECONNECT_KEY = 'nearremote.autoReconnect';
const CURSOR_VISIBLE_KEY = 'nearremote.cursorVisible';
const CURSOR_SHAPES = new Set(['arrow', 'text', 'hand', 'wait', 'crosshair', 'size-we', 'size-ns', 'size-nwse', 'size-nesw', 'move', 'not-allowed']);
const SCREEN_PROFILES = new Set(['balanced', 'sharp', 'native']);
const SCREEN_FRAME_RATES = new Set([10, 20, 30, 60, 90]);
const MAX_SCREEN_BYTES = 12 * 1024 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';
const readStored = (key) => { try { return sessionStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key); } catch { /* Private browsing may disable storage. */ } };
const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readPersistent = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const autoReconnectEnabled = readPersistent(AUTO_RECONNECT_KEY) !== 'false';

function displayPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}');
    const legacy = !Object.hasOwn(saved, 'mode');
    const preferences = {
      version: 2,
      profile: SCREEN_PROFILES.has(saved.profile) ? saved.profile : 'balanced',
      fps: !legacy && SCREEN_FRAME_RATES.has(saved.fps) ? saved.fps : 60,
      mode: saved.mode === 'jpeg' ? 'jpeg' : 'auto',
      screen: saved.screen === 'all' || /^display:\d{1,2}$/.test(saved.screen) ? saved.screen : 'auto',
    };
    // Earlier releases defaulted to 20 fps without a transport preference.
    // Upgrade those defaults once while preserving deliberate video/JPEG choices.
    if (legacy) {
      try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(preferences)); } catch { /* Use the migrated preferences for this page. */ }
    }
    return preferences;
  } catch { return { version: 2, profile: 'balanced', fps: 60, mode: 'auto', screen: 'auto' }; }
}

function isTabletDevice() {
  const touch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  return /iPad/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    || (touch && Math.min(window.screen?.width || innerWidth, window.screen?.height || innerHeight) >= 600);
}

function savedToken() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) return token;
  } catch { /* Fall back to the previous tab-local session when storage is restricted. */ }
  return readStored(TOKEN_KEY);
}

function rememberToken(token, expectedToken = null) {
  let persistent = false;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else if (expectedToken && localStorage.getItem(TOKEN_KEY) === expectedToken) localStorage.removeItem(TOKEN_KEY);
    persistent = true;
  } catch { /* The live session can still work without persistent browser storage. */ }
  if (token) store(TOKEN_KEY, token);
  else if (expectedToken && readStored(TOKEN_KEY) === expectedToken) store(TOKEN_KEY, null);
  return persistent;
}

function getDeviceId() {
  const valid = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
  try {
    const saved = localStorage.getItem(DEVICE_ID_KEY);
    if (valid(saved)) return saved;
  } catch { /* A private browser may not permit persistent storage. */ }
  const temporary = readStored(DEVICE_ID_KEY);
  if (valid(temporary)) return temporary;
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const created = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(DEVICE_ID_KEY, created); } catch { /* Use this tab's storage next. */ }
  store(DEVICE_ID_KEY, created);
  return created;
}
const deviceId = getDeviceId();

const state = {
  token: savedToken(), host: null, active: false, paused: false, pairing: false,
  restoring: false, resumeGeneration: 0,
  pairGeneration: 0, requestId: null, frameGeneration: 0, frameController: null, imageURL: null,
  pointer: { x: 0.5, y: 0.5 }, held: new Set(), drag: false,
  queue: [], pumping: false, epoch: 0, pointerTimer: null, pendingPointer: null,
  lastPointerAt: 0, lastFrameAt: 0, destroying: false, revoking: false,
  display: displayPreferences(), frameTask: null, frameSamples: [], lastMetricsAt: 0,
  frameWidth: 0, frameHeight: 0, videoReady: false, videoResource: null, transport: 'jpeg',
  viewSignature: null,
  viewportZoom: 1, viewportPan: { x: 0, y: 0 }, panMode: false,
  autoReconnect: autoReconnectEnabled, connectionWanted: Boolean(savedToken()) && autoReconnectEnabled,
  manualPaused: false, recovering: false, reconnectTimer: null, reconnectAttempt: 0, connectionTask: null,
  showCursor: readPersistent(CURSOR_VISIBLE_KEY) !== 'false', actualCursor: null,
  cursorTask: null, cursorController: null, cursorUnsupported: false, lastLocalCursorAt: -Infinity,
};

const expandedView = {
  active: false, preferLandscape: !isTabletDevice(), nativeEntered: false, ownsOrientationLock: false,
  generation: 0, lockGeneration: 0, transitionUntil: 0, scrollX: 0, scrollY: 0,
};

class APIError extends Error {
  constructor(message, status = 0, network = false) { super(message); this.status = status; this.network = network; }
}

async function api(path, { method = 'GET', data, token, signal, raw = false, keepalive = false } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8500);
  try {
    const headers = { Accept: raw ? 'image/jpeg' : 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method, headers, cache: 'no-store', signal: controller.signal,
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}), keepalive,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new APIError(result.error || `请求未成功（${response.status}）`, response.status, response.status >= 500 || response.status === 408);
    }
    return raw ? await response.blob() : await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new APIError('电脑响应超时，请检查网络连接。', 0, true);
    if (error instanceof APIError) throw error;
    throw new APIError('暂时无法连接电脑，请确认电脑开机、服务已启动，并连接同一网络。', 0, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function notice(message = '', kind = 'info') {
  $('notice').hidden = !message;
  $('notice').textContent = message;
  $('notice').dataset.kind = kind;
}

function setStatus(message, kind = 'idle') {
  $('status-label').textContent = message;
  $('connection-status').dataset.state = kind;
}

function controlsEnabled() { return state.active && !state.paused && !state.revoking; }
function hasVisualFrame() { return state.videoReady || Boolean(state.imageURL); }

function cursorTrackingEnabled() {
  return state.showCursor && !state.cursorUnsupported && Boolean(state.token)
    && controlsEnabled() && hasVisualFrame() && !document.hidden && !state.destroying;
}

function stopCursorTracking() {
  state.cursorController?.abort();
}

function validCursorSample(sample) {
  return sample && typeof sample === 'object' && Number.isFinite(sample.x) && Number.isFinite(sample.y)
    && sample.x >= 0 && sample.x <= 1 && sample.y >= 0 && sample.y <= 1
    && typeof sample.visible === 'boolean' && typeof sample.leftDown === 'boolean' && typeof sample.rightDown === 'boolean'
    && CURSOR_SHAPES.has(sample.shape);
}

function hasLocalCursorPrediction() {
  return performance.now() - state.lastLocalCursorAt < 180 || Boolean(state.pendingPointer)
    || state.pumping || state.held.size > 0;
}

function syncCursorTracking() {
  if (!cursorTrackingEnabled()) { stopCursorTracking(); return; }
  // A cancelled request drains before another tracker can start, including
  // rapid pause/resume and quality changes. There is never a polling backlog.
  if (state.cursorTask) return;
  const token = state.token;
  const controller = new AbortController();
  state.cursorController = controller;
  const task = (async () => {
    while (cursorTrackingEnabled() && token === state.token && !controller.signal.aborted) {
      const requestedAt = performance.now();
      let delay = 50;
      try {
        const result = await api('/api/cursor', { token, signal: controller.signal });
        if (controller.signal.aborted || token !== state.token || !cursorTrackingEnabled()) break;
        const sample = result.cursor;
        if (!validCursorSample(sample)) { delay = 500; }
        else if (requestedAt >= state.lastLocalCursorAt) {
          const previous = state.actualCursor;
          const changed = !previous || ['x', 'y', 'visible', 'leftDown', 'rightDown', 'shape'].some((key) => previous[key] !== sample[key]);
          state.actualCursor = { ...sample };
          if (!hasLocalCursorPrediction()) {
            state.pointer = { x: sample.x, y: sample.y };
            if (previous && !previous.leftDown && sample.leftDown) pulseCursor('left');
            if (previous && !previous.rightDown && sample.rightDown) pulseCursor('right');
          }
          if (changed || cursor.dataset.source !== 'computer') updateCursor();
        }
      } catch (error) {
        if (controller.signal.aborted || token !== state.token || !cursorTrackingEnabled()) break;
        if (error.status === 401) { forgetSession('电脑已撤销这台手机的授权，请重新配对。'); break; }
        if (error.status === 404) { state.cursorUnsupported = true; state.actualCursor = null; updateCursor(); break; }
        // Cursor telemetry is independent of the picture and control channels.
        // A transient cursor error must not interrupt a working video session.
        delay = 1000;
      }
      await waitForFrame(Math.max(0, delay - (performance.now() - requestedAt)), controller.signal);
    }
  })();
  state.cursorTask = task;
  void task.catch(() => {}).finally(() => {
    if (state.cursorTask === task) state.cursorTask = null;
    if (state.cursorController === controller) state.cursorController = null;
    if (cursorTrackingEnabled()) syncCursorTracking();
  });
}

$('show-cursor')?.addEventListener('change', () => {
  state.showCursor = $('show-cursor').checked;
  state.cursorUnsupported = false;
  try { localStorage.setItem(CURSOR_VISIBLE_KEY, String(state.showCursor)); } catch { /* The open page can still toggle it. */ }
  updateCursor();
  syncCursorTracking();
});

function cancelReconnect(resetAttempt = false) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (resetAttempt) state.reconnectAttempt = 0;
}

function shouldReconnect() {
  return state.autoReconnect && state.connectionWanted && !state.manualPaused && Boolean(state.token)
    && !state.revoking && !state.pairing && !state.destroying && !document.hidden;
}

function scheduleReconnect(immediate = false) {
  if (!shouldReconnect() || controlsEnabled() || state.reconnectTimer || state.connectionTask || state.restoring) return;
  const delay = immediate ? 0 : Math.min(15_000, 2000 * 2 ** Math.min(3, state.reconnectAttempt++));
  if (delay) {
    setStatus(`等待电脑恢复 · ${delay / 1000} 秒后重试`, 'pending');
    notice('这台电脑的配对已记住。服务启动或网络恢复后会自动连接，无需重新输入配对码。');
  }
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (shouldReconnect()) void initializeConnection();
  }, delay);
}

function recoverConnection(message = '连接暂时中断，配对信息已保留。') {
  if (!state.token || state.revoking || state.manualPaused) return;
  pause(false, true);
  state.active = false;
  state.recovering = true;
  state.host = null;
  setStatus('等待电脑重新连接', 'pending');
  render();
  notice(state.autoReconnect ? `${message} 正在等待自动恢复。` : `${message} 请点击「恢复连接」重试。`, 'warning');
  scheduleReconnect();
}

$('auto-reconnect')?.addEventListener('change', () => {
  state.autoReconnect = $('auto-reconnect').checked;
  try { localStorage.setItem(AUTO_RECONNECT_KEY, String(state.autoReconnect)); } catch { /* Keep the preference for this open page. */ }
  if (!state.autoReconnect) cancelReconnect();
  else if (state.token && !state.manualPaused) {
    state.connectionWanted = true;
    scheduleReconnect(true);
  }
});

function desktopLayout() {
  const width = Math.max(1, Number(state.host?.screen.width) || state.frameWidth || 1920);
  const height = Math.max(1, Number(state.host?.screen.height) || state.frameHeight || 1080);
  const displays = (Array.isArray(state.host?.screen.displays) ? state.host.screen.displays : [])
    .filter((display) => Number.isSafeInteger(display.index) && display.index >= 0 && display.index < 100
      && Number.isFinite(display.x) && Number.isFinite(display.y) && display.x >= 0 && display.y >= 0
      && Number.isFinite(display.width) && Number.isFinite(display.height) && display.width > 0 && display.height > 0
      && display.x < width && display.y < height)
    .map((display) => ({ ...display, width: Math.min(display.width, width - display.x), height: Math.min(display.height, height - display.y) }));
  return { width, height, displays };
}

function viewedRegion() {
  const desktop = desktopLayout();
  const explicit = state.display.screen?.startsWith('display:')
    ? desktop.displays.find((display) => display.index === Number(state.display.screen.slice(8))) : null;
  const automatic = state.display.screen !== 'all' && !explicit && isTabletDevice()
    ? desktop.displays.find((display) => display.primary) || desktop.displays[0] : null;
  const display = explicit || automatic;
  if (display) return {
    ...display, desktopWidth: desktop.width, desktopHeight: desktop.height,
    label: `${display.primary ? '主屏 · ' : ''}屏幕 ${display.index + 1}`, cropped: true,
  };
  return { x: 0, y: 0, width: desktop.width, height: desktop.height, desktopWidth: desktop.width, desktopHeight: desktop.height,
    label: desktop.displays.length > 1 ? '双屏总览' : '整个桌面', cropped: false };
}

function updateDisplayOptions() {
  const select = $('display-select');
  const desktop = desktopLayout();
  const signature = JSON.stringify(desktop);
  if (select && select.dataset.layout !== signature) {
    const entries = [['auto', isTabletDevice() ? '自动 · 主屏' : '自动'], ['all', desktop.displays.length > 1 ? '双屏总览' : '整个桌面'],
      ...desktop.displays.map((display) => [`display:${display.index}`, `${display.primary ? '主屏 · ' : ''}屏幕 ${display.index + 1}`])];
    select.replaceChildren(...entries.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    select.dataset.layout = signature;
  }
  if (select) select.value = Array.from(select.options).some((option) => option.value === state.display.screen) ? state.display.screen : 'auto';
  const region = viewedRegion();
  const viewSignature = `${region.x},${region.y},${region.width},${region.height}`;
  if (state.viewSignature !== viewSignature) {
    state.pointer = { x: (region.x + region.width / 2) / region.desktopWidth, y: (region.y + region.height / 2) / region.desktopHeight };
    state.viewSignature = viewSignature;
    state.viewportZoom = 1;
    state.viewportPan = { x: 0, y: 0 };
    state.panMode = false;
  }
  if ($('screen-display-label')) $('screen-display-label').textContent = region.label;
  $('screen-surface').style.setProperty('--view-aspect', `${region.width} / ${region.height}`);
  updateZoomControls();
}

function updateZoomControls() {
  if ($('zoom-value')) $('zoom-value').textContent = `${Math.round(state.viewportZoom * 100)}%`;
  if ($('zoom-in')) $('zoom-in').disabled = state.viewportZoom >= 3;
  if ($('zoom-out')) $('zoom-out').disabled = state.viewportZoom <= 1;
  if ($('zoom-reset')) $('zoom-reset').disabled = state.viewportZoom <= 1;
  if ($('pan-toggle')) {
    $('pan-toggle').hidden = state.viewportZoom <= 1;
    $('pan-toggle').setAttribute('aria-pressed', String(state.panMode));
    $('pan-toggle').textContent = state.panMode ? '拖动画面' : '操作电脑';
    $('pan-toggle').setAttribute('aria-label', state.panMode ? '当前拖动画面，点击切换操作电脑' : '当前操作电脑，点击切换拖动画面');
  }
}

function render() {
  const enabled = controlsEnabled();
  document.body.classList.toggle('tablet-device', isTabletDevice());
  document.body.classList.toggle('session-active', state.active);
  $('pair-form').hidden = Boolean(state.token) || state.pairing;
  $('pair-waiting').hidden = !state.pairing;
  $('saved-session').hidden = !state.token || state.active;
  $('connected-info').hidden = !state.token;
  $('pair-button').disabled = state.pairing || !state.host;
  $('disconnect-button').disabled = state.revoking || state.restoring;
  $('disconnect-button').textContent = '断开连接';
  if ($('forget-device-button')) {
    $('forget-device-button').disabled = state.revoking || state.restoring;
    $('forget-device-button').textContent = state.revoking ? '正在撤销授权…' : '忘记此电脑并撤销授权';
  }
  if ($('auto-reconnect')) $('auto-reconnect').checked = state.autoReconnect;
  $('pause-button').disabled = !enabled;
  $('resume-button').disabled = state.revoking || state.restoring;
  $('reconnect-button').disabled = state.revoking || state.restoring;
  $('screen-paused').hidden = !state.token || !state.paused;
  $('screen-empty').hidden = hasVisualFrame() || Boolean(state.token && state.paused);
  $('screen-image').hidden = !state.imageURL || state.videoReady;
  $('screen-video').hidden = !state.videoReady;
  $('screen-surface').classList.toggle('has-image', hasVisualFrame());
  $('live-dot').classList.toggle('active', enabled && hasVisualFrame());
  $('preview-state').textContent = state.paused ? '已暂停' : enabled ? '实时预览' : '桌面预览';
  $('pointer-help').textContent = state.drag ? '拖动已开启，移动后再点「拖动」松开' : enabled ? '轻点即单击，双指上下滑动滚动' : state.token ? '点击继续控制，恢复触控与键盘' : '先连接电脑，再开始操作';
  $('drag-button').setAttribute('aria-pressed', String(state.drag));
  for (const id of ['left-button', 'right-button', 'drag-button', 'text-input']) $(id).disabled = !enabled;
  for (const button of document.querySelectorAll('[data-key]')) button.disabled = !enabled;
  $('send-text').disabled = !enabled || !$('text-input').value.length;
  $('pair-code').disabled = state.pairing;
  $('device-name').disabled = state.pairing;
  if ($('show-cursor')) $('show-cursor').checked = state.showCursor;
  updateCursor();
  syncCursorTracking();
  updateZoomControls();
}

function clearImage() {
  stopCursorTracking();
  clearTimeout(cursorFeedbackTimer);
  cursorPulse.classList.remove('active');
  cleanupVideo();
  $('screen-image').removeAttribute('src');
  if (state.imageURL) URL.revokeObjectURL(state.imageURL);
  state.imageURL = null;
  $('frame-info').textContent = '— fps';
  $('stream-resolution').textContent = '等待画面';
  $('stream-bandwidth').textContent = '— Mbps';
  state.frameWidth = 0;
  state.frameHeight = 0;
}

function stopFrames() {
  state.frameGeneration++;
  state.frameController?.abort();
  state.frameController = null;
  cleanupVideo();
}

function screenPath(profile = state.display.profile) {
  return `/api/screen.jpg?profile=${encodeURIComponent(profile)}`;
}

function saveDisplayPreferences() {
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(state.display)); } catch { /* Session remains usable if storage is unavailable. */ }
}

$('quality-select').value = state.display.profile;
$('fps-select').value = String(state.display.fps);
$('transport-select').value = state.display.mode;
$('quality-select').addEventListener('change', () => {
  const profile = $('quality-select').value;
  if (!SCREEN_PROFILES.has(profile) || profile === state.display.profile) return;
  state.display.profile = profile;
  saveDisplayPreferences();
  if (controlsEnabled()) void startFrames();
});
$('fps-select').addEventListener('change', () => {
  const fps = Number($('fps-select').value);
  if (!SCREEN_FRAME_RATES.has(fps)) return;
  state.display.fps = fps;
  saveDisplayPreferences();
  if (controlsEnabled()) void startFrames();
});
$('transport-select').addEventListener('change', () => {
  state.display.mode = $('transport-select').value === 'jpeg' ? 'jpeg' : 'auto';
  saveDisplayPreferences();
  if (controlsEnabled()) void startFrames();
});
$('display-select')?.addEventListener('change', () => {
  const view = $('display-select').value;
  if (view !== 'auto' && view !== 'all' && !desktopLayout().displays.some((display) => view === `display:${display.index}`)) return;
  releaseLayoutGesture();
  state.display.screen = view;
  saveDisplayPreferences();
  updateDisplayOptions();
  updateCursor();
});
$('display-settings').addEventListener('toggle', () => {
  $('screen-panel').classList.toggle('settings-open', $('display-settings').open);
});
document.addEventListener('pointerdown', (event) => {
  if (!$('display-settings').contains(event.target)) $('display-settings').open = false;
});

function waitForFrame(ms, signal) {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function updateFrameMetrics(now, byteLength, width, height) {
  state.frameSamples.push({ at: now, bytes: byteLength });
  while (state.frameSamples.length > 1 && state.frameSamples[0].at < now - 1500) state.frameSamples.shift();
  if (state.frameSamples.length < 2 || now - state.lastMetricsAt < 900) return;
  const first = state.frameSamples[0];
  const elapsed = now - first.at;
  if (elapsed < 500) return;
  const frames = state.frameSamples.length - 1;
  const bytes = state.frameSamples.reduce((sum, frame) => sum + frame.bytes, 0) - first.bytes;
  $('frame-info').textContent = `${(frames * 1000 / elapsed).toFixed(1)} fps`;
  $('stream-bandwidth').textContent = `${(bytes * 8 / elapsed / 1000).toFixed(1)} Mbps`;
  $('stream-resolution').textContent = `${width} × ${height}`;
  state.lastMetricsAt = now;
}

function videoFrameRate() {
  const requested = state.display.fps >= 90 ? 90 : state.display.fps >= 60 ? 60 : 30;
  const advertised = Number(state.host?.video?.maxFps ?? 60);
  if (!Number.isFinite(advertised)) return null;
  return [90, 60, 30].find((fps) => fps <= requested && fps <= advertised) || null;
}

function videoSourceChoice(profile) {
  if (state.display.mode !== 'auto' || state.display.fps < 30 || !state.host?.video?.available) return null;
  const fps = videoFrameRate();
  if (!fps) return null;
  const codec = state.host.video.codecsByFps?.[String(fps)]?.[profile] || state.host.video.codecs?.[profile] || state.host.video.codec;
  if (typeof codec !== 'string' || !/^avc1\.[0-9a-f]{6}$/i.test(codec)) return null;
  const mime = `video/mp4; codecs="${codec}"`;
  for (const Source of [window.ManagedMediaSource, window.MediaSource]) {
    try { if (Source?.isTypeSupported?.(mime)) return { Source, mime, fps }; } catch { /* Try the next supported implementation. */ }
  }
  return null;
}

function waitMediaEvent(target, eventName, signal, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      target.removeEventListener(eventName, success);
      target.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const success = () => finish();
    const failed = () => finish(new APIError('视频解码暂不可用。'));
    const aborted = () => finish(new DOMException('Video stopped', 'AbortError'));
    const timer = setTimeout(() => finish(new APIError('视频启动超时。')), timeout);
    target.addEventListener(eventName, success, { once: true });
    target.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function cleanupVideo(expected = state.videoResource) {
  if (!expected || state.videoResource !== expected) return;
  state.videoResource = null;
  expected.controller.abort();
  void expected.reader?.cancel().catch(() => {});
  clearInterval(expected.watchdog);
  clearInterval(expected.metricsTimer);
  if (expected.frameCallback !== null) {
    try { $('screen-video').cancelVideoFrameCallback?.(expected.frameCallback); } catch { /* Already completed. */ }
  }
  for (const [target, event, listener] of expected.listeners) target.removeEventListener(event, listener);
  const video = $('screen-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (expected.url) URL.revokeObjectURL(expected.url);
  video.hidden = true;
  $('video-play-button').hidden = true;
  state.videoReady = false;
  $('screen-image').hidden = !state.imageURL;
}

async function runVideoStream({ controller: parentController, token, profile, generation, Source, mime, fps }) {
  const video = $('screen-video');
  const source = new Source();
  const controller = new AbortController();
  const signal = controller.signal;
  const resource = {
    controller, source, reader: null, url: null, listeners: [], frameCallback: null,
    watchdog: null, metricsTimer: null, error: null, totalBytes: 0,
    startedAt: performance.now(), lastFrameAt: performance.now(), metricAt: performance.now(),
    metricBytes: 0, frameCount: 0, metricFrames: 0, lastPresented: null, streaming: false,
  };
  const listen = (target, event, listener) => {
    target.addEventListener(event, listener);
    resource.listeners.push([target, event, listener]);
  };
  const fail = (error) => { resource.error = error; controller.abort(); };
  listen(parentController.signal, 'abort', () => controller.abort());
  state.videoResource = resource;
  state.transport = 'video';
  state.videoReady = false;
  $('stream-mode').textContent = '正在启动视频加速…';
  video.muted = true;
  video.playsInline = true;
  video.disableRemotePlayback = true;
  const play = () => {
    const result = video.play();
    result?.then(() => { $('video-play-button').hidden = true; }).catch(() => {
      if (state.videoResource === resource && !signal.aborted) $('video-play-button').hidden = false;
    });
  };
  const isCurrent = () => state.videoResource === resource && generation === state.frameGeneration && controlsEnabled() && token === state.token && !signal.aborted;
  const markFrame = (presentedFrames, presented = true) => {
    if (!isCurrent()) return;
    resource.lastFrameAt = performance.now();
    if (presentedFrames !== undefined) {
      if (resource.lastPresented !== null) resource.frameCount += Math.max(0, presentedFrames - resource.lastPresented);
      resource.lastPresented = presentedFrames;
    } else if (presented) resource.frameCount++;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width && height && (!state.videoReady || width !== state.frameWidth || height !== state.frameHeight)) {
      state.videoReady = true;
      state.frameWidth = width;
      state.frameHeight = height;
      $('screen-meta').textContent = `${width} × ${height}`;
      $('stream-resolution').textContent = `${width} × ${height}`;
      $('stream-mode').textContent = state.display.fps > fps
        ? `视频加速 · H.264 · 电脑当前最高 ${fps} 帧`
        : `视频加速 · H.264 · 目标 ${fps} 帧`;
      render();
      updateCursor();
    }
    const now = performance.now();
    const elapsed = now - resource.metricAt;
    if (elapsed >= 900 && resource.frameCount > resource.metricFrames) {
      $('frame-info').textContent = `${((resource.frameCount - resource.metricFrames) * 1000 / elapsed).toFixed(1)} fps`;
      $('stream-bandwidth').textContent = `${((resource.totalBytes - resource.metricBytes) * 8 / elapsed / 1000).toFixed(1)} Mbps`;
      resource.metricAt = now;
      resource.metricFrames = resource.frameCount;
      resource.metricBytes = resource.totalBytes;
    }
  };
  listen(video, 'error', () => fail(new APIError('此浏览器无法解码加速视频。')));
  listen(video, 'loadeddata', () => {
    if (!isCurrent()) return;
    // A display:none video can defer presentation callbacks on Safari. Reveal
    // the decoded first frame before waiting for actual presentation metrics.
    markFrame(undefined, false);
    play();
  });
  listen($('video-play-button'), 'click', play);
  // ManagedMediaSource signals when Safari is ready to receive media. Register
  // before attaching the source: startstreaming can precede sourceopen.
  listen(source, 'startstreaming', () => { resource.streaming = true; });
  listen(source, 'endstreaming', () => { resource.streaming = false; });
  const sourceOpened = waitMediaEvent(source, 'sourceopen', signal);
  resource.url = URL.createObjectURL(source);
  video.src = resource.url;
  video.load();
  play();
  if (video.requestVideoFrameCallback) {
    const presented = (_now, metadata) => {
      if (!isCurrent()) return;
      markFrame(metadata.presentedFrames);
      resource.frameCallback = video.requestVideoFrameCallback(presented);
    };
    resource.frameCallback = video.requestVideoFrameCallback(presented);
  } else {
    resource.metricsTimer = setInterval(() => {
      const quality = video.getVideoPlaybackQuality?.();
      const frames = quality ? Math.max(0, quality.totalVideoFrames - (quality.droppedVideoFrames || 0)) : undefined;
      if (Number.isFinite(frames) && frames !== resource.lastPresented) markFrame(frames);
    }, 250);
  }
  resource.watchdog = setInterval(() => {
    if (isCurrent() && performance.now() - resource.lastFrameAt > 10_000) fail(new APIError('视频画面未能启动，已使用兼容画面。'));
  }, 1000);
  const sourceOperation = async (sourceBuffer, operation) => {
    if (signal.aborted) throw new DOMException('Video stopped', 'AbortError');
    const completion = waitMediaEvent(sourceBuffer, 'updateend', signal);
    try { operation(); } catch (error) {
      // Consume the event wait on cancellation as well as synchronous codec errors.
      controller.abort();
      await completion.catch(() => {});
      throw error;
    }
    await completion;
  };
  try {
    await sourceOpened;
    if (Source === window.ManagedMediaSource && !resource.streaming) await waitMediaEvent(source, 'startstreaming', signal, 5000);
    const query = new URLSearchParams({ profile, fps: String(fps) });
    let response;
    try {
      response = await fetch(`/api/video.mp4?${query}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'video/mp4' }, cache: 'no-store', signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new APIError('视频连接暂时中断。', 0, true);
    }
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new APIError(result.error || '视频通道暂不可用。', response.status);
    }
    if (!response.body || !(response.headers.get('content-type') || '').includes('video/mp4')) throw new APIError('电脑返回的视频格式无法识别。');
    const actualCodec = response.headers.get('x-video-codec');
    const actualMime = actualCodec && /^avc1\.[0-9a-f]{6}$/i.test(actualCodec) ? `video/mp4; codecs="${actualCodec}"` : mime;
    if (!Source.isTypeSupported(actualMime)) throw new APIError('此浏览器不支持电脑的视频编码。');
    const sourceBuffer = source.addSourceBuffer(actualMime);
    sourceBuffer.mode = 'segments';
    try { source.duration = Infinity; } catch { /* Some live implementations manage duration themselves. */ }
    resource.reader = response.body.getReader();
    while (isCurrent()) {
      if (Source === window.ManagedMediaSource && !resource.streaming) {
        // Let Safari request another short window instead of appending while
        // ManagedMediaSource has explicitly stopped requesting media.
        await waitMediaEvent(source, 'startstreaming', signal, 1500);
      }
      let result;
      try { result = await resource.reader.read(); }
      catch (error) {
        if (signal.aborted) throw error;
        throw new APIError('视频连接暂时中断。', 0, true);
      }
      const { done, value } = result;
      if (done) throw new APIError('视频连接已结束。', 0, true);
      if (!value?.byteLength) continue;
      if (value.byteLength > 4 * 1024 * 1024) throw new APIError('视频缓冲过大，已切换兼容画面。');
      resource.totalBytes += value.byteLength;
      const ranges = sourceBuffer.buffered;
      if (ranges.length && video.currentTime - ranges.start(0) > 3) {
        await sourceOperation(sourceBuffer, () => sourceBuffer.remove(ranges.start(0), Math.max(ranges.start(0), video.currentTime - 2)));
      }
      await sourceOperation(sourceBuffer, () => sourceBuffer.appendBuffer(value));
      if (!isCurrent()) break;
      const buffered = sourceBuffer.buffered;
      if (buffered.length) {
        const start = buffered.start(0);
        const end = buffered.end(buffered.length - 1);
        try {
          source.setLiveSeekableRange?.(start, end);
          if (end > start + 0.05 && (video.currentTime < start || end - video.currentTime > 0.7)) video.currentTime = Math.max(start, end - 0.15);
        } catch { /* Metadata may not yet be ready for a seek. */ }
        if (video.paused && $('video-play-button').hidden) play();
      }
    }
  } catch (error) {
    if (resource.error) throw resource.error;
    throw error;
  } finally { cleanupVideo(resource); }
}

function startFrames() {
  stopFrames();
  const generation = state.frameGeneration;
  const token = state.token;
  const profile = state.display.profile;
  const previousTask = state.frameTask;
  const task = (async () => {
    // Profile changes cancel and drain the previous fetch/decode before a new
    // one starts, so a slow phone never accumulates stale frames.
    if (previousTask) await previousTask.catch(() => {});
    if (generation !== state.frameGeneration || !controlsEnabled() || token !== state.token) return;
    const controller = new AbortController();
    state.frameController = controller;
    state.frameSamples = [];
    state.lastMetricsAt = performance.now();
    const choice = videoSourceChoice(profile);
    if (choice) {
      try {
        await runVideoStream({ controller, token, profile, generation, ...choice });
        return;
      } catch (error) {
        if (generation !== state.frameGeneration || !controlsEnabled() || controller.signal.aborted) return;
        if (error.status === 401) {
          forgetSession('电脑已撤销这台手机的授权，请重新配对。');
          return;
        }
        if (error.network || error.status === 403) {
          recoverConnection('视频连接暂时中断，配对信息已保留。');
          return;
        }
        cleanupVideo();
        notice('视频加速暂不可用，已切换为兼容画面。可以在画面设置中重新选择自动模式重试。', 'warning');
      }
    }
    state.transport = 'jpeg';
    $('stream-mode').textContent = state.display.fps > 30 ? '兼容画面 · 最高目标 30 帧' : '兼容画面';
    render();
    while (generation === state.frameGeneration && controlsEnabled() && token === state.token && !controller.signal.aborted) {
      const started = performance.now();
      let retryDelay = 0;
      try {
        const blob = await api(screenPath(profile), { token, raw: true, signal: controller.signal });
        if (generation !== state.frameGeneration || !controlsEnabled()) break;
        if (!blob.type.startsWith('image/') || blob.size > MAX_SCREEN_BYTES) throw new APIError('电脑返回的屏幕画面无法显示。');
        const nextURL = URL.createObjectURL(blob);
        const image = new Image();
        image.src = nextURL;
        try { await image.decode(); } catch { URL.revokeObjectURL(nextURL); throw new APIError('桌面画面加载失败，正在重试。'); }
        if (generation !== state.frameGeneration || !controlsEnabled()) { URL.revokeObjectURL(nextURL); break; }
        const previous = state.imageURL;
        const firstFrame = !previous;
        const dimensionsChanged = state.frameWidth !== image.naturalWidth || state.frameHeight !== image.naturalHeight;
        state.imageURL = nextURL;
        $('screen-image').src = nextURL;
        $('screen-image').hidden = false;
        if (previous) requestAnimationFrame(() => URL.revokeObjectURL(previous));
        const now = performance.now();
        state.frameWidth = image.naturalWidth;
        state.frameHeight = image.naturalHeight;
        updateFrameMetrics(now, blob.size, image.naturalWidth, image.naturalHeight);
        if (dimensionsChanged) {
          $('screen-meta').textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
          $('stream-resolution').textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
          updateCursor();
        }
        if ($('preview-state').textContent !== '实时预览') $('preview-state').textContent = '实时预览';
        // The remainder of the controls only changes with connection state.
        if (firstFrame) render();
      } catch (error) {
        if (generation !== state.frameGeneration || !controlsEnabled()) break;
        if (error.status === 401) { forgetSession('电脑已撤销这台手机的授权，请重新配对。'); break; }
        if (error.network || error.status === 403) {
          recoverConnection('电脑服务或网络暂时不可用，配对信息已保留。');
          break;
        }
        $('preview-state').textContent = '网络不稳定，正在重试';
        retryDelay = 1300;
      }
      const remaining = retryDelay || Math.max(0, 1000 / Math.min(30, state.display.fps) - (performance.now() - started));
      await waitForFrame(remaining, controller.signal);
    }
  })();
  state.frameTask = task;
  void task.catch(() => {}).finally(() => { if (state.frameTask === task) state.frameTask = null; });
  return task;
}

function beginSession(token, initialImageURL = null) {
  cancelReconnect(true);
  state.token = token;
  const persistent = rememberToken(token);
  state.restoring = false;
  state.resumeGeneration++;
  state.active = true;
  state.paused = false;
  state.pairing = false;
  state.manualPaused = false;
  state.connectionWanted = true;
  state.recovering = false;
  state.actualCursor = null;
  state.cursorUnsupported = false;
  state.lastLocalCursorAt = -Infinity;
  state.epoch++;
  state.queue.length = 0;
  $('pair-code').value = '';
  if (initialImageURL) {
    const previous = state.imageURL;
    state.imageURL = initialImageURL;
    $('screen-image').src = initialImageURL;
    if (previous) URL.revokeObjectURL(previous);
  }
  setStatus('连接正常', 'connected');
  if (persistent) notice('已连接并记住这台电脑，下次打开网页会自动连接。');
  else notice('已连接。浏览器暂时无法保存长期配对，关闭页面后可能需要重新配对。', 'warning');
  if (isTabletDevice() || matchMedia('(max-width: 640px)').matches) $('connection-panel').open = false;
  render();
  void startFrames();
}

function forgetSession(message) {
  cancelReconnect(true);
  state.connectionWanted = false;
  state.manualPaused = true;
  state.recovering = false;
  if (expandedView.active) exitExpanded();
  stopFrames();
  const forgottenToken = state.token;
  state.token = null;
  rememberToken(null, forgottenToken);
  state.restoring = false;
  state.resumeGeneration++;
  state.active = false;
  state.paused = false;
  state.revoking = false;
  state.drag = false;
  state.held.clear();
  state.queue.length = 0;
  state.epoch++;
  clearTimeout(state.pointerTimer);
  state.pointerTimer = null;
  state.pendingPointer = null;
  clearImage();
  setStatus('尚未配对');
  $('connection-panel').open = true;
  resetGestures();
  render();
  const newerToken = savedToken();
  notice(newerToken && newerToken !== forgottenToken ? '授权已在另一页面更新，刷新此页即可自动连接。' : message);
}

async function checkHost() {
  try {
    const host = await api('/api/status');
    if (!host.screen || !Number.isFinite(host.screen.width) || !Number.isFinite(host.screen.height)) throw new APIError('电脑返回的屏幕尺寸无效。');
    state.host = host;
    updateDisplayOptions();
    $('computer-name').textContent = host.deviceName || '我的电脑';
    $('screen-meta').textContent = `${host.screen.width} × ${host.screen.height}`;
    if (!state.active && !state.pairing) setStatus(state.token ? '已记住这台电脑' : '等待配对');
    render();
    updateCursor();
  } catch (error) {
    state.host = null;
    $('computer-name').textContent = '暂时无法连接电脑';
    setStatus('连接不可用', 'error');
    notice(error.message, 'error');
    render();
  }
}

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('pair-code').value.trim();
  const name = $('device-name').value.trim();
  if (!/^\d{6}$/.test(code)) { notice('请输入电脑上显示的六位数字配对码。', 'warning'); return; }
  if (!name || name.length > 32) { notice('请给手机起个不超过 32 个字符的名字。', 'warning'); return; }
  state.pairing = true;
  const generation = ++state.pairGeneration;
  notice();
  setStatus('等待电脑批准', 'pending');
  render();
  try {
    const result = await api('/api/pair', { method: 'POST', data: { code, name, deviceId } });
    if (generation !== state.pairGeneration) {
      void cancelPairRequest(result.requestId);
      return;
    }
    state.requestId = result.requestId;
    store(NAME_KEY, name);
    try { localStorage.setItem(NAME_KEY, name); } catch { /* The tab-local name remains available. */ }
    const expiresAt = Date.parse(result.expiresAt) || Date.now() + 180_000;
    while (generation === state.pairGeneration && Date.now() < expiresAt) {
      await sleep(1000);
      if (generation !== state.pairGeneration) return;
      const status = await api(`/api/pair/${encodeURIComponent(result.requestId)}`);
      if (generation !== state.pairGeneration) return;
      if (status.status === 'pending') continue;
      state.requestId = null;
      if (status.status === 'approved' && typeof status.token === 'string' && status.token.length > 20) { beginSession(status.token); return; }
      if (status.status === 'denied') throw new APIError('电脑拒绝了连接请求。确认是你的手机后，再试一次。');
      if (status.status === 'expired') throw new APIError('配对请求已过期，请重新连接。');
      throw new APIError('配对结果无法识别，请重新连接。');
    }
    if (generation === state.pairGeneration) throw new APIError('等待电脑确认超时，请重新连接。');
  } catch (error) {
    if (generation !== state.pairGeneration) return;
    state.pairing = false;
    state.requestId = null;
    setStatus('配对未完成', 'error');
    notice(error.message, 'error');
    render();
  }
});

async function cancelPairRequest(requestId) {
  if (!requestId) return;
  try {
    await api(`/api/pair/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', data: {} });
    const result = await api(`/api/pair/${encodeURIComponent(requestId)}`);
    if (result.status === 'approved' && result.token && result.token !== state.token) {
      // A local approval can race the cancel tap. Revoke a token granted after the user cancelled.
      await api('/api/disconnect', { method: 'POST', token: result.token });
    }
  } catch { /* The host can reject an expired request; its short TTL also ends pending requests. */ }
}

$('cancel-pair-button').addEventListener('click', () => {
  state.pairGeneration++;
  state.pairing = false;
  if (state.requestId) void cancelPairRequest(state.requestId);
  state.requestId = null;
  setStatus('等待配对');
  notice('已取消等待。可以在电脑端拒绝刚才的请求。');
  render();
});

async function resume(automatic = false, hostAlreadyChecked = false) {
  if (!state.token || state.revoking || state.restoring || document.hidden) return;
  if (!automatic) {
    state.manualPaused = false;
    state.connectionWanted = true;
    cancelReconnect(true);
  } else if (!shouldReconnect()) return;
  const token = state.token;
  const generation = ++state.resumeGeneration;
  state.restoring = true;
  render();
  if (!hostAlreadyChecked) await checkHost();
  if (generation !== state.resumeGeneration || token !== state.token) return;
  if (!state.host) {
    state.restoring = false;
    render();
    scheduleReconnect();
    return;
  }
  setStatus(automatic ? '正在自动连接' : '正在恢复控制', 'pending');
  notice(automatic ? '已记住这台电脑，正在自动连接…' : '正在验证电脑的控制授权…');
  let imageURL = null;
  try {
    const profile = state.display.profile;
    const blob = await api(screenPath(profile), { token, raw: true });
    if (!blob.type.startsWith('image/') || blob.size > MAX_SCREEN_BYTES) throw new APIError('电脑返回的屏幕画面无法显示。');
    imageURL = URL.createObjectURL(blob);
    const image = new Image();
    image.src = imageURL;
    await image.decode();
    if (generation !== state.resumeGeneration || token !== state.token || document.hidden || (automatic && !shouldReconnect())) {
      URL.revokeObjectURL(imageURL);
      return;
    }
    if (profile !== state.display.profile) {
      URL.revokeObjectURL(imageURL);
      imageURL = null;
      state.restoring = false;
      void resume(automatic, true);
      return;
    }
    beginSession(token, imageURL);
    imageURL = null;
  } catch (error) {
    if (imageURL) URL.revokeObjectURL(imageURL);
    if (generation !== state.resumeGeneration || token !== state.token) return;
    if (error.status === 401) {
      forgetSession('电脑已撤销这台手机的授权，请输入新的配对码重新连接。');
    } else {
      setStatus('暂时无法连接', 'error');
      notice(state.autoReconnect
        ? '暂时无法连接电脑，已保存的配对仍保留。电脑服务恢复后会自动连接。'
        : '暂时无法连接电脑，已保存的配对仍保留。请确认电脑服务和 Wi-Fi，再点击「恢复连接」。', 'warning');
    }
  } finally {
    if (generation === state.resumeGeneration) {
      state.restoring = false;
      render();
      scheduleReconnect();
    }
  }
}
$('reconnect-button').addEventListener('click', () => void resume());
$('resume-button').addEventListener('click', () => void resume());

async function revoke() {
  if (!state.token || state.revoking) return;
  const token = state.token;
  pause(false);
  state.revoking = true;
  render();
  setStatus('正在撤销授权', 'pending');
  // A release must follow any input already in flight. The revocation waits for the same worker.
  await waitForQueue();
  try {
    await api('/api/disconnect', { method: 'POST', token });
    if (state.token === token) forgetSession('已断开连接，并撤销这台手机的控制授权。');
  } catch (error) {
    if (error.status === 401) { forgetSession('这台手机的控制授权已失效。'); return; }
    state.revoking = false;
    setStatus('撤销未确认', 'error');
    notice('暂时无法联系电脑，授权尚未确认撤销。配对凭证仍保留，请恢复网络后重试，或在电脑端撤销全部连接。', 'warning');
    render();
  }
}
$('forget-device-button')?.addEventListener('click', () => void revoke());
$('disconnect-button').addEventListener('click', () => {
  if (!state.token || state.revoking) return;
  pause();
  state.active = false;
  state.paused = false;
  clearImage();
  if (expandedView.active) exitExpanded();
  setStatus('已断开 · 配对已记住');
  $('connection-panel').open = true;
  render();
  notice('已断开连接，配对授权仍保留。点击「恢复连接」即可继续，无需重新输入配对码。');
});

function queueRelease({ immediate = false } = {}) {
  if (!state.token) return;
  const job = { action: 'release', token: state.token, epoch: state.epoch };
  state.queue.push(job);
  void pump();
  if (immediate) {
    // keepalive can leave before Safari freezes a background page; the queued copy preserves input order.
    void api('/api/release', { method: 'POST', token: state.token, keepalive: true }).catch(() => {});
  }
}

function pause(background = false, recovering = false) {
  if (!state.token) return;
  cancelReconnect();
  if (!background && !recovering) {
    state.connectionWanted = false;
    state.manualPaused = true;
    state.recovering = false;
  }
  state.restoring = false;
  state.resumeGeneration++;
  stopFrames();
  state.paused = true;
  state.epoch++;
  state.queue.length = 0;
  state.drag = false;
  state.held.clear();
  clearTimeout(state.pointerTimer);
  state.pointerTimer = null;
  state.pendingPointer = null;
  resetGestures();
  queueRelease({ immediate: background });
  setStatus('控制已暂停', 'paused');
  render();
}
$('pause-button').addEventListener('click', () => pause());

function enqueue(command) {
  if (!controlsEnabled()) return false;
  const previous = state.queue.at(-1);
  if (command.action === 'pointer' && previous?.command?.action === 'pointer') {
    previous.command = command;
    return true;
  }
  if (command.action === 'scroll' && previous?.command?.action === 'scroll') {
    previous.command.deltaX = clamp(previous.command.deltaX + command.deltaX, -1200, 1200);
    previous.command.deltaY = clamp(previous.command.deltaY + command.deltaY, -1200, 1200);
    return true;
  }
  const release = command.action === 'button' && !command.down;
  if (state.queue.length >= (release ? 31 : 27)) {
    const discardable = state.queue.findIndex((item) => ['pointer', 'scroll'].includes(item.command?.action));
    if (discardable >= 0) state.queue.splice(discardable, 1);
    else {
      notice('网络较慢，正在发送已有指令。请稍候再操作。', 'warning');
      return false;
    }
  }
  state.queue.push({ action: 'input', command, token: state.token, epoch: state.epoch });
  void pump();
  return true;
}

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  while (state.queue.length) {
    const job = state.queue.shift();
    if (job.token !== state.token || job.epoch !== state.epoch) continue;
    try {
      await api(job.action === 'release' ? '/api/release' : '/api/input', {
        method: 'POST', token: job.token,
        ...(job.command ? { data: job.command } : {}),
        keepalive: job.action === 'release',
      });
    } catch (error) {
      if (job.token !== state.token || job.epoch !== state.epoch) continue;
      if (error.status === 401) { forgetSession('控制授权已失效，请重新配对。'); break; }
      if (job.action !== 'release') {
        recoverConnection('控制指令未能送达，已丢弃待发送操作，配对信息保留。');
      }
    }
  }
  state.pumping = false;
}

async function waitForQueue() {
  const deadline = Date.now() + 10_000;
  while (state.pumping && Date.now() < deadline) await sleep(50);
}

function setPointer(x, y, force = false) {
  const region = viewedRegion();
  const desktopX = Math.max(1, region.desktopWidth - 1);
  const desktopY = Math.max(1, region.desktopHeight - 1);
  state.pointer = {
    x: clamp(x, region.x / desktopX, (region.x + region.width - 1) / desktopX),
    y: clamp(y, region.y / desktopY, (region.y + region.height - 1) / desktopY),
  };
  state.lastLocalCursorAt = performance.now();
  updateCursor();
  state.pendingPointer = { action: 'pointer', ...state.pointer };
  const elapsed = performance.now() - state.lastPointerAt;
  if (force || elapsed >= 50) { flushPointer(); return; }
  if (!state.pointerTimer) state.pointerTimer = setTimeout(flushPointer, 50 - elapsed);
}

function flushPointer() {
  clearTimeout(state.pointerTimer);
  state.pointerTimer = null;
  if (!state.pendingPointer) return;
  const command = state.pendingPointer;
  state.pendingPointer = null;
  state.lastPointerAt = performance.now();
  enqueue(command);
}

function button(buttonName, down) {
  flushPointer();
  if (!enqueue({ action: 'button', button: buttonName, down })) return false;
  down ? state.held.add(buttonName) : state.held.delete(buttonName);
  state.lastLocalCursorAt = performance.now();
  if (down) pulseCursor(buttonName);
  updateCursor();
  return true;
}

function click(buttonName = 'left') {
  if (buttonName === 'left' && state.drag) {
    if (button('left', false)) state.drag = false;
    render();
    return;
  }
  flushPointer();
  if (enqueue({ action: 'click', button: buttonName, ...state.pointer })) {
    state.lastLocalCursorAt = performance.now();
    pulseCursor(buttonName);
    updateCursor();
  }
}
$('left-button').addEventListener('click', () => click());
$('right-button').addEventListener('click', () => click('right'));
$('drag-button').addEventListener('click', () => {
  if (!controlsEnabled()) return;
  const next = !state.drag;
  if (button('left', next)) state.drag = next;
  render();
});

const cursor = document.createElementNS(SVG_NS, 'svg');
cursor.id = 'remote-cursor';
cursor.classList.add('screen-pointer');
cursor.setAttribute('aria-hidden', 'true');
cursor.setAttribute('preserveAspectRatio', 'none');
const cursorGroup = document.createElementNS(SVG_NS, 'g');
const cursorHeld = document.createElementNS(SVG_NS, 'circle');
cursorHeld.classList.add('cursor-held');
cursorHeld.setAttribute('r', '13');
const cursorPulse = document.createElementNS(SVG_NS, 'circle');
cursorPulse.classList.add('cursor-pulse');
cursorPulse.setAttribute('r', '12');
const cursorGlyph = document.createElementNS(SVG_NS, 'g');
cursorGlyph.classList.add('cursor-glyph');
cursorGlyph.setAttribute('transform', 'scale(1.1)');
const cursorPath = document.createElementNS(SVG_NS, 'path');
cursorPath.classList.add('cursor-shadow');
const CURSOR_GLYPHS = {
  arrow: 'M0 0v17l4.5-4 3.2 7 3-1.4-3.1-6.8 6-.3Z',
  text: 'M-6-10h12M0-10v20M-6 10H6',
  hand: 'M0 0c-1.2 0-2 1-2 2v9l-2-2c-2-2-4 0-3 2l6 9h9l4-6V7c0-2-3-2-3 0V5c0-2-3-2-3 0V4c0-2-3-2-3 0v7V2c0-1-.8-2-2-2Z',
  wait: 'M0-9a9 9 0 1 1-8 4M-8-9v4h4',
  crosshair: 'M-11 0h22M0-11v22M-4-4h8v8h-8Z',
  'size-we': 'M-12 0h24M-7-5l-5 5 5 5M7-5l5 5-5 5',
  'size-ns': 'M0-12v24M-5-7l5-5 5 5M-5 7l5 5 5-5',
  'size-nwse': 'M-9-9 9 9M-9-2v-7h7M2 9h7V2',
  'size-nesw': 'M-9 9 9-9M-9 2v7h7M2-9h7v7',
  move: 'M-11 0h22M0-11v22M-7-4l-4 4 4 4M7-4l4 4-4 4M-4-7l4-4 4 4M-4 7l4 4 4-4',
  'not-allowed': 'M-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0M-6-6 6 6',
};
cursorGlyph.append(cursorPath);
cursorGroup.append(cursorHeld, cursorPulse, cursorGlyph);
cursor.append(cursorGroup);
$('screen-surface').append(cursor);
let cursorFeedbackTimer = null;

function pulseCursor(buttonName) {
  if (!state.showCursor || !controlsEnabled() || !hasVisualFrame()) return;
  cursor.dataset.feedback = buttonName;
  cursorPulse.classList.remove('active');
  // Clicks are infrequent; restarting only this small animation avoids keeping
  // any animation or layout work in the 90 fps picture-rendering loop.
  void cursorPulse.getBoundingClientRect();
  cursorPulse.classList.add('active');
  clearTimeout(cursorFeedbackTimer);
  cursorFeedbackTimer = setTimeout(() => { cursorPulse.classList.remove('active'); }, 420);
}

function imageGeometry() {
  const surface = $('screen-surface');
  const box = surface.getBoundingClientRect();
  const localWidth = surface.clientWidth;
  const localHeight = surface.clientHeight;
  const image = $('screen-image');
  const video = $('screen-video');
  const width = (state.videoReady ? video.videoWidth : image.naturalWidth) || state.host?.screen.width || 16;
  const height = (state.videoReady ? video.videoHeight : image.naturalHeight) || state.host?.screen.height || 9;
  const region = viewedRegion();
  const croppedWidth = width * region.width / region.desktopWidth;
  const croppedHeight = height * region.height / region.desktopHeight;
  const baseScale = Math.min(localWidth / croppedWidth, localHeight / croppedHeight);
  const scale = baseScale * state.viewportZoom;
  const drawnWidth = croppedWidth * scale;
  const drawnHeight = croppedHeight * scale;
  const limitX = Math.max(0, (drawnWidth - localWidth) / 2);
  const limitY = Math.max(0, (drawnHeight - localHeight) / 2);
  state.viewportPan.x = clamp(state.viewportPan.x, -limitX, limitX);
  state.viewportPan.y = clamp(state.viewportPan.y, -limitY, limitY);
  const left = (localWidth - drawnWidth) / 2 + state.viewportPan.x;
  const top = (localHeight - drawnHeight) / 2 + state.viewportPan.y;
  const css = {
    '--media-width': `${width * scale}px`,
    '--media-height': `${height * scale}px`,
    '--media-left': `${left - region.x / region.desktopWidth * width * scale}px`,
    '--media-top': `${top - region.y / region.desktopHeight * height * scale}px`,
    '--media-clip': `inset(${region.y / region.desktopHeight * 100}% ${(region.desktopWidth - region.x - region.width) / region.desktopWidth * 100}% ${(region.desktopHeight - region.y - region.height) / region.desktopHeight * 100}% ${region.x / region.desktopWidth * 100}%)`,
    '--view-aspect': `${region.width} / ${region.height}`,
  };
  surface.classList.toggle('media-cropped', region.cropped || state.viewportZoom > 1);
  for (const [property, value] of Object.entries(css)) {
    if (surface.style.getPropertyValue(property) !== value) surface.style.setProperty(property, value);
  }
  return {
    box, localWidth, localHeight, region,
    rotated: $('screen-panel').classList.contains('landscape-rotated'),
    width: drawnWidth, height: drawnHeight, left, top, baseWidth: croppedWidth * baseScale, baseHeight: croppedHeight * baseScale,
  };
}

function updateCursor() {
  const geometry = imageGeometry();
  const predicted = !state.actualCursor || hasLocalCursorPrediction();
  const sample = predicted ? null : state.actualCursor;
  const position = sample || state.pointer;
  const shape = sample?.shape || 'arrow';
  const desktopX = Math.max(1, geometry.region.desktopWidth - 1);
  const desktopY = Math.max(1, geometry.region.desktopHeight - 1);
  const x = (position.x * desktopX - geometry.region.x) / Math.max(1, geometry.region.width - 1);
  const y = (position.y * desktopY - geometry.region.y) / Math.max(1, geometry.region.height - 1);
  const screenX = geometry.left + Math.max(0, geometry.width - 1) * x;
  const screenY = geometry.top + Math.max(0, geometry.height - 1) * y;
  const inRegion = x >= -0.000001 && x <= 1.000001 && y >= -0.000001 && y <= 1.000001;
  const inViewport = screenX >= 0 && screenX < geometry.localWidth && screenY >= 0 && screenY < geometry.localHeight;
  const shown = state.showCursor && controlsEnabled() && hasVisualFrame() && !document.hidden && !state.destroying
    && (predicted || sample.visible) && inRegion && inViewport;
  const left = predicted ? state.held.has('left') : sample.leftDown;
  const right = predicted ? state.held.has('right') : sample.rightDown;
  const pressed = left && right ? 'both' : left ? 'left' : right ? 'right' : 'none';
  const attributes = { x: position.x.toFixed(6), y: position.y.toFixed(6), shape,
    source: predicted ? 'local' : 'computer', pressed, visible: String(shown) };
  for (const [name, value] of Object.entries(attributes)) if (cursor.dataset[name] !== value) cursor.dataset[name] = value;
  const viewBox = `0 0 ${geometry.localWidth || 1} ${geometry.localHeight || 1}`;
  if (cursor.getAttribute('viewBox') !== viewBox) cursor.setAttribute('viewBox', viewBox);
  const transform = `translate(${screenX},${screenY})`;
  if (cursorGroup.getAttribute('transform') !== transform) cursorGroup.setAttribute('transform', transform);
  if (cursorPath.getAttribute('d') !== CURSOR_GLYPHS[shape]) cursorPath.setAttribute('d', CURSOR_GLYPHS[shape]);
  cursor.toggleAttribute('hidden', !shown);
}

function pointOnImage(event, restrict = true) {
  const geometry = imageGeometry();
  if (!geometry.width || !geometry.height || !geometry.box.width || !geometry.box.height) return null;
  const local = surfaceLocalPoint(event, geometry);
  return localPointOnImage(local, geometry, restrict);
}

function localPointOnImage(local, geometry = imageGeometry(), restrict = false) {
  const x = (local.x - geometry.left) / geometry.width;
  const y = (local.y - geometry.top) / geometry.height;
  if (restrict && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return {
    x: (geometry.region.x + clamp(x) * Math.max(0, geometry.region.width - 1)) / Math.max(1, geometry.region.desktopWidth - 1),
    y: (geometry.region.y + clamp(y) * Math.max(0, geometry.region.height - 1)) / Math.max(1, geometry.region.desktopHeight - 1),
  };
}

function surfaceLocalPoint(event, geometry = imageGeometry()) {
  // CSS landscape fallback rotates the whole panel clockwise. Convert viewport
  // coordinates back into the surface's unrotated local coordinate system first.
  const x = geometry.rotated
    ? (event.clientY - geometry.box.top) * geometry.localWidth / geometry.box.height
    : (event.clientX - geometry.box.left) * geometry.localWidth / geometry.box.width;
  const y = geometry.rotated
    ? (geometry.box.right - event.clientX) * geometry.localHeight / geometry.box.width
    : (event.clientY - geometry.box.top) * geometry.localHeight / geometry.box.height;
  return { x, y };
}

function transformViewport(zoom, anchor, unitAnchor = null) {
  const geometry = imageGeometry();
  const focus = anchor || { x: geometry.localWidth / 2, y: geometry.localHeight / 2 };
  const unit = unitAnchor || {
    x: (focus.x - geometry.left) / (geometry.width || 1),
    y: (focus.y - geometry.top) / (geometry.height || 1),
  };
  const next = clamp(zoom, 1, 3);
  const width = geometry.baseWidth * next;
  const height = geometry.baseHeight * next;
  state.viewportZoom = next;
  state.viewportPan = {
    x: focus.x - unit.x * width - (geometry.localWidth - width) / 2,
    y: focus.y - unit.y * height - (geometry.localHeight - height) / 2,
  };
  if (next <= 1) { state.viewportPan = { x: 0, y: 0 }; state.panMode = false; }
  updateCursor();
  updateZoomControls();
}

function changeViewportZoom(zoom) {
  releaseLayoutGesture();
  if (state.viewportZoom <= 1 && zoom > 1) state.panMode = true;
  transformViewport(zoom);
}
$('zoom-in')?.addEventListener('click', () => changeViewportZoom(state.viewportZoom + 0.25));
$('zoom-out')?.addEventListener('click', () => changeViewportZoom(state.viewportZoom - 0.25));
$('zoom-reset')?.addEventListener('click', () => changeViewportZoom(1));
$('pan-toggle')?.addEventListener('click', () => {
  releaseLayoutGesture();
  state.panMode = !state.panMode;
  updateZoomControls();
});

const screenPointers = new Map();
let screenGesture = null;
$('screen-surface').addEventListener('pointerdown', (event) => {
  if (!controlsEnabled() || !hasVisualFrame() || screenPointers.size >= 2 || event.button !== 0) return;
  const point = pointOnImage(event, screenPointers.size === 0);
  if (!point) return;
  event.preventDefault();
  $('screen-surface').setPointerCapture(event.pointerId);
  const local = surfaceLocalPoint(event);
  screenPointers.set(event.pointerId, local);
  if (screenPointers.size === 1) {
    screenGesture = { kind: 'pointer', id: event.pointerId, local, point, moved: false, dragging: false,
      pan: { ...state.viewportPan }, panning: state.viewportZoom > 1 && state.panMode };
  } else {
    // Switching to a two-finger gesture must not leave a remote drag held.
    const retained = [...screenPointers];
    releaseLayoutGesture();
    for (const [id, position] of retained) screenPointers.set(id, position);
    const [first, second] = [...screenPointers.values()];
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const geometry = imageGeometry();
    screenGesture = { kind: 'multi', mode: 'pending', distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
      zoom: state.viewportZoom, startPositions: [first, second], center, previousCenter: center,
      anchor: { x: (center.x - geometry.left) / geometry.width, y: (center.y - geometry.top) / geometry.height } };
  }
});
$('screen-surface').addEventListener('pointermove', (event) => {
  if (!controlsEnabled() || !screenPointers.has(event.pointerId) || !screenGesture) return;
  event.preventDefault();
  const local = surfaceLocalPoint(event);
  screenPointers.set(event.pointerId, local);
  if (screenGesture.kind === 'multi') {
    if (screenPointers.size !== 2) return;
    const [first, second] = [...screenPointers.values()];
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    if (screenGesture.mode === 'pending') {
      const [firstStart, secondStart] = screenGesture.startPositions;
      const one = { x: first.x - firstStart.x, y: first.y - firstStart.y };
      const two = { x: second.x - secondStart.x, y: second.y - secondStart.y };
      const oneLength = Math.hypot(one.x, one.y);
      const twoLength = Math.hypot(two.x, two.y);
      // Browsers dispatch each finger's move separately. Wait for both before
      // classifying their common movement as scrolling or their spread as zoom.
      if (oneLength < 2 || twoLength < 2) return;
      const direction = (one.x * two.x + one.y * two.y) / (oneLength * twoLength);
      const shift = Math.hypot(center.x - screenGesture.center.x, center.y - screenGesture.center.y);
      const spread = Math.abs(distance - screenGesture.distance);
      if (direction > 0.3 && shift > 6) {
        screenGesture.mode = 'scroll';
        const point = localPointOnImage(screenGesture.center);
        if (point) setPointer(point.x, point.y, true);
      } else if (spread > 8 && spread / screenGesture.distance > 0.05) {
        screenGesture.mode = 'pinch';
        state.panMode = true;
        updateZoomControls();
      } else return;
    }
    if (screenGesture.mode === 'scroll') {
      scrollBy(-(center.x - screenGesture.previousCenter.x), center.y - screenGesture.previousCenter.y);
      screenGesture.previousCenter = center;
    } else transformViewport(screenGesture.zoom * distance / screenGesture.distance, center, screenGesture.anchor);
    return;
  }
  if (screenGesture.id !== event.pointerId) return;
  const dx = local.x - screenGesture.local.x;
  const dy = local.y - screenGesture.local.y;
  if (Math.hypot(dx, dy) > 6) screenGesture.moved = true;
  if (!screenGesture.moved) return;
  if (screenGesture.panning) {
    state.viewportPan = { x: screenGesture.pan.x + dx, y: screenGesture.pan.y + dy };
    updateCursor();
    return;
  }
  const point = pointOnImage(event, false);
  if (!point) return;
  if (!screenGesture.dragging) {
    setPointer(screenGesture.point.x, screenGesture.point.y, true);
    screenGesture.dragging = true;
    if (!state.drag) button('left', true);
  }
  setPointer(point.x, point.y);
});
function finishScreen(event, cancelled = false) {
  if (!screenPointers.has(event.pointerId)) return;
  screenPointers.delete(event.pointerId);
  if (screenGesture?.kind === 'multi') {
    if (!screenPointers.size) {
      flushScroll();
      screenGesture = null;
    }
    return;
  }
  if (screenGesture?.id !== event.pointerId) return;
  const gesture = screenGesture;
  screenGesture = null;
  if (!controlsEnabled()) return;
  const point = pointOnImage(event, false) || gesture.point;
  if (gesture.panning && gesture.moved) return;
  if (gesture.dragging) {
    setPointer(point.x, point.y, true);
    if (!state.drag) button('left', false);
  } else if (!cancelled && !state.drag && !gesture.moved) {
    setPointer(point.x, point.y, true);
    click();
  }
}
$('screen-surface').addEventListener('pointerup', (event) => finishScreen(event));
$('screen-surface').addEventListener('pointercancel', (event) => finishScreen(event, true));
$('screen-surface').addEventListener('lostpointercapture', (event) => finishScreen(event, true));
$('screen-surface').addEventListener('contextmenu', (event) => event.preventDefault());

const padPointers = new Map();
let padGesture = null;
let scrollDelta = { x: 0, y: 0 };
let scrollTimer = null;

function flushScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = null;
  if (scrollDelta.x || scrollDelta.y) enqueue({ action: 'scroll', deltaX: clamp(scrollDelta.x, -1200, 1200), deltaY: clamp(scrollDelta.y, -1200, 1200) });
  scrollDelta = { x: 0, y: 0 };
}
function scrollBy(x, y) {
  scrollDelta.x += x;
  scrollDelta.y += y;
  if (!scrollTimer) scrollTimer = setTimeout(flushScroll, 50);
}
$('touchpad').addEventListener('pointerdown', (event) => {
  if (!controlsEnabled() || event.button !== 0) return;
  event.preventDefault();
  $('touchpad').setPointerCapture(event.pointerId);
  padPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (padPointers.size === 1) padGesture = { start: performance.now(), distance: 0, multi: false };
  if (padPointers.size > 1 && padGesture) padGesture.multi = true;
});
$('touchpad').addEventListener('pointermove', (event) => {
  if (!controlsEnabled() || !padPointers.has(event.pointerId)) return;
  event.preventDefault();
  const previous = padPointers.get(event.pointerId);
  const dx = event.clientX - previous.x;
  const dy = event.clientY - previous.y;
  padPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (padGesture) padGesture.distance += Math.hypot(dx, dy);
  if (padPointers.size > 1) { scrollBy(-dx / padPointers.size, dy / padPointers.size); return; }
  if (padGesture?.multi) return;
  const padWidth = $('touchpad').clientWidth || 300;
  const region = viewedRegion();
  const aspect = clamp(region.width / region.height, 0.5, 4);
  setPointer(state.pointer.x + dx / padWidth * 0.6 * region.width / region.desktopWidth,
    state.pointer.y + dy / padWidth * 0.6 * aspect * region.height / region.desktopHeight);
});
function finishPad(event, cancelled = false) {
  if (!padPointers.has(event.pointerId)) return;
  padPointers.delete(event.pointerId);
  if (padPointers.size) return;
  flushPointer();
  flushScroll();
  if (controlsEnabled() && !cancelled && padGesture && !padGesture.multi && padGesture.distance < 9 && performance.now() - padGesture.start < 450 && !state.drag) click();
  padGesture = null;
}
$('touchpad').addEventListener('pointerup', (event) => finishPad(event));
$('touchpad').addEventListener('pointercancel', (event) => finishPad(event, true));
$('touchpad').addEventListener('lostpointercapture', (event) => finishPad(event, true));
$('touchpad').addEventListener('contextmenu', (event) => event.preventDefault());
$('touchpad').addEventListener('wheel', (event) => {
  if (!controlsEnabled()) return;
  event.preventDefault();
  scrollBy(event.deltaX, -event.deltaY);
}, { passive: false });

function resetGestures() {
  screenGesture = null;
  screenPointers.clear();
  padPointers.clear();
  padGesture = null;
  scrollDelta = { x: 0, y: 0 };
  clearTimeout(scrollTimer);
  scrollTimer = null;
}

$('text-input').addEventListener('input', () => {
  $('text-count').textContent = `${$('text-input').value.length} / 2000`;
  $('send-text').disabled = !controlsEnabled() || !$('text-input').value.length;
});
$('text-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('text-input').value;
  if (!text || !controlsEnabled()) return;
  if (text.length > 2000) { notice('每次最多输入 2000 个字符。', 'warning'); return; }
  if (enqueue({ action: 'text', text })) {
    $('text-input').value = '';
    $('text-count').textContent = '0 / 2000';
    $('send-text').disabled = true;
  }
});
for (const keyButton of document.querySelectorAll('[data-key]')) keyButton.addEventListener('click', () => {
  flushPointer();
  enqueue({ action: 'key', key: keyButton.dataset.key });
});

function isTouchDevice() {
  return navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
}

function releaseLayoutGesture() {
  clearTimeout(state.pointerTimer);
  state.pointerTimer = null;
  state.pendingPointer = null;
  // Discard movement queued in the old coordinate system, then release after
  // the request currently in flight. Screen capture and authorization continue.
  state.epoch++;
  state.queue.length = 0;
  state.drag = false;
  state.held.clear();
  resetGestures();
  if (state.token) queueRelease();
  render();
}

function updateExpandedLayout() {
  const panel = $('screen-panel');
  const viewport = window.visualViewport;
  const portrait = (viewport?.width || innerWidth) < (viewport?.height || innerHeight);
  const rotate = expandedView.active && expandedView.preferLandscape && isTouchDevice() && portrait;
  if (panel.classList.contains('landscape-rotated') !== rotate) releaseLayoutGesture();
  panel.classList.toggle('landscape-rotated', rotate);
  const rotateButton = $('rotate-button');
  if (rotateButton) {
    rotateButton.hidden = !expandedView.active || !isTouchDevice();
    rotateButton.setAttribute('aria-pressed', String(expandedView.preferLandscape));
    const label = expandedView.preferLandscape ? '切换为自动方向' : '切换为横向全屏';
    rotateButton.setAttribute('aria-label', label);
    rotateButton.title = label;
  }
  const hint = $('orientation-hint');
  if (hint) hint.textContent = expandedView.preferLandscape && isTouchDevice() ? '横向全屏' : '全屏 · 自动方向';
  requestAnimationFrame(updateCursor);
}

function unlockOurOrientation() {
  expandedView.lockGeneration++;
  if (!expandedView.ownsOrientationLock) return;
  expandedView.ownsOrientationLock = false;
  try { screen.orientation?.unlock?.(); } catch { /* CSS fallback needs no system orientation access. */ }
}

async function tryLandscapeLock() {
  if (!expandedView.active || !expandedView.preferLandscape || !isTouchDevice()
    || document.fullscreenElement !== $('screen-panel') || typeof screen.orientation?.lock !== 'function') return;
  const generation = ++expandedView.lockGeneration;
  try {
    await screen.orientation.lock('landscape');
    if (generation !== expandedView.lockGeneration || !expandedView.active || !expandedView.preferLandscape) {
      if (!expandedView.active || !expandedView.preferLandscape) {
        try { screen.orientation.unlock(); } catch { /* Ignore an already released lock. */ }
      } else {
        // A more recent entry still wants landscape; do not unlock its lock.
        expandedView.ownsOrientationLock = true;
      }
      return;
    }
    expandedView.ownsOrientationLock = true;
  } catch { /* iPhone Safari and HTTP origins may reject locking; rotate the panel instead. */ }
  updateExpandedLayout();
}

function enterExpanded() {
  const panel = $('screen-panel');
  releaseLayoutGesture();
  expandedView.active = true;
  expandedView.preferLandscape = !isTabletDevice();
  expandedView.nativeEntered = false;
  expandedView.scrollX = window.scrollX;
  expandedView.scrollY = window.scrollY;
  const generation = ++expandedView.generation;
  panel.classList.add('expanded');
  document.body.classList.add('screen-expanded');
  $('expand-button').setAttribute('aria-pressed', 'true');
  $('expand-button').setAttribute('aria-label', '退出全屏');
  $('expand-button').title = '退出全屏';
  updateExpandedLayout();
  // Invoke directly in the click gesture; waiting first loses user activation.
  if (typeof panel.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
    expandedView.transitionUntil = performance.now() + 900;
    try {
      Promise.resolve(panel.requestFullscreen({ navigationUI: 'hide' })).then(async () => {
        if (!expandedView.active || expandedView.generation !== generation) {
          if (!expandedView.active && document.fullscreenElement === panel) await document.exitFullscreen().catch(() => {});
          return;
        }
        if (document.fullscreenElement === panel) expandedView.nativeEntered = true;
        await tryLandscapeLock();
        updateExpandedLayout();
      }).catch(() => { updateExpandedLayout(); });
    } catch { updateExpandedLayout(); }
  }
}

function exitExpanded(exitNative = true) {
  if (!expandedView.active) return;
  releaseLayoutGesture();
  expandedView.active = false;
  expandedView.nativeEntered = false;
  expandedView.generation++;
  const generation = expandedView.generation;
  expandedView.transitionUntil = performance.now() + 500;
  unlockOurOrientation();
  $('screen-panel').classList.remove('expanded', 'landscape-rotated');
  document.body.classList.remove('screen-expanded');
  $('expand-button').setAttribute('aria-pressed', 'false');
  $('expand-button').setAttribute('aria-label', '全屏查看桌面');
  $('expand-button').title = '全屏查看桌面';
  updateExpandedLayout();
  const restoreScroll = () => requestAnimationFrame(() => {
    if (!expandedView.active && expandedView.generation === generation) window.scrollTo(expandedView.scrollX, expandedView.scrollY);
    updateCursor();
  });
  if (exitNative && document.fullscreenElement === $('screen-panel') && document.exitFullscreen) {
    void document.exitFullscreen().catch(() => {}).finally(restoreScroll);
  }
  restoreScroll();
}

$('expand-button').addEventListener('click', () => {
  if (expandedView.active) exitExpanded();
  else enterExpanded();
});
$('rotate-button')?.addEventListener('click', () => {
  releaseLayoutGesture();
  expandedView.preferLandscape = !expandedView.preferLandscape;
  if (!expandedView.preferLandscape) unlockOurOrientation();
  updateExpandedLayout();
  if (expandedView.preferLandscape) void tryLandscapeLock();
});
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === $('screen-panel')) {
    if (!expandedView.active) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    expandedView.nativeEntered = true;
  } else if (expandedView.nativeEntered) {
    exitExpanded(false);
  }
  updateExpandedLayout();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && expandedView.active) exitExpanded();
});
function restoreVisibleConnection() {
  if (document.hidden) return;
  state.destroying = false;
  if (shouldReconnect() && !controlsEnabled()) {
    cancelReconnect();
    void initializeConnection();
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelReconnect(); pause(true); }
  else restoreVisibleConnection();
});
window.addEventListener('blur', () => {
  if (controlsEnabled() && performance.now() >= expandedView.transitionUntil) pause(true);
});
window.addEventListener('focus', restoreVisibleConnection);
window.addEventListener('pagehide', () => { state.destroying = true; pause(true); });
window.addEventListener('pageshow', restoreVisibleConnection);
window.addEventListener('online', restoreVisibleConnection);
window.addEventListener('offline', () => {
  if (state.token && !state.manualPaused && state.connectionWanted) recoverConnection('网络已断开，配对信息保留。');
});
window.addEventListener('resize', updateExpandedLayout);
window.addEventListener('orientationchange', () => {
  releaseLayoutGesture();
  updateExpandedLayout();
});
window.visualViewport?.addEventListener('resize', updateExpandedLayout);
screen.orientation?.addEventListener?.('change', updateExpandedLayout);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateCursor).observe($('screen-surface'));
setInterval(() => {
  if (!controlsEnabled() || document.hidden) return;
  // Renew the host's short held-button watchdog during a deliberate long drag.
  for (const heldButton of state.held) enqueue({ action: 'button', button: heldButton, down: true });
}, 3000);

$('device-name').value = readPersistent(NAME_KEY) || readStored(NAME_KEY) || (isTabletDevice() ? '我的 iPad' : /iPhone|iPod/.test(navigator.userAgent) ? '我的 iPhone' : /Android/.test(navigator.userAgent) ? '我的手机' : '我的浏览器');
$('computer-address').textContent = location.host;
$('host-link').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (state.token) notice(state.autoReconnect ? '已记住这台电脑，正在自动连接…' : '已记住这台电脑。点击「恢复连接」即可继续。');
render();
function initializeConnection() {
  if (state.connectionTask) return state.connectionTask;
  const task = (async () => {
    await checkHost();
    if (state.host && shouldReconnect() && !controlsEnabled()) await resume(true, true);
  })();
  state.connectionTask = task;
  void task.catch(() => {}).finally(() => {
    if (state.connectionTask === task) state.connectionTask = null;
    scheduleReconnect();
  });
  return task;
}
void initializeConnection();
