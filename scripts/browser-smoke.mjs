// Real browser acceptance checks with a synthetic desktop and a mock input bridge.
// No screen contents or input from the user's actual desktop are involved.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRemoteServer } from '../server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright');
const output = process.env.TEST_OUTPUT_DIR ? path.resolve(process.env.TEST_OUTPUT_DIR) : path.join(root, 'test-results', 'remote-control');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const contexts = [];
const errors = [];
const inputs = [];
const captures = [];
let captureInFlight = 0;
let maxCaptureInFlight = 0;
const trustDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nearremote-browser-'));
const trustStorePath = path.join(trustDirectory, 'trusted-devices.json');
let releases = 0;
let server;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, name, timeout = 12_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch { /* The view may still be updating. */ }
    await sleep(80);
  }
  throw new Error(`Timed out: ${name}`);
}

async function noOverflow(page, name) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(size.content <= size.viewport, `${name} horizontally overflows: ${JSON.stringify(size)}`);
}

async function desktopPoint(page, x, y) {
  return page.locator('#screen-surface').evaluate((surface, target) => {
    const rect = surface.getBoundingClientRect();
    const image = document.getElementById('screen-image');
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const imageWidth = image.naturalWidth * scale;
    const imageHeight = image.naturalHeight * scale;
    const localX = (width - imageWidth) / 2 + imageWidth * target.x;
    const localY = (height - imageHeight) / 2 + imageHeight * target.y;
    if (document.getElementById('screen-panel').classList.contains('landscape-rotated')) {
      return { x: rect.right - localY / height * rect.width, y: rect.top + localX / width * rect.height };
    }
    return { x: rect.left + localX / width * rect.width, y: rect.top + localY / height * rect.height };
  }, { x, y });
}

async function assertFullscreenBounds(page, name) {
  const size = await page.locator('#screen-panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const exit = document.getElementById('expand-button').getBoundingClientRect();
    return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight,
      exit: { x: exit.left, y: exit.top, right: exit.right, bottom: exit.bottom } };
  });
  assert.ok(size.x >= -1 && size.y >= -1 && size.right <= size.width + 1 && size.bottom <= size.height + 1, `${name} panel is cropped: ${JSON.stringify(size)}`);
  assert.ok(size.exit.x >= 0 && size.exit.y >= 0 && size.exit.right <= size.width && size.exit.bottom <= size.height, `${name} exit button is cropped: ${JSON.stringify(size)}`);
}

async function openPage(base, route, options) {
  const context = await browser.newContext(options);
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused|Uncaught/.test(message.text())) errors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    assert.ok(!url.searchParams.has('token'), 'bearer token must never be placed in a URL');
  });
  await page.goto(`${base}${route}`);
  return page;
}

async function syntheticDesktop() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="zh"><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#c2d5d0;font:20px 'Microsoft YaHei',sans-serif;color:#203a35}
    .desktop{height:900px;padding:45px 90px;background:linear-gradient(145deg,#e4e4d8,#9bbdb1)}.bar{display:flex;justify-content:space-between;font-size:16px;color:#35544b}
    .window{margin-top:60px;background:#fbfcf9;border-radius:22px;box-shadow:0 30px 80px #204e3838;overflow:hidden}
    .chrome{background:#eef1eb;padding:20px 24px;display:flex;gap:10px;font-size:15px;align-items:center}.dot{width:12px;height:12px;border-radius:100%;background:#ced9d2}.title{margin-left:20px;color:#728078}
    .content{display:grid;grid-template-columns:230px 1fr;min-height:570px}.side{padding:36px 25px;border-right:1px solid #e5eae5;color:#809187}.side strong{display:block;margin-bottom:35px;color:#183f35}.selected{padding:14px 18px;border-radius:9px;background:#e1eee6;color:#245e49}.side p{padding-left:18px;font-size:16px}
    .main{padding:40px 50px}.eyebrow{color:#81958a;font-size:13px;letter-spacing:3px}h1{font-size:38px;margin:10px 0 13px}p{color:#8b9a91;font-size:17px}.tasks{display:flex;gap:18px;margin-top:32px}.task{padding:25px;background:#f1f5ee;border-radius:13px;flex:1}.task small{color:#8e9e92}.task h2{font-size:25px;margin:16px 0}.line{height:11px;background:#e1e9df;border-radius:10px;margin:15px 0;max-width:90%}.green{height:7px;border-radius:8px;background:#6e9c7b;width:70%;margin-top:25px}.bottom{display:flex;justify-content:space-between;margin:35px 0;color:#779181;font-size:15px}
    </style><div class="desktop"><div class="bar"><strong>NearRemote · 测试桌面</strong><span>星期五　14:30</span></div><div class="window"><div class="chrome"><i class="dot"></i><i class="dot"></i><i class="dot"></i><span class="title">工作空间 / 今日计划</span></div><div class="content"><aside class="side"><strong>我的工作空间</strong><div class="selected">今日计划</div><p>项目笔记</p><p>灵感收藏</p><p>最近文件</p></aside><main class="main"><div class="eyebrow">A GOOD DAY TO MAKE THINGS</div><h1>让今天，井井有条。</h1><p>专注手边的事，一点点完成它。</p><div class="tasks"><div class="task"><small>进行中</small><h2>完善设计方案</h2><div class="line"></div><div class="line"></div><div class="green"></div></div><div class="task"><small>待处理</small><h2>整理项目笔记</h2><div class="line"></div><div class="line"></div><div class="green"></div></div></div><div class="bottom"><span>3 个任务已完成</span><span>今天也是有收获的一天　↗</span></div></main></div></div></div>`);
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 85 });
  await page.close();
  return jpeg;
}

try {
  const jpeg = await syntheticDesktop();
  const bridge = {
    async send(action, data) {
      if (action === 'screen') {
        captureInFlight++;
        maxCaptureInFlight = Math.max(maxCaptureInFlight, captureInFlight);
        captures.push({ at: Date.now(), ...data });
        try {
          await sleep(12);
          return { data: jpeg.toString('base64') };
        } finally { captureInFlight--; }
      }
      if (action === 'dimensions') return { data: { width: 1600, height: 900 } };
      inputs.push({ action, ...data });
      return { data: true };
    }, close() {},
  };
  const serverOptions = { bridge, videoOptions: { available: false }, trustStorePath, screen: { width: 1600, height: 900 }, deviceName: '我的 Windows 电脑', addresses: new Set(['127.0.0.1']), pairCode: '654321', onPairRequest() {} };
  server = createRemoteServer(serverOptions);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const host = await openPage(base, '/host', { viewport: { width: 1440, height: 1000 } });
  await until(() => host.locator('#host-code').textContent().then((value) => value === '654321'), 'host code');
  await host.screenshot({ path: path.join(output, 'host-desktop.png'), fullPage: true });
  await noOverflow(host, 'host desktop');
  const phone = await openPage(base, '/', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await until(() => phone.locator('#computer-name').textContent().then((value) => value === '我的 Windows 电脑'), 'phone status');
  await phone.screenshot({ path: path.join(output, 'phone-pairing.png'), fullPage: true });
  await noOverflow(phone, 'phone pairing');
  await phone.locator('#pair-code').fill('654321');
  const deviceName = '我的 iPhone <script>window.injected=true</script>';
  await phone.locator('#device-name').fill(deviceName.slice(0, 32));
  await phone.locator('#pair-button').click();
  await until(() => host.locator('button[data-decision="approve"]').count().then(Boolean), 'pending approval');
  assert.equal(await phone.locator('#screen-image').isVisible(), false, 'no desktop before approval');
  assert.equal(await host.evaluate(() => window.injected), undefined, 'device name must not execute');
  await host.locator('button[data-decision="approve"]').click();
  await until(() => phone.locator('#screen-image').evaluate((image) => !image.hidden && image.naturalWidth > 0), 'authenticated desktop preview');
  await until(() => phone.locator('#left-button').isEnabled(), 'controller enabled');
  await phone.screenshot({ path: path.join(output, 'phone-connected.png'), fullPage: true });
  await host.screenshot({ path: path.join(output, 'host-paired.png'), fullPage: true });
  await noOverflow(phone, 'connected phone');
  assert.equal(await phone.locator('#quality-select').inputValue(), 'balanced');
  assert.equal(await phone.locator('#fps-select').inputValue(), '60');
  await phone.locator('#display-settings summary').click();
  await phone.locator('#quality-select').selectOption('native');
  await phone.locator('#fps-select').selectOption('30');
  await until(() => captures.some((capture) => capture.maxWidth === 3840 && capture.quality === 95), 'native resolution and compression reach the capture bridge');
  await until(() => phone.locator('#frame-info').textContent().then((value) => Number.parseFloat(value) > 5), 'actual frame rate exceeds former 2.5fps cap');
  await phone.screenshot({ path: path.join(output, 'phone-quality-settings.png'), fullPage: true });
  await phone.locator('#quality-select').selectOption('sharp');
  await until(() => captures.some((capture) => capture.maxWidth === 2560 && capture.quality === 92), 'super clear profile');
  await phone.locator('#quality-select').selectOption('balanced');
  await phone.locator('#fps-select').selectOption('20');
  await phone.locator('#display-settings summary').click();
  assert.equal(maxCaptureInFlight, 1, 'rapid quality changes must not accumulate concurrent captures');
  assert.ok(await phone.evaluate(() => localStorage.getItem('nearremote.session')), 'approved authorization must survive closing the tab');
  const samePhone = await phone.context().newPage();
  await samePhone.goto(base);
  await until(() => samePhone.locator('#left-button').isEnabled(), 'remembered phone automatically reconnects in a new tab');
  assert.equal(server.remoteState.tokens.size, 1, 'automatic reconnection must not duplicate the device');
  await samePhone.close();
  await phone.bringToFront();
  if (await phone.locator('#resume-button').isVisible()) await phone.locator('#resume-button').click();
  await until(() => phone.locator('#left-button').isEnabled(), 'return from second tab');

  const surface = phone.locator('#screen-surface');
  const rect = await surface.boundingBox();
  await surface.tap({ position: { x: rect.width / 2, y: rect.height / 2 } });
  await until(() => inputs.some((event) => event.action === 'click' && event.button === 'left'), 'absolute screen tap');
  const click = inputs.find((event) => event.action === 'click');
  assert.ok(Math.abs(click.x - 0.5) < 0.08 && Math.abs(click.y - 0.5) < 0.08, 'letterbox screen coordinates must map to desktop center');

  // iPhone Safari may reject native fullscreen and orientation locks. Exercise
  // the rotated fallback with asymmetric points: center taps hide axis errors.
  await phone.evaluate(() => {
    const panel = document.getElementById('screen-panel');
    Object.defineProperty(panel, 'requestFullscreen', { configurable: true, value: () => Promise.reject(new DOMException('Fullscreen not available', 'NotSupportedError')) });
    Object.defineProperty(panel, 'webkitRequestFullscreen', { configurable: true, value: undefined });
  });
  await phone.locator('#expand-button').scrollIntoViewIfNeeded();
  const scrollBeforeExpand = await phone.evaluate(() => scrollY);
  await phone.locator('#expand-button').click();
  await until(() => phone.locator('#screen-panel').evaluate((panel) => panel.classList.contains('landscape-rotated')), 'portrait fullscreen landscape fallback');
  await assertFullscreenBounds(phone, 'portrait fullscreen');
  await phone.locator('#display-settings summary').click();
  const rotatedMenu = await phone.locator('.display-menu').boundingBox();
  const rotatedViewport = phone.viewportSize();
  assert.ok(rotatedMenu.x >= -1 && rotatedMenu.y >= -1 && rotatedMenu.x + rotatedMenu.width <= rotatedViewport.width + 1 && rotatedMenu.y + rotatedMenu.height <= rotatedViewport.height + 1, 'quality menu must fit in rotated fullscreen');
  await phone.locator('#quality-select').selectOption('native');
  await phone.locator('#display-settings summary').click();
  for (const target of [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.7 }]) {
    const start = inputs.length;
    const point = await desktopPoint(phone, target.x, target.y);
    await phone.touchscreen.tap(point.x, point.y);
    await until(() => inputs.slice(start).some((event) => event.action === 'click'), 'rotated off-center tap');
    const event = inputs.slice(start).find((entry) => entry.action === 'click');
    assert.ok(Math.abs(event.x - target.x) < 0.015 && Math.abs(event.y - target.y) < 0.015, `rotated tap is mapped incorrectly: ${JSON.stringify({ target, event })}`);
  }
  const rotatedTouch = await phone.context().newCDPSession(phone);
  const pointsAt = async (left, right, y) => {
    const first = await desktopPoint(phone, left, y);
    const second = await desktopPoint(phone, right, y);
    return [{ ...first, id: 1 }, { ...second, id: 2 }];
  };
  const beforeRotatedScroll = inputs.length;
  await rotatedTouch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: await pointsAt(0.45, 0.55, 0.55) });
  await rotatedTouch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: await pointsAt(0.45, 0.55, 0.48) });
  await rotatedTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(() => inputs.slice(beforeRotatedScroll).some((event) => event.action === 'scroll'), 'rotated screen two-finger scroll');
  assert.ok(inputs.slice(beforeRotatedScroll).find((event) => event.action === 'scroll').deltaY < 0);
  assert.ok(!inputs.slice(beforeRotatedScroll).some((event) => event.action === 'click' || (event.action === 'button' && event.down)), 'two fingers must not drag-select in phone fullscreen');
  const beforeRotatedPinch = inputs.length;
  await rotatedTouch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: await pointsAt(0.45, 0.55, 0.5) });
  await rotatedTouch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: await pointsAt(0.4, 0.6, 0.5) });
  await rotatedTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await rotatedTouch.detach();
  await until(() => phone.locator('#zoom-value').textContent().then((text) => Number.parseInt(text) >= 170), 'rotated phone pinch zoom');
  assert.ok(!inputs.slice(beforeRotatedPinch).some((event) => event.action === 'scroll' || event.action === 'click' || (event.action === 'button' && event.down)), 'pinching must not select or scroll remotely');
  await phone.locator('#zoom-reset').click();
  const dragStart = await desktopPoint(phone, 0.25, 0.35);
  const dragEnd = await desktopPoint(phone, 0.7, 0.6);
  const dragEvents = inputs.length;
  await phone.mouse.move(dragStart.x, dragStart.y);
  await phone.mouse.down();
  await phone.mouse.move(dragEnd.x, dragEnd.y, { steps: 5 });
  await phone.mouse.up();
  await until(() => inputs.slice(dragEvents).some((event) => event.action === 'button' && event.down === false), 'rotated drag releases');
  const finalPointer = inputs.slice(dragEvents).filter((event) => event.action === 'pointer').at(-1);
  assert.ok(Math.abs(finalPointer.x - 0.7) < 0.015 && Math.abs(finalPointer.y - 0.6) < 0.015, 'rotated drag should use desktop coordinates');
  await phone.screenshot({ path: path.join(output, 'phone-fullscreen-rotated.png') });
  await phone.locator('#rotate-button').click();
  await until(() => phone.locator('#screen-panel').evaluate((panel) => !panel.classList.contains('landscape-rotated')), 'automatic portrait mode');
  await phone.locator('#rotate-button').click();
  await until(() => phone.locator('#screen-panel').evaluate((panel) => panel.classList.contains('landscape-rotated')), 'restore forced landscape');
  await phone.setViewportSize({ width: 844, height: 390 });
  await until(() => phone.locator('#screen-panel').evaluate((panel) => !panel.classList.contains('landscape-rotated')), 'physical landscape avoids double rotation');
  await assertFullscreenBounds(phone, 'physical landscape fullscreen');
  await phone.screenshot({ path: path.join(output, 'phone-fullscreen-landscape.png') });
  await phone.setViewportSize({ width: 390, height: 690 });
  await until(() => phone.locator('#screen-panel').evaluate((panel) => panel.classList.contains('landscape-rotated')), 'return portrait after address-bar resize');
  await assertFullscreenBounds(phone, 'shorter portrait viewport');
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.locator('#expand-button').click();
  await until(() => phone.locator('#screen-panel').evaluate((panel) => !panel.classList.contains('expanded')), 'exit expanded view');
  assert.ok(Math.abs(await phone.evaluate(() => scrollY) - scrollBeforeExpand) < 2, 'exiting fullscreen restores the page position');
  assert.equal(await phone.locator('#left-button').isEnabled(), true, 'fullscreen transitions should retain control authorization');
  await phone.locator('#touchpad').scrollIntoViewIfNeeded();
  const pad = await phone.locator('#touchpad').boundingBox();
  const beforePad = inputs.length;
  await phone.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
  await phone.mouse.down();
  await phone.mouse.move(pad.x + pad.width / 2 + 35, pad.y + pad.height / 2 + 10, { steps: 4 });
  await phone.mouse.up();
  await until(() => inputs.slice(beforePad).some((event) => event.action === 'pointer'), 'relative touchpad pointer');
  assert.ok(!inputs.slice(beforePad).some((event) => event.action === 'click'), 'a moved pointer must not become a tap');
  const touch = await phone.context().newCDPSession(phone);
  const fingers = (y) => [{ x: pad.x + 100, y, id: 1 }, { x: pad.x + 160, y, id: 2 }];
  const startY = pad.y + pad.height / 2 + 20;
  const beforeScroll = inputs.length;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(startY) });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(startY - 30) });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await until(() => inputs.slice(beforeScroll).some((event) => event.action === 'scroll'), 'two-finger scroll');
  assert.ok(inputs.slice(beforeScroll).find((event) => event.action === 'scroll').deltaY < 0, 'swiping up should scroll the Windows page down');
  await phone.locator('#right-button').click();
  await until(() => inputs.some((event) => event.action === 'click' && event.button === 'right'), 'right click');
  const text = '你好，电脑！\n手机浏览器输入测试';
  await phone.locator('#text-input').fill(text);
  await phone.locator('#send-text').click();
  await until(() => inputs.some((event) => event.action === 'text' && event.text === text), 'Unicode text');
  await phone.locator('[data-key="ENTER"]').click();
  await until(() => inputs.some((event) => event.action === 'key' && event.key === 'ENTER'), 'keyboard key');

  phone.on('request', (request) => { if (request.url().endsWith('/api/release')) releases++; });
  await phone.locator('#drag-button').click();
  await until(() => inputs.some((event) => event.action === 'button' && event.down), 'drag hold');
  await phone.locator('#pause-button').click();
  await until(() => phone.locator('#resume-button').isVisible(), 'pause control');
  await until(() => releases > 0, 'pause releases held buttons');
  await phone.locator('#resume-button').click();
  await until(() => phone.locator('#left-button').isEnabled(), 'resume control');

  // A full host restart must not require the trusted iPhone to enter a code.
  await phone.locator('#pause-button').click();
  const restartPort = server.address().port;
  await server.shutdown();
  server = createRemoteServer(serverOptions);
  await new Promise((resolve) => server.listen(restartPort, '127.0.0.1', resolve));
  await phone.reload();
  await until(() => phone.locator('#left-button').isEnabled(), 'automatic connection after host restart');
  assert.equal(server.remoteState.pairRequests.size, 0, 'a remembered phone should not send another pairing request');
  assert.equal(server.remoteState.tokens.size, 1);
  await host.reload();
  await until(() => host.locator('button[data-session-id]').count().then((count) => count === 1), 'one remembered device after restart');

  const wide = await openPage(base, '/', { viewport: { width: 1440, height: 1000 } });
  await wide.screenshot({ path: path.join(output, 'controller-desktop.png'), fullPage: true });
  await noOverflow(wide, 'desktop controller');
  await wide.locator('#expand-button').click();
  await until(() => wide.locator('#screen-panel').evaluate((panel) => panel.classList.contains('expanded')), 'desktop expanded mode');
  const enteredNative = await wide.evaluate(() => Boolean(document.fullscreenElement));
  if (enteredNative) {
    await wide.evaluate(() => document.exitFullscreen());
    await until(() => wide.locator('#screen-panel').evaluate((panel) => !panel.classList.contains('expanded')), 'native fullscreen exit cleans up layout');
  } else await wide.locator('#expand-button').click();
  await phone.setViewportSize({ width: 320, height: 740 });
  await noOverflow(phone, '320px phone');
  await phone.screenshot({ path: path.join(output, 'phone-small.png'), fullPage: true });
  await phone.setViewportSize({ width: 844, height: 390 });
  await noOverflow(phone, 'landscape phone');
  await phone.setViewportSize({ width: 390, height: 844 });

  await phone.reload();
  await until(() => phone.locator('#left-button').isEnabled(), 'remembered authorization automatically restores after reload');
  assert.equal(await phone.locator('#quality-select').inputValue(), 'native', 'quality preference should survive reload and host restart');
  assert.equal(maxCaptureInFlight, 1);

  await phone.locator('#connection-panel').evaluate((details) => { details.open = true; });
  await phone.locator('#forget-device-button').click();
  await until(() => server.remoteState.tokens.size === 0, 'disconnect revokes token');
  await until(() => phone.locator('#pair-button').isVisible(), 'return to pairing');
  assert.equal(await phone.evaluate(() => localStorage.getItem('nearremote.session')), null, 'explicit revocation forgets saved authorization');

  // Browser-facing error paths should permit a clean retry and must not grant authority.
  await phone.locator('#pair-code').fill('000000');
  await phone.locator('#pair-button').click();
  await until(() => phone.locator('#connection-status').getAttribute('data-state').then((state) => state === 'error'), 'invalid code error');
  assert.equal(server.remoteState.tokens.size, 0);
  await phone.locator('#pair-code').fill('654321');
  await phone.locator('#pair-button').click();
  await until(() => phone.locator('#cancel-pair-button').isVisible(), 'cancel pairing waiting');
  await phone.locator('#cancel-pair-button').click();
  await until(() => [...server.remoteState.pairRequests.values()].every((request) => request.status !== 'pending'), 'cancel removes pending request');
  assert.equal(server.remoteState.tokens.size, 0);
  await phone.locator('#pair-code').fill('654321');
  await phone.locator('#pair-button').click();
  await until(() => host.locator('button[data-decision="deny"]').count().then(Boolean), 'pending denial');
  await host.locator('button[data-decision="deny"]').click();
  await until(() => phone.locator('#connection-status').getAttribute('data-state').then((state) => state === 'error'), 'denied pairing');
  assert.equal(server.remoteState.tokens.size, 0);
  assert.deepEqual(errors, [], 'browser errors or CSP violations');
  console.log('Browser checks passed: quality/fps controls and capture options, actual frame-rate reporting, single capture, settings persistence, remembered pairing, rotated fullscreen taps/drag, management, input, pause, revocation, layouts, XSS and CSP.');
  console.log(`Screenshots: ${output}`);
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
  await server?.shutdown();
  await fs.unlink(trustStorePath).catch(() => {});
  await fs.rmdir(trustDirectory).catch(() => {});
}
