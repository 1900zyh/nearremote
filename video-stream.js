import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_ENCODERS = new Set(['h264_nvenc', 'libx264', 'h264_mf']);
const VIDEO_CAPTURES = new Set(['gdigrab', 'ddagrab']);
export const VIDEO_FRAME_RATES = Object.freeze([30, 60, 90]);
export const VIDEO_PROFILES = Object.freeze({
  balanced: Object.freeze({ maxWidth: 1920, maxHeight: 1080, bitrate: '12M', level: '4.2', codec: 'avc1.42C02A' }),
  sharp: Object.freeze({ maxWidth: 2560, maxHeight: 1440, bitrate: '20M', level: '5.1', codec: 'avc1.42C033' }),
  native: Object.freeze({ maxWidth: 3840, maxHeight: 2160, bitrate: '36M', level: '5.2', codec: 'avc1.42C034' }),
});

export function videoDimensions(screen, profile) {
  const width = Math.max(2, Math.round(Number(screen?.width) || 1920));
  const height = Math.max(2, Math.round(Number(screen?.height) || 1080));
  const scale = Math.min(1, profile.maxWidth / width, profile.maxHeight / height);
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}

// H.264 levels constrain both frame size and macroblocks per second. Advertise
// the level this desktop actually needs instead of treating every 90 fps stream
// as 4K, which would unnecessarily exclude capable mobile decoders.
const H264_LEVELS = Object.freeze([
  { level: '4.2', maxFrameMacroblocks: 8704, maxMacroblocksPerSecond: 522240 },
  { level: '5.1', maxFrameMacroblocks: 36864, maxMacroblocksPerSecond: 983040 },
  { level: '5.2', maxFrameMacroblocks: 36864, maxMacroblocksPerSecond: 2073600 },
  { level: '6.0', maxFrameMacroblocks: 139264, maxMacroblocksPerSecond: 4177920 },
]);

export function videoEncodingProfile(profileId = 'balanced', fps = 60, screen) {
  const base = VIDEO_PROFILES[profileId];
  if (!base || !VIDEO_FRAME_RATES.includes(fps)) throw new Error('Invalid video settings');
  const dimensions = videoDimensions(screen, base);
  const frameMacroblocks = Math.ceil(dimensions.width / 16) * Math.ceil(dimensions.height / 16);
  const selected = H264_LEVELS.find((entry) => Number(entry.level) >= Number(base.level)
    && entry.maxFrameMacroblocks >= frameMacroblocks && entry.maxMacroblocksPerSecond >= frameMacroblocks * fps);
  if (!selected) throw new Error('Video dimensions exceed supported H264 levels');
  const levelId = Math.round(Number(selected.level) * 10).toString(16).toUpperCase().padStart(2, '0');
  return { ...base, level: selected.level, codec: `avc1.42C0${levelId}`,
    bitrate: fps === 90 ? `${Number.parseFloat(base.bitrate) * 1.5}M` : base.bitrate,
    bufferSize: fps === 90 ? '3M' : '2M',
  };
}

export function videoCodecsByFps(screen) {
  return Object.fromEntries(VIDEO_FRAME_RATES.map((fps) => [String(fps),
    Object.fromEntries(Object.keys(VIDEO_PROFILES).map((id) => [id, videoEncodingProfile(id, fps, screen).codec])),
  ]));
}

function encoderArguments(encoder, profile, fps) {
  const options = encoder === 'h264_nvenc'
    ? ['-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-rc', 'cbr', '-forced-idr', '1']
    : encoder === 'libx264' ? ['-preset', 'ultrafast', '-tune', 'zerolatency']
      : ['-hw_encoding', '1', '-rate_control', 'ld_vbr', '-scenario', 'display_remoting'];
  return ['-c:v', encoder, ...options, '-fps_mode', 'passthrough',
    '-profile:v', encoder === 'h264_mf' ? '66' : 'baseline',
    '-level:v', encoder === 'h264_mf' ? String(Math.round(Number(profile.level) * 10)) : profile.level, '-bf', '0',
    '-b:v', profile.bitrate, '-maxrate', profile.bitrate, '-bufsize', profile.bufferSize || '2M',
    '-g', String(Math.max(15, fps / 2)), '-flags', '+low_delay'];
}

function normalizedDisplays(displays) {
  if (!Array.isArray(displays) || !displays.length || displays.length > 4) throw new Error('Invalid desktop layout');
  const result = displays.map((item, ordinal) => {
    const display = { index: item.index ?? ordinal, x: item.x, y: item.y, width: item.width, height: item.height };
    if (Object.values(display).some((value) => !Number.isSafeInteger(value))
      || display.index < 0 || display.index > 15 || Math.abs(display.x) > 16384 || Math.abs(display.y) > 16384
      || display.width < 2 || display.height < 2 || display.width > 16384 || display.height > 16384) throw new Error('Invalid desktop layout');
    return display;
  });
  if (new Set(result.map((item) => item.index)).size !== result.length) throw new Error('Invalid desktop layout');
  return result;
}

export function ffmpegArguments({ profileId = 'balanced', fps = 60, screen, encoder = 'h264_nvenc', capture = 'gdigrab', displays } = {}) {
  if (!Object.hasOwn(VIDEO_PROFILES, profileId) || !VIDEO_FRAME_RATES.includes(fps) || !VIDEO_ENCODERS.has(encoder) || !VIDEO_CAPTURES.has(capture)) throw new Error('Invalid video settings');
  const profile = videoEncodingProfile(profileId, fps, screen);
  const dimensions = videoDimensions(screen, profile);
  const input = ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0', '-i', 'desktop'];
  const filtering = ['-vf', `scale=${dimensions.width}:${dimensions.height}:flags=fast_bilinear,format=nv12`];
  if (capture === 'ddagrab') {
    const outputs = normalizedDisplays(displays);
    const minX = Math.min(...outputs.map((item) => item.x));
    const minY = Math.min(...outputs.map((item) => item.y));
    const desktopWidth = Math.max(...outputs.map((item) => item.x + item.width)) - minX;
    const desktopHeight = Math.max(...outputs.map((item) => item.y + item.height)) - minY;
    if (desktopWidth > 16384 || desktopHeight > 16384) throw new Error('Invalid desktop layout');
    const ratio = Math.min(dimensions.width / desktopWidth, dimensions.height / desktopHeight);
    const scaled = outputs.map((item) => ({
      width: Math.max(2, Math.floor(item.width * ratio / 2) * 2),
      height: Math.max(2, Math.floor(item.height * ratio / 2) * 2),
      x: Math.floor((item.x - minX) * ratio / 2) * 2,
      y: Math.floor((item.y - minY) * ratio / 2) * 2,
    }));
    const chain = outputs.map((item, index) => `ddagrab=output_idx=${item.index}:framerate=${fps}:draw_mouse=0,hwdownload,format=bgra,setpts=PTS-STARTPTS,scale=${scaled[index].width}:${scaled[index].height}:flags=fast_bilinear[d${index}]`);
    if (outputs.length === 1) {
      chain.push(`[d0]fps=${fps},format=nv12[out]`);
    } else {
      chain.push(`${outputs.map((_item, index) => `[d${index}]`).join('')}xstack=inputs=${outputs.length}:layout=${scaled.map((item) => `${item.x}_${item.y}`).join('|')}:fill=black[desktop]`);
      chain.push(`[desktop]pad=${dimensions.width}:${dimensions.height}:0:0:black,fps=${fps},format=nv12[out]`);
    }
    input.splice(0);
    filtering.splice(0, filtering.length, '-filter_complex', chain.join(';'), '-map', '[out]');
  }
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    ...input, '-an', ...filtering,
    ...encoderArguments(encoder, profile, fps),
    '-movflags', '+frag_every_frame+empty_moov+default_base_moof+omit_tfhd_offset',
    '-flush_packets', '1', '-f', 'mp4', 'pipe:1',
  ];
}

function codecFromInitialization(buffer) {
  const marker = buffer.indexOf(Buffer.from('avcC'));
  if (marker < 4 || marker + 8 > buffer.length || buffer[marker + 4] !== 1) return null;
  return `avc1.${buffer.subarray(marker + 5, marker + 8).toString('hex').toUpperCase()}`;
}

/** A local, optional video encoder. It never receives client-supplied commands. */
export function createFFmpegVideoFactory(options = {}) {
  const executable = options.executable || process.env.REMOTE_FFMPEG || path.join(ROOT, 'tools', 'ffmpeg.exe');
  const requestedEncoder = options.encoder || process.env.REMOTE_VIDEO_ENCODER;
  if (requestedEncoder && !VIDEO_ENCODERS.has(requestedEncoder)) throw new Error('REMOTE_VIDEO_ENCODER must be h264_nvenc, libx264, or h264_mf');
  const requestedCapture = options.capture || process.env.REMOTE_VIDEO_CAPTURE;
  if (requestedCapture && !VIDEO_CAPTURES.has(requestedCapture)) throw new Error('REMOTE_VIDEO_CAPTURE must be gdigrab or ddagrab');
  const spawnProcess = options.spawnProcess || spawn;
  const installed = options.available ?? (process.platform === 'win32' && fs.existsSync(executable));
  const explicitAvailability = Object.hasOwn(options, 'available');
  let encoder = requestedEncoder || 'h264_nvenc';
  let capture = requestedCapture || 'gdigrab';
  let displays = options.displays;
  let desktopScreen = options.screen;
  let initialization;
  let closed = false;
  const probes = new Map();
  const factory = ({ profileId = 'balanced', fps = 60, screen } = {}) => {
    if (closed || !factory.capabilities.available) throw Object.assign(new Error(factory.capabilities.reason || '高速视频组件尚未就绪，请使用截图预览。'), { status: 503 });
    const args = ffmpegArguments({ profileId, fps, screen, encoder, capture, displays });
    const dimensions = videoDimensions(screen, VIDEO_PROFILES[profileId]);
    const child = spawnProcess(executable, args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = new PassThrough({ highWaterMark: 128 * 1024 });
    // Consumers attach their own error listener after `ready` resolves.
    output.on('error', () => {});
    let stopped = false;
    let initialized = false;
    let stderr = '';
    let initialization = Buffer.alloc(0);
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const fail = (message) => {
      const error = Object.assign(new Error(message), { status: 503 });
      if (!initialized) rejectReady(error);
      output.destroy(error);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(startupTimer);
      child.stdout.unpipe(output);
      child.stdout.destroy();
      output.destroy();
      child.kill();
      if (!initialized) rejectReady(Object.assign(new Error('视频采集已停止'), { status: 503 }));
    };
    const startupTimer = setTimeout(() => { fail('视频采集启动超时，请检查显卡编码器与桌面状态。'); stop(); }, 10_000);
    startupTimer.unref();
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.once('error', (error) => { fail(`无法启动视频采集：${error.message}`); stop(); });
    child.once('exit', (code) => {
      clearTimeout(startupTimer);
      if (stopped) return;
      if (!initialized || code) fail(`视频采集已退出 (${code ?? 'unknown'})${stderr ? `：${stderr.trim()}` : ''}`);
      else output.end();
      stopped = true;
    });
    const inspect = (chunk) => {
      initialization = Buffer.concat([initialization, chunk]);
      if (initialization.length > 1024 * 1024) { fail('视频初始化数据无效'); stop(); return; }
      const codec = codecFromInitialization(initialization);
      if (!codec) return;
      initialized = true;
      clearTimeout(startupTimer);
      child.stdout.pause();
      child.stdout.removeListener('data', inspect);
      output.write(initialization);
      initialization = null;
      child.stdout.pipe(output);
      resolveReady({ codec, ...dimensions, fps });
    };
    child.stdout.on('data', inspect);
    return { stdout: output, ready, stop, ...dimensions, fps, codec: videoEncodingProfile(profileId, fps, screen).codec };
  };
  factory.available = Boolean(installed && explicitAvailability);
  factory.capabilities = {
    available: factory.available, initializing: false, endpoint: '/api/video.mp4', codec: VIDEO_PROFILES.balanced.codec,
    codecs: videoCodecsByFps(desktopScreen)['60'], codecsByFps: videoCodecsByFps(desktopScreen),
    maxFps: 90, capture, encoder,
  };
  const probeEncoder = (candidate) => new Promise((resolve) => {
    if (closed) return resolve(false);
    const probeArgs = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=90',
      '-frames:v', '4', '-an', '-vf', 'format=nv12',
      ...encoderArguments(candidate, videoEncodingProfile('balanced', 90, { width: 1280, height: 720 }), 90), '-f', 'null', '-',
    ];
    let child;
    try { child = spawnProcess(executable, probeArgs, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { resolve(false); return; }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probes.delete(child);
      resolve(ok);
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 3500);
    timer.unref();
    probes.set(child, () => { child.kill(); finish(false); });
    child.stderr?.on('data', () => {});
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0 && !closed));
  });
  factory.initialize = ({ displays: nextDisplays, screen: nextScreen } = {}) => {
    if (nextScreen) desktopScreen = nextScreen;
    const codecsByFps = videoCodecsByFps(desktopScreen);
    factory.capabilities.codecsByFps = codecsByFps;
    factory.capabilities.codecs = codecsByFps['60'];
    factory.capabilities.codec = codecsByFps['60'].balanced;
    if (initialization) return initialization;
    if (nextDisplays) displays = nextDisplays;
    if (displays) {
      try { displays = normalizedDisplays(displays); capture = requestedCapture || 'ddagrab'; }
      catch { displays = undefined; capture = 'gdigrab'; }
    }
    factory.capabilities.capture = capture;
    if (!installed || explicitAvailability) {
      factory.capabilities.reason = installed ? undefined : '未找到视频组件，请准备 FFmpeg 后重启服务。';
      initialization = Promise.resolve(factory.capabilities);
      return initialization;
    }
    factory.capabilities.initializing = true;
    initialization = (async () => {
      for (const candidate of requestedEncoder ? [requestedEncoder] : ['h264_nvenc', 'h264_mf', 'libx264']) {
        if (closed) break;
        if (await probeEncoder(candidate)) {
          encoder = candidate;
          factory.available = true;
          Object.assign(factory.capabilities, { available: true, encoder, initializing: false, reason: undefined });
          return factory.capabilities;
        }
      }
      Object.assign(factory.capabilities, { available: false, initializing: false, reason: '当前视频编码器不可用，已保留兼容截图。' });
      return factory.capabilities;
    })();
    return initialization;
  };
  Object.defineProperty(factory, 'ready', { get: () => factory.initialize() });
  factory.close = () => {
    closed = true;
    factory.available = false;
    factory.capabilities.available = false;
    for (const cancel of [...probes.values()]) cancel();
  };
  return factory;
}
