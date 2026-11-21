// Reboot/reconnection acceptance with two browsers and persistent mock approvals.
// Never captures the real desktop, runs input, or writes screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRemoteServer } from '../server.js';

const moduleName = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nearremote-reconnect-test-'));
const contexts = [];
const errors = [];
const inputs = [];
const trustStorePath = path.join(temporary, 'trusted-devices.json');
let server;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await check()) return; } catch { /* The server may be restarting. */ }
    await pause(80);
  }
  throw new Error(`Timed out: ${label}`);
}
async function isActive(page) { return page.locator('#left-button').isEnabled(); }
async function visible(page, hidden) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
async function revealConnection(page) {
  await page.locator('#connection-panel').evaluate((panel) => { panel.open = true; });
}

try {
  const picture = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await picture.setContent('<body style="background:#e5eee0;margin:0;padding:60px;font:28px sans-serif">NearRemote reconnection test</body>');
  const jpeg = await picture.screenshot({ type: 'jpeg' });
  await picture.close();
  const options = {
    trustStorePath, pairCode: '654321', deviceName: '记住设备测试电脑',
    screen: { width: 640, height: 360 }, addresses: new Set(['127.0.0.1']),
    videoOptions: { available: false }, onPairRequest() {},
    bridge: { async send(action, data) { if (action === 'screen') return { data: jpeg.toString('base64') }; inputs.push({ action, ...data }); return { data: true }; }, close() {} },
  };
  const startServer = async (port = 0) => {
    server = createRemoteServer(options);
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const base = await startServer();
  const createPage = async (context) => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    return page;
  };
  const pages = [];
  for (const name of ['我的 iPhone', '我的 iPad']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    contexts.push(context);
    const page = await createPage(context);
    pages.push(page);
    await until(() => page.locator('#pair-button').isEnabled(), `${name} host`);
    await page.locator('#pair-code').fill('654321');
    await page.locator('#device-name').fill(name);
    await page.locator('#pair-button').click();
    await until(() => [...server.remoteState.pairRequests.values()].some((request) => request.status === 'pending'), `${name} pending`);
    const request = [...server.remoteState.pairRequests.values()].find((request) => request.status === 'pending');
    server.remoteState.decide(request.requestId, 'approve');
    await until(() => isActive(page), `${name} approved`);
  }
  assert.equal(JSON.parse(await fs.readFile(trustStorePath, 'utf8')).devices.length, 2);

  // Returning to a previously active page resumes without pressing a button.
  const phone = pages[0];
  await visible(phone, true);
  await until(async () => !await isActive(phone), 'background pauses input');
  await visible(phone, false);
  await until(() => isActive(phone), 'foreground automatically restores remembered control');

  // An intentional pause or disconnection must not be undone by a focus event.
  await phone.locator('#pause-button').click();
  await visible(phone, true);
  await visible(phone, false);
  await pause(1200);
  assert.equal(await isActive(phone), false, 'manual pause remains paused');
  await phone.locator('#resume-button').click();
  await until(() => isActive(phone), 'manual resume');
  await revealConnection(phone);
  await phone.locator('#disconnect-button').click();
  await pause(1000);
  assert.ok(await phone.evaluate(() => localStorage.getItem('nearremote.session')), 'ordinary disconnect keeps the trusted credential');
  assert.equal(JSON.parse(await fs.readFile(trustStorePath, 'utf8')).devices.length, 2, 'ordinary disconnect does not revoke either device');
  await visible(phone, true);
  await visible(phone, false);
  await pause(800);
  assert.equal(await isActive(phone), false, 'intentional disconnect remains stopped');
  await phone.reload();
  await until(() => isActive(phone), 'opening the remembered page reconnects automatically');

  // Both pages remain open while the host is fully stopped then restarted.
  const restartPort = server.address().port;
  const inputCount = inputs.length;
  await server.shutdown();
  await pause(1800);
  await startServer(restartPort);
  await until(async () => (await Promise.all(pages.map(isActive))).every(Boolean), 'both devices automatically recover after host reboot', 35_000);
  assert.equal(server.remoteState.pairRequests.size, 0, 'recovery must not ask for new pairing');
  assert.equal(server.remoteState.tokens.size, 2);
  assert.ok(!inputs.slice(inputCount).some((input) => ['text', 'click', 'key'].includes(input.action)), 'reconnection never replays old control commands');

  // Auto-connect can be disabled without losing the saved approval.
  await revealConnection(phone);
  await phone.locator('#auto-reconnect').uncheck();
  await phone.reload();
  await pause(1500);
  assert.equal(await isActive(phone), false, 'disabled automatic reconnection stays disabled after reload');
  assert.ok(await phone.evaluate(() => localStorage.getItem('nearremote.session')));
  await phone.locator('#reconnect-button').click();
  await until(() => isActive(phone), 'saved approval can still connect manually');
  await revealConnection(phone);
  await phone.locator('#auto-reconnect').check();
  await phone.locator('#forget-device-button').click();
  await until(() => phone.locator('#pair-button').isVisible(), 'explicit forget returns to pairing');
  assert.equal(await phone.evaluate(() => localStorage.getItem('nearremote.session')), null);
  assert.equal(JSON.parse(await fs.readFile(trustStorePath, 'utf8')).devices.length, 1, 'forget revokes only this device');
  assert.deepEqual(errors, []);
  console.log('Passed: two remembered devices recover after host restart and foreground return; manual pause/disconnect and auto-connect opt-out are respected; explicit forget revokes one device; no old input is replayed.');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
  await server?.shutdown();
  await fs.unlink(trustStorePath).catch(() => {});
  await fs.rmdir(temporary).catch(() => {});
}
