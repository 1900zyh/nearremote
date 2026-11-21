import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRemoteServer, SCREEN_PROFILES } from './server.js';

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t, options = {}) {
  const approvalInput = new PassThrough();
  const approvalOutput = new PassThrough();
  const calls = [];
  const bridge = {
    async send(action, data) {
      calls.push({ action, data });
      if (action === 'screen') return { data: Buffer.from('jpeg-test').toString('base64') };
      if (action === 'dimensions') return { data: { width: 1920, height: 1080 } };
      return { data: true };
    },
    close() {},
  };
  const server = createRemoteServer({
    bridge,
    addresses: new Set(['127.0.0.1']),
    pairCode: '654321',
    screen: { width: 1920, height: 1080 },
    approvalInput,
    approvalOutput,
    onPairRequest() {},
    ...options,
  });
  let base;
  for (;;) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    try { await fetch(`${base}/api/status`); break; }
    catch (error) {
      // Windows can assign an ephemeral port on the browser/Fetch blocked-port list.
      if (error.cause?.message !== 'bad port') throw error;
      await new Promise((resolve) => server.close(resolve));
    }
  }
  t.after(async () => {
    approvalInput.end();
    approvalOutput.end();
    await server.shutdown();
  });
  return { base, server, approvalInput, calls };
}

async function pair(base, server, approvalInput) {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '654321', name: '测试 iPhone' }),
  });
  assert.equal(response.status, 202);
  const { requestId } = await response.json();
  const request = server.remoteState.pairRequests.get(requestId);
  assert.equal(request.status, 'pending', 'pair request must wait for local approval');
  approvalInput.write(`approve ${request.approvalCode}\n`);
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await fetch(`${base}/api/pair/${requestId}`).then((result) => result.json());
    if (status.status === 'approved') return status.token;
    await wait();
  }
  throw new Error('local pairing approval was not observed');
}

async function requestPair(base, data = {}) {
  return fetch(`${base}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '654321', name: '测试 iPhone', ...data }),
  });
}

async function approvePair(base, server, data = {}) {
  const response = await requestPair(base, data);
  assert.equal(response.status, 202);
  const { requestId } = await response.json();
  assert.equal(server.remoteState.decide(requestId, 'approve'), true);
  const status = await fetch(`${base}/api/pair/${requestId}`).then((result) => result.json());
  assert.equal(status.status, 'approved');
  return { requestId, token: status.token };
}

async function trustStore(t) {
  const prefix = path.join(os.tmpdir(), 'nearremote-trust-test-');
  const directory = await fs.mkdtemp(prefix);
  assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)), 'test data must stay inside its private temporary directory');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'trusted-devices.json');
}

async function hostHeaders(base) {
  const html = await fetch(`${base}/host`).then((response) => response.text());
  return { 'x-host-token': /name="host-token"\s+content="([^"]+)"/.exec(html)[1], 'content-type': 'application/json' };
}

async function hostState(base) {
  return fetch(`${base}/api/host/state`, { headers: await hostHeaders(base) }).then((response) => response.json());
}

test('pairing requires the short code and explicit local approval before controller access', async (t) => {
  const { base, server, approvalInput } = await setup(t);
  const unauthorized = await fetch(`${base}/api/screen.jpg`);
  assert.equal(unauthorized.status, 401);

  const wrongCode = await fetch(`${base}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '000000', name: '陌生设备' }),
  });
  assert.equal(wrongCode.status, 401);

  const token = await pair(base, server, approvalInput);
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 40);

  const screen = await fetch(`${base}/api/screen.jpg`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(screen.status, 200);
  assert.equal(screen.headers.get('content-type'), 'image/jpeg');
  assert.equal(await screen.text(), 'jpeg-test');

  const disconnect = await fetch(`${base}/api/disconnect`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(disconnect.status, 200);
  const revoked = await fetch(`${base}/api/screen.jpg`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(revoked.status, 401);
});

test('remote input is authenticated and strictly validates target coordinates and key names', async (t) => {
  const { base, server, approvalInput, calls } = await setup(t);
  const token = await pair(base, server, approvalInput);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const pointer = await fetch(`${base}/api/input`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'pointer', x: 0.5, y: 1 }),
  });
  assert.equal(pointer.status, 200);
  assert.equal(calls.at(-1).action, 'pointer');

  const outOfBounds = await fetch(`${base}/api/input`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'pointer', x: 1.01, y: 0.5 }),
  });
  assert.equal(outOfBounds.status, 400);

  const unsupportedKey = await fetch(`${base}/api/input`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'key', key: 'CTRL_ALT_DELETE' }),
  });
  assert.equal(unsupportedKey.status, 400);

  const tooMuchText = await fetch(`${base}/api/input`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'text', text: 'x'.repeat(2001) }),
  });
  assert.equal(tooMuchText.status, 400);
  assert.equal(calls.filter((call) => call.action === 'pointer').length, 1, 'invalid instructions must not reach the native bridge');
});

test('disconnect releases a held mouse button so a lost iPhone cannot leave a drag active', async (t) => {
  const { base, server, approvalInput, calls } = await setup(t);
  const token = await pair(base, server, approvalInput);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const held = await fetch(`${base}/api/input`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'button', button: 'left', down: true }),
  });
  assert.equal(held.status, 200);

  const disconnect = await fetch(`${base}/api/disconnect`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(disconnect.status, 200);
  assert.deepEqual(calls.filter((call) => call.action === 'button').map((call) => call.data.down), [true, false]);
  assert.equal(server.remoteState.tokens.has(token), false);
});

test('LAN host and same-origin boundary reject foreign hosts, web origins, and non-LAN clients', async (t) => {
  const { base } = await setup(t);
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(new URL('/api/status', base), { headers: { host: 'attacker.invalid' } }, resolve);
    request.once('error', reject);
    request.end();
  });
  assert.equal(badHost.statusCode, 421);

  const badOrigin = await fetch(`${base}/api/pair`, {
    method: 'POST', headers: { origin: 'http://attacker.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '654321', name: '测试设备' }),
  });
  assert.equal(badOrigin.status, 403);

  assert.equal(await fetch(`${base}/api/status`).then((response) => response.status), 200);
});

test('local host panel is protected and approval state never exposes controller tokens', async (t) => {
  const { base } = await setup(t);
  const panel = await fetch(`${base}/host`);
  assert.equal(panel.status, 200);
  const html = await panel.text();
  const hostToken = /name="host-token"\s+content="([^"]+)"/.exec(html)?.[1];
  assert.ok(hostToken && hostToken !== '__HOST_TOKEN__');
  assert.equal(panel.headers.get('cache-control'), 'no-store');
  assert.ok(panel.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(await fetch(`${base}/api/host/state`).then((response) => response.status), 403);
  assert.equal(await fetch(`${base}/api/host/state`, { headers: { 'x-host-token': 'invalid' } }).then((response) => response.status), 403);
  const hostHeaders = { 'x-host-token': hostToken, 'content-type': 'application/json' };

  const started = await fetch(`${base}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '654321', name: '<script>手机</script>' }),
  }).then((response) => response.json());
  const pending = await fetch(`${base}/api/pair/${started.requestId}`).then((response) => response.json());
  assert.deepEqual(pending, { status: 'pending' });
  assert.equal(await fetch(`${base}/api/host/decision`, {
    method: 'POST', headers: hostHeaders, body: JSON.stringify({ requestId: started.requestId, decision: 'approve' }),
  }).then((response) => response.status), 200);
  const approved = await fetch(`${base}/api/pair/${started.requestId}`).then((response) => response.json());
  assert.equal(approved.status, 'approved');
  assert.ok(approved.token.length >= 40);
  const state = await fetch(`${base}/api/host/state`, { headers: hostHeaders }).then((response) => response.json());
  assert.equal(state.sessions.length, 1);
  assert.equal(state.requests.length, 1);
  assert.ok(!JSON.stringify(state).includes(approved.token), 'host state uses session ids, never bearer tokens');
  assert.ok(!JSON.stringify(state).includes(hostToken), 'host token must stay out of API data');
  const publicState = await fetch(`${base}/api/status`).then((response) => response.json());
  assert.ok(!JSON.stringify(publicState).includes('654321'), 'pairing code stays local');
  assert.ok(!JSON.stringify(publicState).includes(approved.token));
  assert.equal(await fetch(`${base}/api/host/revoke`, {
    method: 'POST', headers: hostHeaders, body: JSON.stringify({ tokenId: state.sessions[0].id }),
  }).then((response) => response.status), 200);
  assert.deepEqual(await fetch(`${base}/api/pair/${started.requestId}`).then((response) => response.json()), { status: 'expired' }, 'revoked sessions cannot recover their bearer token from pairing polls');
  assert.equal(await fetch(`${base}/api/screen.jpg`, { headers: { authorization: `Bearer ${approved.token}` } }).then((response) => response.status), 401);
  const refresh = await fetch(`${base}/api/host/code`, { method: 'POST', headers: hostHeaders, body: '{}' }).then((response) => response.json());
  assert.match(refresh.code, /^\d{6}$/);
  assert.ok(Date.parse(refresh.codeExpiresAt) > Date.now());
  assert.equal(await fetch(`${base}/api/host/code`, {
    method: 'POST', headers: { 'x-host-token': hostToken, 'content-type': 'text/plain' }, body: '{}',
  }).then((response) => response.status), 415);
  assert.equal(await fetch(`${base}/api/host/state`, {
    headers: { 'x-host-token': hostToken, origin: 'http://foreign.invalid' },
  }).then((response) => response.status), 403);
});

test('web resource allowlist serves controller files but hides host page from remote clients', async (t) => {
  const { base } = await setup(t);
  for (const url of ['/', '/app.js', '/styles.css', '/favicon.svg', '/host', '/host.js', '/host.css']) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const url of ['/server.js', '/windows-control.ps1', '/package.json', '/host.html', '/.env']) {
    assert.equal(await fetch(`${base}${url}`).then((response) => response.status), 404, url);
  }
  const notLocal = await new Promise((resolve, reject) => {
    const request = http.request(new URL('/host', base), { localAddress: '127.0.0.2' }, resolve);
    request.once('error', reject);
    request.end();
  });
  assert.equal(notLocal.statusCode, 403);
  notLocal.resume();
});

test('release clears held buttons and keeps the paired session valid', async (t) => {
  const { base, server, approvalInput, calls } = await setup(t);
  const token = await pair(base, server, approvalInput);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  await fetch(`${base}/api/input`, { method: 'POST', headers, body: JSON.stringify({ action: 'button', button: 'left', down: true }) });
  assert.equal(await fetch(`${base}/api/release`, { method: 'POST', headers }).then((response) => response.status), 200);
  assert.equal(server.remoteState.tokens.has(token), true);
  assert.deepEqual(calls.filter((call) => call.action === 'button').map((call) => call.data.down), [true, false]);
  assert.equal(await fetch(`${base}/api/screen.jpg`, { headers }).then((response) => response.status), 200);
});

test('simultaneous screen requests share one native capture', async (t) => {
  let captures = 0;
  const { base, server, approvalInput } = await setup(t, {
    bridge: {
      async send(action) {
        if (action === 'screen') {
          captures++;
          await wait(30);
          return { data: Buffer.from('shared-jpeg').toString('base64') };
        }
        return { data: true };
      }, close() {},
    },
  });
  const token = await pair(base, server, approvalInput);
  const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(`${base}/api/screen.jpg`, { headers: { authorization: `Bearer ${token}` } })));
  for (const response of responses) assert.equal(response.status, 200);
  assert.equal(captures, 1);
});

test('screen profiles select higher quality capture parameters and report actual bounded dimensions', async (t) => {
  const { base, server, calls } = await setup(t, { screen: { width: 3840, height: 1200 } });
  const authorization = await approvePair(base, server);
  const headers = { authorization: `Bearer ${authorization.token}` };
  const status = await fetch(`${base}/api/status`).then((response) => response.json());
  assert.deepEqual(status.screenProfiles.map((profile) => profile.id), ['balanced', 'sharp', 'native']);
  assert.equal(status.screenProfiles[0].quality, 88);
  for (const [id, profile] of Object.entries(SCREEN_PROFILES)) {
    const response = await fetch(`${base}/api/screen.jpg${id === 'balanced' ? '' : `?profile=${id}`}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'jpeg-test');
    assert.equal(response.headers.get('x-frame-profile'), id);
    assert.equal(Number(response.headers.get('x-frame-quality')), profile.quality);
    assert.equal(Number(response.headers.get('x-frame-width')), profile.maxWidth);
    assert.equal(Number(response.headers.get('x-frame-height')), profile.maxWidth * 1200 / 3840);
    assert.ok(Number.isFinite(Number(response.headers.get('x-capture-ms'))));
    assert.deepEqual(calls.filter((call) => call.action === 'screen').at(-1).data, {
      maxWidth: profile.maxWidth, maxHeight: profile.maxHeight, quality: profile.quality,
    });
  }
});

test('unknown and duplicate profiles are rejected before native capture and valid profiles require authorization', async (t) => {
  const { base, server, calls } = await setup(t);
  const authorization = await approvePair(base, server);
  const headers = { authorization: `Bearer ${authorization.token}` };
  for (const query of ['profile=', 'profile=unknown', 'profile=__proto__', 'profile=balanced&profile=sharp', 'profile=native&profile=native']) {
    assert.equal(await fetch(`${base}/api/screen.jpg?${query}`, { headers }).then((response) => response.status), 400, query);
  }
  assert.equal(await fetch(`${base}/api/screen.jpg?profile=native`).then((response) => response.status), 401);
  assert.equal(calls.filter((call) => call.action === 'screen').length, 0);
});

test('different profiles use independent frame caches and a bounded fair capture queue', async (t) => {
  const captureProfiles = [];
  let active = 0;
  let maximumActive = 0;
  const { base, server } = await setup(t, {
    captureBridge: {
      async send(action, options) {
        assert.equal(action, 'screen');
        captureProfiles.push(options.quality);
        active++;
        maximumActive = Math.max(maximumActive, active);
        await wait(25);
        active--;
        return { data: Buffer.from(`quality-${options.quality}`).toString('base64') };
      }, close() {},
    },
  });
  const authorization = await approvePair(base, server);
  const headers = { authorization: `Bearer ${authorization.token}` };
  const requested = ['balanced', 'native', 'sharp', 'native', 'balanced', 'sharp'];
  const responses = await Promise.all(requested.map((id) => fetch(`${base}/api/screen.jpg?profile=${id}`, { headers })));
  for (let index = 0; index < responses.length; index++) {
    assert.equal(responses[index].status, 200);
    assert.equal(await responses[index].text(), `quality-${SCREEN_PROFILES[requested[index]].quality}`);
  }
  assert.equal(maximumActive, 1, 'profile switching must not flood the native capture process');
  assert.equal(captureProfiles.length, 3, 'each queued profile captures once and shares concurrent callers');
});

test('screen refresh above the old five-request cap remains available while excessive bursts are limited', async (t) => {
  const { base, server } = await setup(t);
  const authorization = await approvePair(base, server);
  const headers = { authorization: `Bearer ${authorization.token}` };
  const initial = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/api/screen.jpg?profile=balanced`, { headers })));
  for (const response of initial) { assert.equal(response.status, 200); await response.arrayBuffer(); }
  const excessive = await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/api/screen.jpg?profile=balanced`, { headers })));
  assert.ok(excessive.some((response) => response.status === 429), 'the higher cap still bounds abusive bursts');
  for (const response of excessive) await response.arrayBuffer();
});

test('high-resolution frames larger than the old cap are accepted but frames above twelve MiB are rejected', async (t) => {
  let bytes = Buffer.alloc(5 * 1024 * 1024, 0x54);
  const { base, server } = await setup(t, {
    captureBridge: { async send() { return { data: bytes.toString('base64') }; }, close() {} },
  });
  const authorization = await approvePair(base, server);
  const headers = { authorization: `Bearer ${authorization.token}` };
  const highResolution = await fetch(`${base}/api/screen.jpg?profile=native`, { headers });
  assert.equal(highResolution.status, 200);
  assert.equal((await highResolution.arrayBuffer()).byteLength, bytes.length);
  bytes = Buffer.alloc(12 * 1024 * 1024 + 1, 0x55);
  const oversized = await fetch(`${base}/api/screen.jpg?profile=sharp`, { headers });
  assert.equal(oversized.status, 500);
  assert.deepEqual(await oversized.json(), { error: '服务端发生错误' });
});

test('a separate capture bridge does not delay input and each bridge closes exactly once', async (t) => {
  let releaseCapture;
  let captureStarted;
  let inputCloses = 0;
  let captureCloses = 0;
  const started = new Promise((resolve) => { captureStarted = resolve; });
  const inputCalls = [];
  const { base, server } = await setup(t, {
    bridge: {
      async send(action, data) { inputCalls.push({ action, data }); return { data: true }; },
      close() { inputCloses++; },
    },
    captureBridge: {
      async send() {
        captureStarted();
        return new Promise((resolve) => { releaseCapture = () => resolve({ data: Buffer.from('slow-frame').toString('base64') }); });
      },
      close() { captureCloses++; releaseCapture?.(); },
    },
  });
  const authorization = await approvePair(base, server);
  const headers = { authorization: `Bearer ${authorization.token}`, 'content-type': 'application/json' };
  const frameRequest = fetch(`${base}/api/screen.jpg?profile=native`, { headers });
  await started;
  const input = await fetch(`${base}/api/input`, { method: 'POST', headers, body: JSON.stringify({ action: 'key', key: 'ENTER' }) });
  assert.equal(input.status, 200, 'keyboard input should complete while a screen capture is still pending');
  assert.deepEqual(inputCalls.map((call) => call.action), ['key']);
  releaseCapture();
  const frame = await frameRequest;
  assert.equal(frame.status, 200);
  assert.equal(await frame.text(), 'slow-frame');
  await server.shutdown();
  await server.shutdown();
  assert.equal(inputCloses, 1);
  assert.equal(captureCloses, 1);
});

test('canceling a pairing request prevents later approval but cannot revoke an approved device', async (t) => {
  const { base, server } = await setup(t);
  const start = () => fetch(`${base}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '654321', name: '取消配对的手机' }),
  }).then((response) => response.json());
  const cancel = (id) => fetch(`${base}/api/pair/${id}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const pending = await start();
  assert.equal((await cancel(pending.requestId)).status, 200);
  assert.equal(server.remoteState.decide(pending.requestId, 'approve'), false);
  assert.deepEqual(await fetch(`${base}/api/pair/${pending.requestId}`).then((response) => response.json()), { status: 'denied' });
  const approved = await start();
  assert.equal(server.remoteState.decide(approved.requestId, 'approve'), true);
  const token = server.remoteState.pairRequests.get(approved.requestId).token;
  assert.equal((await cancel(approved.requestId)).status, 200);
  assert.equal(server.remoteState.tokens.has(token), true);
  assert.equal((await cancel('00000000-0000-0000-0000-000000000000')).status, 404);
});

test('repeated pairing from one identified browser reuses its pending approval without extending expiry', async (t) => {
  const { base, server } = await setup(t);
  const deviceId = 'browser-device-id-0001';
  const first = await requestPair(base, { deviceId }).then((response) => response.json());
  const second = await requestPair(base, { deviceId, name: '另一个临时名称' }).then((response) => response.json());
  assert.deepEqual(second, first, 'retry must reuse the request and its original deadline');
  assert.equal(server.remoteState.pairRequests.size, 1);
  assert.equal(server.remoteState.pairRequests.get(first.requestId).name, '测试 iPhone', 'retry must not silently change the device shown for local approval');
  assert.equal(server.remoteState.tokens.size, 0);
});

test('locally approving the same browser replaces its old authorization and releases its held mouse button', async (t) => {
  const { base, server, calls } = await setup(t);
  const deviceId = 'browser-device-id-0001';
  const first = await approvePair(base, server, { deviceId });
  await fetch(`${base}/api/input`, {
    method: 'POST', headers: { authorization: `Bearer ${first.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'button', button: 'left', down: true }),
  });
  const pending = await requestPair(base, { deviceId, name: '重命名后的 iPhone' }).then((response) => response.json());
  assert.equal(server.remoteState.tokens.has(first.token), true, 'a pending request must not revoke an existing authorized device');
  assert.equal(server.remoteState.decide(pending.requestId, 'approve'), true);
  const second = await fetch(`${base}/api/pair/${pending.requestId}`).then((response) => response.json());
  assert.notEqual(second.token, first.token);
  assert.equal(server.remoteState.tokens.size, 1);
  assert.equal(server.remoteState.tokens.has(first.token), false);
  assert.equal(server.remoteState.tokens.has(second.token), true);
  assert.deepEqual(await fetch(`${base}/api/pair/${first.requestId}`).then((response) => response.json()), { status: 'expired' });
  assert.equal(await fetch(`${base}/api/screen.jpg`, { headers: { authorization: `Bearer ${first.token}` } }).then((response) => response.status), 401);
  for (let attempt = 0; attempt < 20 && calls.filter((call) => call.action === 'button').length < 2; attempt++) await wait();
  assert.deepEqual(calls.filter((call) => call.action === 'button').map((call) => call.data.down), [true, false]);
});

test('different identified browsers sharing one name and IP retain separate authorizations', async (t) => {
  const { base, server } = await setup(t);
  const first = await approvePair(base, server, { deviceId: 'browser-device-id-0001' });
  const second = await approvePair(base, server, { deviceId: 'browser-device-id-0002' });
  assert.equal(server.remoteState.tokens.size, 2);
  assert.equal(server.remoteState.tokens.has(first.token), true);
  assert.equal(server.remoteState.tokens.has(second.token), true);

  const hostHTML = await fetch(`${base}/host`).then((response) => response.text());
  const hostToken = /name="host-token"\s+content="([^"]+)"/.exec(hostHTML)[1];
  const visible = await fetch(`${base}/api/host/state`, { headers: { 'x-host-token': hostToken } }).then((response) => response.json());
  assert.equal(visible.sessions.length, 2);
  assert.ok(!JSON.stringify(visible).includes('browser-device-id-'), 'browser identity is not needed in the host panel');
});

test('legacy clients deduplicate on local approval and can migrate to a browser identifier', async (t) => {
  const { base, server } = await setup(t);
  const first = await approvePair(base, server);
  const second = await approvePair(base, server);
  assert.equal(server.remoteState.tokens.size, 1);
  assert.equal(server.remoteState.tokens.has(first.token), false);
  assert.equal(server.remoteState.tokens.has(second.token), true);

  const migrated = await approvePair(base, server, { deviceId: 'browser-device-id-0001' });
  assert.equal(server.remoteState.tokens.size, 1);
  assert.equal(server.remoteState.tokens.has(second.token), false);
  assert.equal(server.remoteState.tokens.has(migrated.token), true);
  assert.deepEqual(await fetch(`${base}/api/pair/${second.requestId}`).then((response) => response.json()), { status: 'expired' });
});

test('optional browser identifiers are validated before creating pairing requests', async (t) => {
  const { base, server } = await setup(t);
  for (const deviceId of ['', null, 42, 'short', 'a'.repeat(101), 'with invalid spaces 1234', '<script>1234567890</script>']) {
    assert.equal(await requestPair(base, { deviceId }).then((response) => response.status), 400);
  }
  assert.equal(server.remoteState.pairRequests.size, 0);
  const valid = await requestPair(base, { deviceId: 'c73ef016-a8f1-41f1-90ea-1dc236ff55b9' });
  assert.equal(valid.status, 202, 'UUID identifiers are accepted');
});

test('remembered device credentials survive a host restart while the trust file contains no bearer secret', async (t) => {
  const filename = await trustStore(t);
  const first = await setup(t, { trustStorePath: filename });
  const authorization = await approvePair(first.base, first.server, { deviceId: 'browser-device-id-0001' });
  const text = await fs.readFile(filename, 'utf8');
  assert.ok(!text.includes(authorization.token), 'the raw bearer secret must never be persisted');
  const stored = JSON.parse(text);
  assert.equal(stored.devices.length, 1);
  assert.match(stored.devices[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.ok(!Object.hasOwn(stored.devices[0], 'token'));
  await first.server.shutdown();

  const restarted = await setup(t, { trustStorePath: filename });
  assert.equal(restarted.server.remoteState.tokens.size, 0, 'remembered devices start offline');
  let listing = await hostState(restarted.base);
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0].remembered, true);
  assert.equal(listing.sessions[0].connected, false);
  assert.ok(!JSON.stringify(listing).includes(stored.devices[0].tokenHash));
  assert.ok(!JSON.stringify(listing).includes('browser-device-id-0001'));
  const headers = { authorization: `Bearer ${authorization.token}`, 'content-type': 'application/json' };
  assert.equal(await fetch(`${restarted.base}/api/screen.jpg`, { headers }).then((response) => response.status), 200);
  assert.equal(await fetch(`${restarted.base}/api/input`, { method: 'POST', headers, body: JSON.stringify({ action: 'key', key: 'ENTER' }) }).then((response) => response.status), 200);
  assert.equal(await fetch(`${restarted.base}/api/release`, { method: 'POST', headers }).then((response) => response.status), 200);
  listing = await hostState(restarted.base);
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0].connected, true);
});

test('remembered offline devices can be revoked individually or all at once and stay revoked after restart', async (t) => {
  const filename = await trustStore(t);
  const first = await setup(t, { trustStorePath: filename });
  const a = await approvePair(first.base, first.server, { deviceId: 'browser-device-id-0001' });
  const b = await approvePair(first.base, first.server, { deviceId: 'browser-device-id-0002' });
  const original = await hostState(first.base);
  const aId = original.sessions[0].id;
  await first.server.shutdown();

  const offline = await setup(t, { trustStorePath: filename });
  assert.equal(offline.server.remoteState.tokens.size, 0);
  assert.equal(await fetch(`${offline.base}/api/host/revoke`, {
    method: 'POST', headers: await hostHeaders(offline.base), body: JSON.stringify({ tokenId: aId }),
  }).then((response) => response.status), 200);
  await offline.server.shutdown();

  const afterRevoke = await setup(t, { trustStorePath: filename });
  assert.equal(await fetch(`${afterRevoke.base}/api/screen.jpg`, { headers: { authorization: `Bearer ${a.token}` } }).then((response) => response.status), 401);
  assert.equal(await fetch(`${afterRevoke.base}/api/screen.jpg`, { headers: { authorization: `Bearer ${b.token}` } }).then((response) => response.status), 200);
  assert.equal((await hostState(afterRevoke.base)).sessions.length, 1);
  assert.equal(await fetch(`${afterRevoke.base}/api/host/revoke`, {
    method: 'POST', headers: await hostHeaders(afterRevoke.base), body: JSON.stringify({ all: true }),
  }).then((response) => response.status), 200);
  await afterRevoke.server.shutdown();

  const final = await setup(t, { trustStorePath: filename });
  assert.equal(await fetch(`${final.base}/api/screen.jpg`, { headers: { authorization: `Bearer ${b.token}` } }).then((response) => response.status), 401);
  assert.equal((await hostState(final.base)).sessions.length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')).devices, []);
});

test('explicit disconnection can revoke a remembered credential without first resuming its screen', async (t) => {
  const filename = await trustStore(t);
  const first = await setup(t, { trustStorePath: filename });
  const authorization = await approvePair(first.base, first.server, { deviceId: 'browser-device-id-0001' });
  await first.server.shutdown();
  const restarted = await setup(t, { trustStorePath: filename });
  assert.equal(await fetch(`${restarted.base}/api/disconnect`, {
    method: 'POST', headers: { authorization: `Bearer ${authorization.token}` },
  }).then((response) => response.status), 200);
  await restarted.server.shutdown();
  const final = await setup(t, { trustStorePath: filename });
  assert.equal(await fetch(`${final.base}/api/release`, {
    method: 'POST', headers: { authorization: `Bearer ${authorization.token}` },
  }).then((response) => response.status), 401);
});

test('reapproving a remembered browser replaces its old persisted credential across further restarts', async (t) => {
  const filename = await trustStore(t);
  const first = await setup(t, { trustStorePath: filename });
  const original = await approvePair(first.base, first.server, { deviceId: 'browser-device-id-0001' });
  await first.server.shutdown();
  const restarted = await setup(t, { trustStorePath: filename });
  const replacement = await approvePair(restarted.base, restarted.server, { deviceId: 'browser-device-id-0001' });
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).devices.length, 1);
  await restarted.server.shutdown();
  const final = await setup(t, { trustStorePath: filename });
  assert.equal(await fetch(`${final.base}/api/screen.jpg`, { headers: { authorization: `Bearer ${original.token}` } }).then((response) => response.status), 401);
  assert.equal(await fetch(`${final.base}/api/screen.jpg`, { headers: { authorization: `Bearer ${replacement.token}` } }).then((response) => response.status), 200);
});

test('failed persistence neither approves a new device nor revokes the previous credential', async (t) => {
  const filename = await trustStore(t);
  const { base, server } = await setup(t, { trustStorePath: filename });
  const original = await approvePair(base, server, { deviceId: 'browser-device-id-0001' });
  const saved = await fs.readFile(filename, 'utf8');
  await fs.unlink(filename);
  await fs.mkdir(filename); // Make atomic rename fail on every platform, without changing system permissions.
  const pending = await requestPair(base, { deviceId: 'browser-device-id-0001' }).then((response) => response.json());
  const headers = await hostHeaders(base);
  assert.equal(await fetch(`${base}/api/host/decision`, {
    method: 'POST', headers, body: JSON.stringify({ requestId: pending.requestId, decision: 'approve' }),
  }).then((response) => response.status), 503);
  assert.equal(server.remoteState.pairRequests.get(pending.requestId).status, 'pending');
  assert.equal(server.remoteState.tokens.size, 1);
  assert.equal(server.remoteState.tokens.has(original.token), true);
  assert.equal(await fetch(`${base}/api/host/revoke`, {
    method: 'POST', headers, body: JSON.stringify({ all: true }),
  }).then((response) => response.status), 503);
  assert.equal(await fetch(`${base}/api/screen.jpg`, { headers: { authorization: `Bearer ${original.token}` } }).then((response) => response.status), 200);
  assert.deepEqual((await fs.readdir(path.dirname(filename))).sort(), ['trusted-devices.json'], 'a failed atomic write must remove its own temporary file');
  await fs.rmdir(filename);
  await fs.writeFile(filename, saved, 'utf8');
});

test('corrupt or unsupported trust files fail closed without silently accepting or deleting records', async (t) => {
  const filename = await trustStore(t);
  for (const text of ['invalid JSON', '{"version":99,"devices":[]}', '{"version":1,"devices":[{"tokenHash":"bad"}]}']) {
    await fs.writeFile(filename, text, 'utf8');
    assert.throws(() => createRemoteServer({ bridge: { close() {} }, trustStorePath: filename }), /无法读取已记住的设备授权/);
    assert.equal(await fs.readFile(filename, 'utf8'), text, 'corrupt data must be preserved for repair');
  }
});
