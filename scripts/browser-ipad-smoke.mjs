// Tablet viewport, cropped desktop, zoom and multi-touch acceptance checks.
// The desktop is synthetic and the input bridge only records commands.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRemoteServer } from '../server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleName = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const output = process.env.TEST_OUTPUT_DIR ? path.resolve(process.env.TEST_OUTPUT_DIR) : path.join(root, 'test-results', 'remote-control');
await fs.mkdir(output, { recursive: true });
const desktop = { width: 3840, height: 1200, displays: [
  { index: 0, x: 0, y: 0, width: 1920, height: 1200, primary: true },
  { index: 1, x: 1920, y: 0, width: 1920, height: 1080, primary: false },
] };
const inputs = [];
const errors = [];
let captures = 0;
let server;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch { /* Waiting for a frame or gesture. */ }
    await sleep(70);
  }
  throw new Error(`Timed out: ${description}`);
}
async function noOverflow(page, description) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(size.content <= size.viewport, `${description}: ${JSON.stringify(size)}`);
}
async function mediaPoint(page, x, y) {
  return page.locator('#screen-image').evaluate((image, point) => {
    const rect = image.getBoundingClientRect();
    const rotated = document.getElementById('screen-panel').classList.contains('landscape-rotated');
    let localWidth = rotated ? rect.height : rect.width;
    let localHeight = rotated ? rect.width : rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (getComputedStyle(image).objectFit === 'contain') {
      const scale = Math.min(localWidth / image.naturalWidth, localHeight / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      offsetX = (localWidth - width) / 2;
      offsetY = (localHeight - height) / 2;
      localWidth = width;
      localHeight = height;
    }
    if (rotated) return { x: rect.right - offsetY - localHeight * point.y, y: rect.top + offsetX + localWidth * point.x };
    return { x: rect.left + offsetX + localWidth * point.x, y: rect.top + offsetY + localHeight * point.y };
  }, { x, y });
}
async function clickAt(page, x, y) {
  const before = inputs.length;
  const point = await mediaPoint(page, x, y);
  await page.touchscreen.tap(point.x, point.y);
  await until(() => inputs.slice(before).some((input) => input.action === 'click'), 'cropped desktop click');
  const click = inputs.slice(before).find((input) => input.action === 'click');
  assert.ok(Math.abs(click.x - x) < 0.002 && Math.abs(click.y - y) < 0.002, `Incorrect desktop mapping: ${JSON.stringify({ x, y, click })}`);
}
async function gesture(page, frames) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: frames[0] });
    for (const points of frames.slice(1)) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
      await sleep(30);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}
async function surfaceCenter(page) {
  const rect = await page.locator('#screen-surface').boundingBox();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

try {
  const fixture = await browser.newPage({ viewport: { width: 3840, height: 1200 } });
  await fixture.setContent('<canvas width="3840" height="1200"></canvas>');
  const encoded = await fixture.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#dce7dd'; ctx.fillRect(0, 0, 1920, 1200);
    ctx.fillStyle = '#fffefa'; ctx.fillRect(115, 115, 1690, 960);
    ctx.fillStyle = '#315347'; ctx.font = '50px sans-serif'; ctx.fillText('工作空间 · 主屏', 180, 210);
    ctx.fillStyle = '#789286'; ctx.font = '29px sans-serif'; ctx.fillText('在 iPad 上专注一块屏幕，让文字和操作更清楚。', 180, 285);
    for (let index = 0; index < 4; index++) {
      ctx.fillStyle = '#eef4eb'; ctx.fillRect(180, 355 + index * 150, 1500, 110);
      ctx.fillStyle = '#52705c'; ctx.font = '33px sans-serif'; ctx.fillText(['今日计划', '项目笔记', '灵感收藏', '最近文件'][index], 220, 425 + index * 150);
    }
    const gradient = ctx.createLinearGradient(1920, 0, 3840, 1080);
    gradient.addColorStop(0, '#cbdce6'); gradient.addColorStop(1, '#6f9ba8');
    ctx.fillStyle = gradient; ctx.fillRect(1920, 0, 1920, 1080);
    ctx.fillStyle = '#fff'; ctx.font = '56px sans-serif'; ctx.fillText('副屏 · 屏幕 2', 2110, 230);
    ctx.fillStyle = '#10271d'; ctx.fillRect(1920, 1080, 1920, 120);
    return canvas.toDataURL('image/jpeg', 0.86).split(',')[1];
  });
  await fixture.close();
  server = createRemoteServer({
    screen: desktop, addresses: new Set(['127.0.0.1']), pairCode: '654321', deviceName: '平板适配测试电脑', videoOptions: { available: false }, onPairRequest() {},
    bridge: { async send(action, data) { if (action === 'screen') { captures++; return { data: encoded }; } inputs.push({ action, ...data }); return { data: true }; }, close() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1194, height: 834 }, screen: { width: 1194, height: 834 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && /Content Security Policy|Refused|Uncaught/.test(message.text())) errors.push(message.text()); });
  await page.goto(base);
  await until(() => page.locator('#pair-button').isEnabled(), 'host ready');
  await page.locator('#pair-code').fill('654321');
  await page.locator('#device-name').fill('我的 iPad');
  await page.locator('#pair-button').click();
  await until(() => server.remoteState.pairRequests.size === 1, 'tablet pairing');
  server.remoteState.decide([...server.remoteState.pairRequests.keys()][0], 'approve');
  await until(() => page.locator('#screen-image').evaluate((image) => !image.hidden && image.naturalWidth > 0), 'tablet picture');
  assert.equal(await page.locator('#display-select').inputValue(), 'auto');
  assert.equal(await page.locator('body').evaluate((body) => body.classList.contains('tablet-device')), true);
  assert.equal(await page.locator('#screen-surface').evaluate((surface) => surface.classList.contains('media-cropped')), true, 'tablet defaults to the primary monitor');
  await noOverflow(page, 'iPad landscape');
  await page.screenshot({ path: path.join(output, 'ipad-landscape.png'), fullPage: true });
  await clickAt(page, 0.1, 0.3);

  await page.evaluate(() => { document.getElementById('screen-panel').requestFullscreen = undefined; });
  await page.locator('#expand-button').click();
  await until(() => page.locator('#screen-panel').evaluate((panel) => panel.classList.contains('expanded')), 'tablet fullscreen');
  await page.screenshot({ path: path.join(output, 'ipad-fullscreen-primary.png') });
  await page.locator('#display-select').selectOption('display:1');
  await clickAt(page, 0.9, 0.63);
  await page.locator('#display-select').selectOption('all');
  await clickAt(page, 0.8, 0.7);
  await page.locator('#display-select').selectOption('display:0');

  // Two parallel fingers scroll the remote page without selecting any text.
  let center = await surfaceCenter(page);
  const beforeScroll = inputs.length;
  await gesture(page, [
    [{ id: 1, x: center.x - 45, y: center.y + 40 }, { id: 2, x: center.x + 45, y: center.y + 40 }],
    [{ id: 1, x: center.x - 45, y: center.y + 20 }, { id: 2, x: center.x + 45, y: center.y + 20 }],
    [{ id: 1, x: center.x - 45, y: center.y - 5 }, { id: 2, x: center.x + 45, y: center.y - 5 }],
  ]);
  await until(() => inputs.slice(beforeScroll).some((input) => input.action === 'scroll'), 'two-finger screen scrolling');
  assert.ok(inputs.slice(beforeScroll).find((input) => input.action === 'scroll').deltaY < 0);
  assert.ok(!inputs.slice(beforeScroll).some((input) => input.action === 'click' || (input.action === 'button' && input.down)), 'two-finger scroll must not select remote content');

  // Pinch changes local magnification and does not generate scroll or mouse down.
  const beforePinch = inputs.length;
  await gesture(page, [
    [{ id: 1, x: center.x - 40, y: center.y }, { id: 2, x: center.x + 40, y: center.y }],
    [{ id: 1, x: center.x - 60, y: center.y }, { id: 2, x: center.x + 60, y: center.y }],
    [{ id: 1, x: center.x - 80, y: center.y }, { id: 2, x: center.x + 80, y: center.y }],
  ]);
  await until(() => page.locator('#zoom-value').textContent().then((text) => Number.parseInt(text) >= 170), 'pinch zoom');
  assert.ok(!inputs.slice(beforePinch).some((input) => input.action === 'scroll' || input.action === 'click' || (input.action === 'button' && input.down)), 'pinch must remain a local viewing gesture');
  await clickAt(page, 0.28, 0.53);
  const beforePan = inputs.length;
  center = await surfaceCenter(page);
  const beforePosition = await page.locator('#screen-image').boundingBox();
  await gesture(page, [[{ id: 1, x: center.x, y: center.y }], [{ id: 1, x: center.x + 45, y: center.y + 30 }]]);
  const afterPosition = await page.locator('#screen-image').boundingBox();
  assert.ok(Math.abs(afterPosition.x - beforePosition.x) > 5 || Math.abs(afterPosition.y - beforePosition.y) > 5, 'one finger pans the magnified desktop');
  assert.ok(!inputs.slice(beforePan).some((input) => input.action === 'pointer' || input.action === 'click' || (input.action === 'button' && input.down)), 'panning must not move or drag the remote mouse');
  await page.screenshot({ path: path.join(output, 'ipad-fullscreen-zoom.png') });
  await page.locator('#zoom-reset').click();
  assert.equal((await page.locator('#zoom-value').textContent()).trim(), '100%');
  await clickAt(page, 0.1, 0.3);

  for (const size of [{ width: 768, height: 1024 }, { width: 507, height: 768 }, { width: 820, height: 1180 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await sleep(80);
    await noOverflow(page, `iPad viewport ${size.width}x${size.height}`);
    assert.equal(await page.locator('#screen-panel').evaluate((panel) => panel.classList.contains('landscape-rotated')), false, 'iPad follows physical orientation by default');
    const exit = await page.locator('#expand-button').boundingBox();
    assert.ok(exit.x >= 0 && exit.y >= 0 && exit.x + exit.width <= size.width && exit.y + exit.height <= size.height);
  }
  await page.screenshot({ path: path.join(output, 'ipad-fullscreen-portrait.png') });
  await page.locator('#expand-button').click();
  await page.setViewportSize({ width: 507, height: 768 });
  await noOverflow(page, 'iPad Split View');
  assert.equal(await page.locator('#display-select').inputValue(), 'display:0');
  await page.screenshot({ path: path.join(output, 'ipad-split-view.png'), fullPage: true });
  assert.deepEqual(errors, [], 'browser and CSP errors');
  console.log(JSON.stringify({ result: 'passed', screenshots: output, checks: 'iPad primary/all/secondary view, global input mapping, fullscreen orientations, Split View, pinch zoom, local pan, two-finger remote scrolling without selection', captures }, null, 2));
  await context.close();
} finally {
  await browser.close();
  await server?.shutdown();
}
