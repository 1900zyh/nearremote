// Passive local desktop playback benchmark. No desktop images or video are saved.
// Mouse and keyboard are mocked; this cannot send input to the real desktop.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteServer, createPowerShellBridge } from '../server.js';
import { createFFmpegVideoFactory } from '../video-stream.js';

const entry = process.env.PLAYWRIGHT_MODULE;
const targetFps = Number(process.env.VIDEO_TEST_FPS || 60);
assert.ok([30, 60, 90].includes(targetFps), 'VIDEO_TEST_FPS must be 30, 60, or 90');
const { chromium } = await import(entry ? pathToFileURL(path.resolve(entry)).href : 'playwright');
const bridge = createPowerShellBridge();
let desktop;
try { desktop = (await bridge.send('dimensions')).data; } finally { bridge.close(); }
const videoFactory = createFFmpegVideoFactory();
await videoFactory.initialize({ screen: desktop, displays: desktop.displays });
assert.equal(videoFactory.capabilities.available, true, 'A compatible video encoder must be available');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
let server;
const errors = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 25_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch { /* Waiting for initialization. */ }
    await wait(100);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  server = createRemoteServer({
    screen: desktop, videoFactory, pairCode: '654321', deviceName: '本机视频测速',
    addresses: new Set(['127.0.0.1']), onPairRequest() {},
    bridge: { async send() { return { data: true }; }, close() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await until(() => page.locator('#pair-button').isEnabled(), 'service ready');
  if (targetFps !== 60) {
    await page.locator('#display-settings summary').click();
    await page.locator('#fps-select').selectOption(String(targetFps));
    await page.locator('#display-settings summary').click();
  }
  await page.locator('#pair-code').fill('654321');
  await page.locator('#device-name').fill('临时本机测速');
  await page.locator('#pair-button').click();
  await until(() => server.remoteState.pairRequests.size === 1, 'temporary authorization request');
  const request = [...server.remoteState.pairRequests.values()][0];
  server.remoteState.decide(request.requestId, 'approve');
  const measurements = [];
  for (const profile of ['balanced', 'native']) {
    if (profile !== 'balanced') {
      await page.locator('#display-settings summary').click();
      await page.locator('#quality-select').selectOption(profile);
      await page.locator('#display-settings summary').click();
    }
    await until(() => page.locator('#screen-video').evaluate((video) => !video.hidden && video.videoWidth > 0 && !video.paused), 'actual desktop video playback');
    await wait(5500);
    const sample = await page.locator('#screen-video').evaluate((video) => ({
      width: video.videoWidth, height: video.videoHeight, fps: Number.parseFloat(document.getElementById('frame-info').textContent),
      playbackFrames: video.getVideoPlaybackQuality?.().totalVideoFrames,
      bufferedSeconds: video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0,
      mode: document.getElementById('stream-mode').textContent,
    }));
    measurements.push({ profile, ...sample });
    assert.ok(sample.fps >= targetFps * 0.75, `Live ${profile} playback is below the expected range: ${JSON.stringify(sample)}`);
    assert.ok(sample.bufferedSeconds < 2, 'live buffer must remain bounded');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ desktop: { width: desktop.width, height: desktop.height }, targetFps, video: videoFactory.capabilities, measurements }, null, 2));
  console.log('本机采集、编码、HTTP 与浏览器解码实测；不包含手机 Wi-Fi，未保存桌面画面。');
} finally {
  await browser.close();
  await server?.shutdown();
  videoFactory.close?.();
}
