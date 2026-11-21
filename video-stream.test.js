import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFFmpegVideoFactory, ffmpegArguments, videoCodecsByFps, videoDimensions, videoEncodingProfile, VIDEO_PROFILES } from './video-stream.js';
import { createRemoteServer } from './server.js';

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let attempt = 0; attempt < 50; attempt++) { if (check()) return; await wait(); }
  throw new Error(`Timed out: ${label}`);
}

test('video encoder arguments are fixed, preserve desktop proportions, and enable low-delay fragmented H264', () => {
  assert.deepEqual(videoDimensions({ width: 3840, height: 1200 }, VIDEO_PROFILES.balanced), { width: 1920, height: 600 });
  const args = ffmpegArguments({ profileId: 'native', fps: 60, screen: { width: 3840, height: 1200 } });
  assert.ok(args.includes('h264_nvenc'));
  assert.ok(args.includes('60'));
  assert.ok(args.includes('scale=3840:1200:flags=fast_bilinear,format=nv12'));
  assert.ok(args.includes('+frag_every_frame+empty_moov+default_base_moof+omit_tfhd_offset'));
  assert.equal(args.at(-1), 'pipe:1');
  assert.throws(() => ffmpegArguments({ profileId: 'shell command', fps: 60 }), /Invalid/);
  assert.throws(() => ffmpegArguments({ profileId: 'balanced', fps: 1000 }), /Invalid/);
});

test('90 fps keeps the requested capture rate and increases bitrate without reducing desktop quality', () => {
  const displays = [
    { index: 0, x: 0, y: 0, width: 1920, height: 1200 },
    { index: 1, x: 1920, y: 0, width: 1920, height: 1080 },
  ];
  for (const [profileId, bitrate] of [['balanced', '18M'], ['sharp', '30M'], ['native', '54M']]) {
    const args = ffmpegArguments({ profileId, fps: 90, screen: { width: 3840, height: 1200 }, encoder: 'h264_mf', capture: 'ddagrab', displays });
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.equal((graph.match(/framerate=90:draw_mouse=0/g) || []).length, 2);
    assert.ok(graph.includes('fps=90,format=nv12[out]'));
    assert.equal(args[args.indexOf('-b:v') + 1], bitrate);
    assert.equal(args[args.indexOf('-maxrate') + 1], bitrate);
    assert.equal(args[args.indexOf('-bufsize') + 1], '3M');
    assert.equal(args[args.indexOf('-g') + 1], '45');
    assert.equal(args[args.indexOf('-fps_mode') + 1], 'passthrough');
  }
});

test('90 fps H264 levels follow actual encoded dimensions and advertise matching browser codecs', () => {
  const wideDesktop = { width: 3840, height: 1200 };
  assert.equal(videoEncodingProfile('balanced', 90, wideDesktop).level, '4.2');
  assert.equal(videoEncodingProfile('native', 90, wideDesktop).level, '5.2');
  assert.equal(videoEncodingProfile('balanced', 90, { width: 1920, height: 1080 }).level, '5.1');
  assert.equal(videoEncodingProfile('sharp', 90, { width: 3840, height: 2160 }).level, '5.2');
  assert.equal(videoEncodingProfile('native', 90, { width: 3840, height: 2160 }).level, '6.0');
  const codecs = videoCodecsByFps(wideDesktop);
  assert.equal(codecs['90'].balanced, 'avc1.42C02A');
  assert.equal(codecs['90'].native, 'avc1.42C034');
  assert.equal(videoCodecsByFps({ width: 3840, height: 2160 })['90'].native, 'avc1.42C03C');
  const args = ffmpegArguments({ profileId: 'native', fps: 90, screen: { width: 3840, height: 2160 }, encoder: 'h264_mf' });
  assert.equal(args[args.indexOf('-level:v') + 1], '60');
  assert.equal(args[args.indexOf('-profile:v') + 1], '66');
});

test('FFmpeg initialization reports its actual avcC codec and stop terminates its local process', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = 0;
  child.kill = () => { killed++; };
  const factory = createFFmpegVideoFactory({ available: true, executable: 'mock.exe', spawnProcess: () => child });
  const stream = factory({ profileId: 'balanced', fps: 60, screen: { width: 1920, height: 1080 } });
  // An avcC box can cross stdout chunk boundaries.
  const initialization = Buffer.from([0, 0, 0, 12, 97, 118, 99, 67, 1, 66, 192, 42]);
  child.stdout.write(initialization.subarray(0, 7));
  child.stdout.write(initialization.subarray(7));
  const metadata = await stream.ready;
  assert.equal(metadata.codec, 'avc1.42C02A');
  assert.equal(metadata.width, 1920);
  const chunk = stream.stdout.read();
  assert.deepEqual(chunk, initialization);
  stream.stop();
  stream.stop();
  assert.equal(killed, 1);
});

test('DXGI capture preserves unequal monitor placement and downsizes before CPU composition', () => {
  const displays = [
    { index: 0, x: 0, y: 0, width: 1920, height: 1200 },
    { index: 1, x: 1920, y: 0, width: 1920, height: 1080 },
  ];
  const args = ffmpegArguments({ profileId: 'balanced', fps: 60, screen: { width: 3840, height: 1200 }, encoder: 'h264_mf', capture: 'ddagrab', displays });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(graph.includes('output_idx=0:framerate=60:draw_mouse=0'));
  assert.ok(graph.includes('scale=960:600:flags=fast_bilinear[d0]'));
  assert.ok(graph.includes('scale=960:540:flags=fast_bilinear[d1]'));
  assert.ok(graph.includes('layout=0_0|960_0:fill=black'));
  assert.ok(graph.includes('pad=1920:600:0:0:black,fps=60,format=nv12[out]'));
  assert.equal(args.includes('-zerolatency'), false, 'NVENC flags must not be sent to MediaFoundation');
  assert.ok(args.includes('ld_vbr'));
  assert.equal(args[args.indexOf('-profile:v') + 1], '66', 'MediaFoundation expects numeric H264 profile identifiers');
  assert.equal(args[args.indexOf('-level:v') + 1], '42');
  assert.equal(args.includes('gdigrab'), false);
  assert.throws(() => ffmpegArguments({ capture: 'ddagrab', displays: [{ ...displays[0], index: '0;bad' }] }), /Invalid desktop layout/);
  assert.throws(() => ffmpegArguments({ capture: 'shell command' }), /Invalid video settings/);
});

test('automatic encoder selection probes black frames and falls back without changing drivers', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nearremote-probe-'));
  const filename = path.join(directory, 'ffmpeg.exe');
  await fs.writeFile(filename, 'test');
  t.after(async () => { await fs.unlink(filename); await fs.rmdir(directory); });
  const attempted = [];
  const factory = createFFmpegVideoFactory({
    executable: filename,
    spawnProcess(_executable, args, options) {
      assert.equal(options.windowsHide, true);
      assert.ok(args.includes('color=c=black:s=1280x720:r=90'), 'probe must not read the real desktop');
      const encoder = args[args.indexOf('-c:v') + 1];
      attempted.push(encoder);
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => child.emit('close', encoder === 'h264_mf' ? 0 : 1));
      return child;
    },
  });
  assert.equal(factory.capabilities.available, false, 'file presence alone does not imply a working encoder');
  const result = await factory.initialize({ displays: [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }] });
  if (process.platform === 'win32') {
    assert.deepEqual(attempted, ['h264_nvenc', 'h264_mf']);
    assert.equal(result.encoder, 'h264_mf');
    assert.equal(result.capture, 'ddagrab');
    assert.equal(result.available, true);
    await factory.ready;
    assert.equal(attempted.length, 2, 'probing is shared by repeated initialization requests');
  } else assert.equal(result.available, false);
  factory.close();
});

test('closing video setup cancels outstanding encoder probes and prevents later activation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nearremote-probe-'));
  const filename = path.join(directory, 'ffmpeg.exe');
  await fs.writeFile(filename, 'test');
  t.after(async () => { await fs.unlink(filename); await fs.rmdir(directory); });
  let killed = 0;
  const factory = createFFmpegVideoFactory({ executable: filename, spawnProcess() {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = () => { killed++; };
    return child;
  } });
  const ready = factory.ready;
  factory.close();
  const result = await ready;
  assert.equal(result.available, false);
  assert.equal(result.initializing, false);
  assert.equal(killed, process.platform === 'win32' ? 1 : 0);
});

async function setup(t, options = {}) {
  const sources = [];
  const factory = ({ profileId, fps, screen }) => {
    const stdout = new PassThrough();
    const source = { stdout, profileId, fps, screen, stopped: 0,
      ready: Promise.resolve({ codec: VIDEO_PROFILES[profileId].codec, ...videoDimensions(screen, VIDEO_PROFILES[profileId]) }),
      stop() { if (!this.stopped) this.stopped++; stdout.destroy(); },
    };
    sources.push(source);
    return source;
  };
  factory.available = true;
  const server = createRemoteServer({
    addresses: new Set(['127.0.0.1']), screen: { width: 3840, height: 1200 },
    pairCode: '654321', onPairRequest() {},
    bridge: { send: async () => ({ data: true }), close() {} }, videoFactory: factory, ...options,
  });
  let base;
  for (;;) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    try { await fetch(`${base}/api/status`); break; }
    catch (error) {
      if (error.cause?.message !== 'bad port') throw error;
      await new Promise((resolve) => server.close(resolve));
    }
  }
  t.after(() => server.shutdown());
  const authorize = async (deviceId) => {
    const request = await fetch(`${base}/api/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '654321', name: '测试设备', deviceId }),
    }).then((response) => response.json());
    assert.equal(server.remoteState.decide(request.requestId, 'approve'), true);
    return fetch(`${base}/api/pair/${request.requestId}`).then((response) => response.json()).then((response) => response.token);
  };
  const open = (token, query = '') => fetch(`${base}/api/video.mp4${query}`, { headers: { authorization: `Bearer ${token}` } });
  return { base, server, sources, authorize, open };
}

test('video requires authorization, strictly validates profiles and frame rates, and exposes capability without credentials', async (t) => {
  const { base, sources, authorize, open } = await setup(t);
  const status = await fetch(`${base}/api/status`).then((response) => response.json());
  assert.equal(status.video.available, true);
  assert.equal(status.video.maxFps, 90);
  assert.equal(await fetch(`${base}/api/video.mp4`).then((response) => response.status), 401);
  const token = await authorize('video-browser-id-one');
  for (const query of ['?profile=unknown', '?profile=balanced&profile=native', '?fps=61', '?fps=91', '?fps=90&fps=60', '?fps=60&fps=30', '?fps=60.0', '?fps=90.0', '?profile=']) {
    assert.equal((await open(token, query)).status, 400, query);
  }
  assert.equal(sources.length, 0);
  const response = await open(token, '?profile=sharp&fps=60');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('x-video-codec'), VIDEO_PROFILES.sharp.codec);
  assert.equal(response.headers.get('x-video-width'), '2560');
  assert.equal(response.headers.get('x-video-height'), '800');
  await response.body.cancel();
  await until(() => sources[0].stopped, 'canceling HTTP response stops capture');
});

test('90 fps video requests reach the encoder unchanged and retain the existing stream lifecycle', async (t) => {
  const { base, sources, authorize, open } = await setup(t);
  const status = await fetch(`${base}/api/status`).then((response) => response.json());
  assert.equal(status.video.codecsByFps['90'].balanced, 'avc1.42C02A');
  assert.equal(status.video.codecsByFps['90'].native, 'avc1.42C034');
  const token = await authorize('video-browser-id-90fps');
  const response = await open(token, '?profile=native&fps=90');
  assert.equal(response.status, 200);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].fps, 90);
  assert.equal(sources[0].profileId, 'native');
  assert.equal(response.headers.get('x-video-fps'), '90');
  await response.body.cancel();
  await until(() => sources[0].stopped, 'canceling a 90fps stream stops its encoder');
});

test('restarting one video stops its previous encoder and limits total active viewers', async (t) => {
  const { sources, authorize, open } = await setup(t);
  const a = await authorize('video-browser-id-one');
  const b = await authorize('video-browser-id-two');
  const c = await authorize('video-browser-id-three');
  const first = await open(a);
  const firstClosed = first.body.getReader().read().catch(() => {});
  const second = await open(a, '?fps=30');
  await until(() => sources[0].stopped, 'replaced encoder stopped');
  await firstClosed;
  const third = await open(b);
  assert.equal((await open(c)).status, 429);
  assert.equal(sources.length, 3);
  await second.body.cancel();
  await third.body.cancel();
  await until(() => sources.every((source) => source.stopped), 'all canceled encoders stopped');
});

test('revocation and shutdown end ongoing video immediately and do not retain encoder resources', async (t) => {
  const { server, sources, authorize, open } = await setup(t);
  const a = await authorize('video-browser-id-one');
  const b = await authorize('video-browser-id-two');
  const first = await open(a);
  const firstClosed = first.body.getReader().read().catch(() => {});
  await server.remoteState.revokeToken(a);
  await until(() => sources[0].stopped, 'revoked video stopped');
  await firstClosed;
  assert.equal((await open(a)).status, 401);
  const second = await open(b);
  const secondClosed = second.body.getReader().read().catch(() => {});
  await server.shutdown();
  await secondClosed;
  assert.equal(sources[1].stopped, 1);
});

test('failed or unavailable video startup returns an error without leaking an active slot', async (t) => {
  const factory = () => { throw new Error('No encoder'); };
  factory.available = true;
  const { sources, authorize, open } = await setup(t, { videoFactory: factory });
  const token = await authorize('video-browser-id-one');
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await open(token)).status, 503);
  assert.equal(sources.length, 0);
});

test('unbounded video output is cut off instead of buffering stale desktop data', async (t) => {
  const { sources, authorize, open } = await setup(t);
  const token = await authorize('video-browser-id-one');
  const response = await open(token);
  const read = response.body.getReader().read().catch(() => {});
  sources[0].stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
  await until(() => sources[0].stopped, 'oversized encoder chunk stopped');
  await read;
});
