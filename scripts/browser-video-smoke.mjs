// Streams an animated test pattern; never captures or controls the real desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRemoteServer } from '../server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = process.env.REMOTE_FFMPEG || path.join(root, 'tools', 'ffmpeg.exe');
await fs.access(ffmpeg);
const playwright = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(playwright ? pathToFileURL(path.resolve(playwright)).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const output = path.resolve(root, '..', 'test-results', 'remote-control');
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nearremote-video-test-'));
const errors = [];
const tabletMode = process.env.TABLET_TEST === '1';
const targetFps = Number(process.env.VIDEO_TEST_FPS || 60);
assert.ok([30, 60, 90].includes(targetFps), 'VIDEO_TEST_FPS must be 30, 60, or 90');
const sourceSize = tabletMode ? { width: 1920, height: 600 } : { width: 1280, height: 720 };
const desktopSize = tabletMode ? { width: 3840, height: 1200, displays: [
  { index: 0, x: 0, y: 0, width: 1920, height: 1200, primary: true },
  { index: 1, x: 1920, y: 0, width: 1920, height: 1080, primary: false },
] } : sourceSize;
const calls = [];
const encoders = new Set();
const encodedFrameRates = [];
let started = 0;
let stopped = 0;
let frames = 0;
let server;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, name, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch { /* Waiting for the media pipeline. */ }
    await pause(80);
  }
  throw new Error(`Timed out: ${name}`);
}

const videoFactory = ({ fps = 60 }) => {
  encodedFrameRates.push(fps);
  const child = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${sourceSize.width}x${sourceSize.height}:rate=${fps}`,
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'baseline', '-level:v', '4.2', '-pix_fmt', 'yuv420p',
    '-g', '30', '-bf', '0', '-b:v', '6M',
    '-movflags', '+frag_every_frame+empty_moov+default_base_moof+omit_tfhd_offset',
    '-flush_packets', '1', '-f', 'mp4', 'pipe:1',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  started++;
  encoders.add(child);
  child.stderr.on('data', () => {});
  child.on('error', () => {});
  child.once('exit', () => encoders.delete(child));
  let closed = false;
  return {
    stdout: child.stdout, codec: 'avc1.42C02A', ...sourceSize,
    stop() { if (!closed) { closed = true; stopped++; child.kill(); } },
  };
};
videoFactory.available = true;
videoFactory.capabilities = { available: true, endpoint: '/api/video.mp4', codec: 'avc1.42C02A', maxFps: 90, capture: 'synthetic' };

try {
  // A valid JPEG for the one-frame authorization check before video resumes.
  const sourcePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await sourcePage.setContent('<body style="margin:0;background:#dcebdc;font:40px sans-serif;padding:50px">NearRemote · 视频测试画面</body>');
  const jpeg = await sourcePage.screenshot({ type: 'jpeg' });
  await sourcePage.close();
  server = createRemoteServer({
    screen: desktopSize, deviceName: '60 帧视频测试电脑',
    addresses: new Set(['127.0.0.1']), pairCode: '654321',
    bridge: { async send(action, data) { if (action === 'screen') { frames++; return { data: jpeg.toString('base64') }; } calls.push({ action, ...data }); return { data: true }; }, close() {} },
    videoFactory, onPairRequest() {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: tabletMode ? { width: 1194, height: 834 } : { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    ...(tabletMode ? { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' } : {}) });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && /Content Security Policy|Refused|Uncaught/.test(message.text())) errors.push(message.text()); });
  page.on('request', (request) => { assert.ok(!new URL(request.url()).searchParams.has('token')); });
  await page.goto(base);
  await until(() => page.locator('#pair-button').isEnabled(), 'host status');
  assert.equal(await page.locator('#fps-select').inputValue(), '60');
  if (targetFps !== 60) {
    await page.locator('#display-settings summary').click();
    await page.locator('#fps-select').selectOption(String(targetFps));
    await page.locator('#display-settings summary').click();
  }
  await page.locator('#pair-code').fill('654321');
  await page.locator('#device-name').fill('视频测试手机');
  await page.locator('#pair-button').click();
  await until(() => server.remoteState.pairRequests.size === 1, 'pairing');
  const request = [...server.remoteState.pairRequests.values()][0];
  assert.equal(server.remoteState.decide(request.requestId, 'approve'), true);
  await until(() => page.locator('#screen-video').evaluate((video) => !video.hidden && video.videoWidth > 0 && !video.paused), 'H.264 media playback');
  assert.equal(encodedFrameRates[0], targetFps, 'the chosen target must reach the video encoder without being capped to 60');
  await until(() => page.locator('#frame-info').textContent().then((text) => parseFloat(text) >= targetFps * 0.75), 'actual rendered frame rate near the requested target');
  await pause(3500);
  const metrics = await page.locator('#screen-video').evaluate((video) => ({ width: video.videoWidth, height: video.videoHeight,
    fps: document.getElementById('frame-info').textContent, playback: video.getVideoPlaybackQuality?.().totalVideoFrames,
    droppedFrames: video.getVideoPlaybackQuality?.().droppedVideoFrames,
    bufferedSeconds: video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0 }));
  assert.ok(metrics.bufferedSeconds < 2, 'live video buffer should not grow without bound');
  await page.screenshot({ path: path.join(output, `phone-${targetFps}fps-video.png`), fullPage: true });
  assert.equal(frames, 0, 'continuous video should not fall back to repeated JPEG requests');

  const surface = page.locator('#screen-surface');
  const box = await surface.boundingBox();
  await surface.tap({ position: { x: box.width / 2, y: box.height / 2 } });
  await until(() => calls.some((call) => call.action === 'click'), 'video desktop click');
  const click = calls.find((call) => call.action === 'click');
  assert.ok(Math.abs(click.x - (tabletMode ? 0.25 : 0.5)) < 0.03 && Math.abs(click.y - 0.5) < 0.03);
  if (tabletMode) {
    const encoderCount = started;
    await page.locator('#display-select').selectOption('display:1');
    await page.locator('#zoom-in').click();
    await page.locator('#zoom-in').click();
    await pause(1000);
    assert.equal(started, encoderCount, 'screen selection and zoom must preserve the running video encoder');
    assert.equal(await page.locator('#screen-video').isVisible(), true);
    assert.ok(Number.parseFloat(await page.locator('#frame-info').textContent()) > 40, 'tablet crop and zoom should retain accelerated playback');
    await page.locator('#zoom-reset').click();
    await page.locator('#display-select').selectOption('auto');
  }
  await page.locator('#pause-button').click();
  await until(() => stopped >= 1 && encoders.size === 0, 'pause stops the video encoder');
  await page.locator('#resume-button').click();
  await until(() => page.locator('#screen-video').evaluate((video) => !video.hidden && video.videoWidth > 0 && !video.paused), 'video resumes');
  const settings = page.locator('#display-settings');
  await settings.locator('summary').click();
  await page.locator('#transport-select').selectOption('jpeg');
  await until(() => page.locator('#screen-image').isVisible(), 'explicit compatibility mode');
  await until(() => encoders.size === 0, 'compatibility mode releases encoder');
  await page.locator('#transport-select').selectOption('auto');
  await page.locator('#fps-select').selectOption(String(targetFps));
  await until(() => page.locator('#screen-video').evaluate((video) => !video.hidden && video.videoWidth > 0 && !video.paused), 'automatic video mode returns');
  await server.remoteState.revokeAll();
  await until(() => encoders.size === 0, 'revocation terminates video');
  await until(() => page.locator('#pair-button').isVisible(), 'revoked controller returns to pairing');
  assert.deepEqual(errors, [], 'no browser or CSP errors');
  console.log(JSON.stringify({ result: 'passed', requestedFps: targetFps, encodedFrameRates, actualBrowserVideo: metrics, encodersStarted: started, encodersStopped: stopped, checks: 'H.264 playback, actual FPS, bounded live buffer, input mapping, pause/resume, mode switches, revocation cleanup' }, null, 2));
  await context.close();
} finally {
  await browser.close();
  await server?.shutdown();
  for (const child of encoders) child.kill();
  await fs.rmdir(temporary).catch(() => {});
}
