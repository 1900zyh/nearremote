// Mouse synchronization acceptance: native cursor state and desktop are mocked.
// No real desktop is captured and no real mouse/keyboard input is sent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteServer } from '../server.js';

const moduleName = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const calls = [];
const errors = [];
let nativeCursor = { x: 0.1, y: 0.3, visible: true, leftDown: false, rightDown: false, shape: 'arrow' };
let samples = 0;
let server;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 12_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch { /* Waiting for cursor polling. */ }
    await pause(70);
  }
  throw new Error(`Timed out: ${label}`);
}
async function cursorData(page) { return page.locator('#remote-cursor').evaluate((cursor) => ({ ...cursor.dataset, hidden: cursor.hasAttribute('hidden') })); }
async function expectPosition(page, x, y) {
  await until(async () => {
    const cursor = await cursorData(page);
    return !cursor.hidden && Math.abs(Number(cursor.x) - x) < 0.002 && Math.abs(Number(cursor.y) - y) < 0.002;
  }, `computer cursor ${x},${y}`);
  const coordinates = await page.locator('#remote-cursor').evaluate((cursor) => {
    const group = cursor.querySelector('g');
    const matrix = group.transform.baseVal.consolidate().matrix;
    const rect = cursor.getBoundingClientRect();
    const image = document.getElementById('screen-image').getBoundingClientRect();
    const rotated = document.getElementById('screen-panel').classList.contains('landscape-rotated');
    const point = rotated ? { x: rect.right - matrix.f, y: rect.top + matrix.e } : { x: rect.left + matrix.e, y: rect.top + matrix.f };
    return { point, image: { left: image.left, top: image.top, right: image.right, width: image.width, height: image.height }, rotated };
  });
  const expected = coordinates.rotated
    ? { x: coordinates.image.right - coordinates.image.width * y, y: coordinates.image.top + coordinates.image.height * x }
    : { x: coordinates.image.left + coordinates.image.width * x, y: coordinates.image.top + coordinates.image.height * y };
  assert.ok(Math.abs(coordinates.point.x - expected.x) < 2 && Math.abs(coordinates.point.y - expected.y) < 2,
    `Cursor overlay is not aligned with the desktop: ${JSON.stringify({ actual: coordinates.point, expected })}`);
}

try {
  const fixture = await browser.newPage({ viewport: { width: 1600, height: 500 } });
  await fixture.setContent('<body style="margin:0;background:linear-gradient(90deg,#d6e7dc 50%,#bfd5e1 50%);font:34px sans-serif;padding:70px">NearRemote · 鼠标同步验收</body>');
  const jpeg = await fixture.screenshot({ type: 'jpeg' });
  await fixture.close();
  server = createRemoteServer({
    screen: { width: 3840, height: 1200, displays: [
      { index: 0, x: 0, y: 0, width: 1920, height: 1200, primary: true },
      { index: 1, x: 1920, y: 0, width: 1920, height: 1080, primary: false },
    ] },
    addresses: new Set(['127.0.0.1']), deviceName: '鼠标同步测试电脑', pairCode: '654321',
    videoOptions: { available: false }, onPairRequest() {},
    bridge: { async send(action, data) {
      if (action === 'screen') return { data: jpeg.toString('base64') };
      if (action === 'cursor') { samples++; return { data: { ...nativeCursor } }; }
      calls.push({ action, ...data });
      if (['pointer', 'click'].includes(action)) nativeCursor = { ...nativeCursor, x: data.x, y: data.y, visible: true };
      return { data: true };
    }, close() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/cursor`)).status, 401);
  assert.equal(samples, 0, 'Unpaired visitors must not sample the desktop pointer.');
  const context = await browser.newContext({ viewport: { width: 1194, height: 834 }, screen: { width: 1194, height: 834 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await until(() => page.locator('#pair-button').isEnabled(), 'host ready');
  await page.locator('#pair-code').fill('654321');
  await page.locator('#device-name').fill('鼠标测试 iPad');
  await page.locator('#pair-button').click();
  await until(() => server.remoteState.pairRequests.size === 1, 'pair approval');
  server.remoteState.decide([...server.remoteState.pairRequests.keys()][0], 'approve');
  await until(() => page.locator('#screen-image').isVisible(), 'desktop preview');
  await expectPosition(page, 0.1, 0.3);
  const controlCount = calls.filter((call) => ['pointer', 'click', 'button'].includes(call.action)).length;
  nativeCursor = { ...nativeCursor, x: 0.3, y: 0.5, shape: 'text' };
  await expectPosition(page, 0.3, 0.5);
  await until(() => cursorData(page).then((cursor) => cursor.shape === 'text'), 'text cursor shape');
  assert.equal(calls.filter((call) => ['pointer', 'click', 'button'].includes(call.action)).length, controlCount, 'Observing the PC mouse must not send input back to it.');
  nativeCursor = { ...nativeCursor, leftDown: true };
  await until(() => cursorData(page).then((cursor) => cursor.pressed === 'left'), 'real left-button feedback');
  nativeCursor = { ...nativeCursor, leftDown: false, rightDown: true };
  await until(() => cursorData(page).then((cursor) => cursor.pressed === 'right'), 'real right-button feedback');
  nativeCursor = { ...nativeCursor, rightDown: false, visible: false };
  await until(() => cursorData(page).then((cursor) => cursor.hidden), 'Windows hidden cursor');
  nativeCursor = { ...nativeCursor, visible: true, x: 0.8, y: 0.5, shape: 'hand' };
  await pause(250);
  assert.equal((await cursorData(page)).hidden, true, 'A pointer on the other monitor must not be clamped to the selected monitor edge.');
  await page.locator('#display-select').selectOption('display:1');
  await expectPosition(page, 0.8, 0.5);
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  await expectPosition(page, 0.8, 0.5);
  await page.evaluate(() => { document.getElementById('screen-panel').requestFullscreen = undefined; });
  await page.locator('#expand-button').click();
  await expectPosition(page, 0.8, 0.5);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.locator('#rotate-button').click();
  await until(() => page.locator('#screen-panel').evaluate((panel) => panel.classList.contains('landscape-rotated')), 'rotated pointer view');
  nativeCursor = { ...nativeCursor, x: 0.72, y: 0.38 };
  await expectPosition(page, 0.72, 0.38);
  await page.locator('#rotate-button').click();
  await page.setViewportSize({ width: 1194, height: 834 });
  nativeCursor = { ...nativeCursor, x: 0.8, y: 0.5 };
  await expectPosition(page, 0.8, 0.5);
  await page.locator('#display-settings summary').click();
  await page.locator('#show-cursor').uncheck();
  await pause(180);
  const hiddenSamples = samples;
  await pause(350);
  assert.equal(samples, hiddenSamples, 'Disabling the cursor stops its polling.');
  assert.equal((await cursorData(page)).hidden, true);
  await page.locator('#show-cursor').check();
  await page.locator('#display-settings summary').click();
  await expectPosition(page, 0.8, 0.5);
  // Local control remains immediate, then the real computer sample confirms it.
  const tapPoint = await page.locator('#screen-image').evaluate((image) => {
    const rect = image.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.73, y: rect.top + rect.height * 0.42 };
  });
  await page.touchscreen.tap(tapPoint.x, tapPoint.y);
  await until(() => calls.some((call) => call.action === 'click' && Math.abs(call.x - 0.73) < 0.002), 'mobile cursor click feedback');
  await expectPosition(page, nativeCursor.x, nativeCursor.y);
  await until(() => cursorData(page).then((cursor) => cursor.source === 'computer'), 'computer confirms the local cursor prediction');
  await page.locator('#pause-button').click();
  await pause(180);
  const pausedSamples = samples;
  await pause(350);
  assert.equal(samples, pausedSamples, 'Paused control does not keep sampling the mouse.');
  await page.locator('#resume-button').click();
  await expectPosition(page, nativeCursor.x, nativeCursor.y);
  if (process.env.TEST_OUTPUT_DIR) {
    await fs.mkdir(process.env.TEST_OUTPUT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.TEST_OUTPUT_DIR, 'computer-cursor-ipad.png') });
  }
  await server.remoteState.revokeAll();
  await until(() => page.locator('#pair-button').isVisible(), 'revocation clears cursor authorization');
  await pause(180);
  const revokedSamples = samples;
  await pause(350);
  assert.equal(samples, revokedSamples, 'Revocation stops cursor sampling.');
  assert.deepEqual(errors, []);
  console.log('Passed: real PC cursor movement/shape/buttons without sending input, hidden/off-monitor cursor, selected monitor/zoom/fullscreen mapping, display toggle, pause/resume, authorization and revocation cleanup.');
  await context.close();
} finally {
  await browser.close();
  await server?.shutdown();
}
