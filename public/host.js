'use strict';

(() => {
  const hostToken = document.querySelector('meta[name="host-token"]')?.content || '';
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    status: $('#host-status'), pill: $('#status-pill'), error: $('#error-banner'),
    computer: $('#computer-name'), screen: $('#screen-size'), addresses: $('#connection-addresses'),
    code: $('#host-code'), expiry: $('#code-expiry'), refresh: $('#refresh-code'),
    pending: $('#pending-devices'), pendingCount: $('#pending-count'),
    sessions: $('#active-sessions'), activeCount: $('#active-count'), revokeAll: $('#revoke-all'), toast: $('#toast'),
  };
  let currentState = null;
  let pollTimer = null;
  let polling = false;
  let operation = false;
  let signatures = {};
  let toastTimer = null;
  let lastRequest = 0;

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function asTimestamp(value) {
    return typeof value === 'number' ? value : Date.parse(value);
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3600);
  }

  function setError(message = '') {
    elements.error.textContent = message;
    elements.error.hidden = !message;
  }

  function setStatus(text, mode) {
    elements.status.textContent = text;
    elements.pill.className = `status-pill${mode ? ` ${mode}` : ''}`;
  }

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Host-Token': hostToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(typeof data.error === 'string' ? data.error : '电脑服务暂时无法响应，请重试。');
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function emptyState(container, type) {
    const pending = type === 'pending';
    const empty = element('div', 'empty-state');
    const art = element('span', 'empty-icon');
    art.append(icon(pending ? 'link' : 'phone'));
    empty.append(art, element('strong', '', pending ? '等待你的手机' : '还没有授权的设备'));
    empty.append(element('p', '', pending ? '手机发送配对请求后，会显示在这里。' : '首次批准后会记住此浏览器，下次打开自动连接。'));
    container.replaceChildren(empty);
  }

  function actionButton(text, className, attributes, iconName) {
    const button = element('button', `button ${className}`);
    button.type = 'button';
    button.disabled = operation;
    for (const [name, value] of Object.entries(attributes)) button.dataset[name] = value;
    if (iconName) button.append(icon(iconName));
    button.append(document.createTextNode(text));
    return button;
  }

  function renderPending(requests) {
    elements.pendingCount.textContent = String(requests.length);
    if (!requests.length) return emptyState(elements.pending, 'pending');
    const rows = requests.map((request) => {
      const row = element('article', 'device-row');
      const art = element('span', 'device-avatar');
      art.append(icon('phone'));
      const details = element('div', 'device-detail');
      details.append(element('div', 'device-name', String(request.name || '手机')), element('div', 'device-meta', `${String(request.ip || '')} · 请求控制`));
      const actions = element('div', 'device-actions');
      actions.append(actionButton('拒绝', 'reject-button', { requestId: request.requestId, decision: 'deny' }));
      actions.append(actionButton('批准', 'approve-button', { requestId: request.requestId, decision: 'approve' }, 'check'));
      row.append(art, details, actions);
      return row;
    });
    elements.pending.replaceChildren(...rows);
  }

  function renderSessions(sessions) {
    elements.activeCount.textContent = String(sessions.length);
    if (!sessions.length) return emptyState(elements.sessions, 'sessions');
    const rows = sessions.map((session) => {
      const row = element('article', 'device-row');
      const art = element('span', 'device-avatar');
      art.append(icon('phone'));
      const details = element('div', 'device-detail');
      const accessStatus = session.connected === false ? (session.remembered ? '已记住 · 等待连接' : '已授权 · 等待连接') : '已授权 · 可控制';
      const address = String(session.ip || '');
      details.append(element('div', 'device-name', String(session.name || '手机')), element('div', 'device-meta', `${address ? `${address} · ` : ''}${accessStatus}`));
      const actions = element('div', 'device-actions');
      actions.append(actionButton('撤销', 'revoke-button', { sessionId: session.id }));
      row.append(art, details, actions);
      return row;
    });
    elements.sessions.replaceChildren(...rows);
  }

  function renderAddresses(urls) {
    if (!urls.length) {
      elements.addresses.replaceChildren(element('p', 'address-placeholder', '暂未发现局域网地址，请将电脑连接 Wi-Fi 或网线后重启服务。'));
      return;
    }
    const rows = urls.map((url) => {
      const row = element('div', 'address-row');
      const text = element('span', 'address-text', url);
      const copy = element('button', 'copy-button');
      copy.type = 'button';
      copy.dataset.copyUrl = url;
      copy.title = '复制手机连接地址';
      copy.setAttribute('aria-label', `复制地址 ${url}`);
      copy.append(icon('copy'));
      row.append(text, copy);
      return row;
    });
    elements.addresses.replaceChildren(...rows);
  }

  function updateExpiry() {
    if (!currentState) return;
    const remaining = asTimestamp(currentState.codeExpiresAt) - Date.now();
    const expired = !Number.isFinite(remaining) || remaining <= 0;
    elements.code.classList.toggle('expired', expired);
    if (expired) elements.expiry.textContent = '已过期，请刷新配对码';
    else {
      const seconds = Math.ceil(remaining / 1000);
      elements.expiry.textContent = `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒后过期`;
    }
  }

  function renderState(state) {
    currentState = state;
    elements.computer.textContent = String(state.deviceName || '我的电脑');
    const width = Number(state.screen?.width);
    const height = Number(state.screen?.height);
    elements.screen.textContent = width > 0 && height > 0 ? `Windows 桌面 · ${width} × ${height}` : 'Windows 桌面';
    elements.code.textContent = /^\d{6}$/.test(String(state.code)) ? String(state.code) : '······';
    const requests = Array.isArray(state.requests) ? state.requests.filter((item) => item.status === 'pending' && asTimestamp(item.expiresAt) > Date.now()) : [];
    const sessions = Array.isArray(state.sessions) ? [...new Map(state.sessions.map((session) => [session.id, session])).values()] : [];
    const urls = Array.isArray(state.urls) ? state.urls.filter((value) => typeof value === 'string' && /^http:\/\//.test(value)) : [];
    const next = { pending: JSON.stringify(requests), sessions: JSON.stringify(sessions), urls: JSON.stringify(urls) };
    if (signatures.pending !== next.pending) renderPending(requests);
    if (signatures.sessions !== next.sessions) renderSessions(sessions);
    if (signatures.urls !== next.urls) renderAddresses(urls);
    signatures = next;
    elements.revokeAll.disabled = operation || (!requests.length && !sessions.length);
    updateExpiry();
  }

  function schedulePoll(delay = 1500) {
    clearTimeout(pollTimer);
    if (!document.hidden) pollTimer = setTimeout(poll, delay);
  }

  async function poll() {
    if (polling || operation || document.hidden) return schedulePoll();
    polling = true;
    const sequence = ++lastRequest;
    try {
      const state = await request('/api/host/state');
      if (sequence !== lastRequest) return;
      renderState(state);
      setStatus('服务运行中', 'connected');
      if (!operation) setError();
    } catch (error) {
      setStatus('连接中断', 'failed');
      setError(error.status === 401 || error.status === 403 ? '当前控制台已失效，请刷新本机页面重新连接。' : '无法连接电脑服务。请确认启动窗口仍在运行，页面将自动重试。');
    } finally {
      polling = false;
      schedulePoll();
    }
  }

  async function perform(path, body, message) {
    if (operation) return;
    operation = true;
    lastRequest++;
    document.querySelectorAll('[data-request-id], [data-session-id]').forEach((button) => { button.disabled = true; });
    elements.refresh.disabled = true;
    elements.revokeAll.disabled = true;
    clearTimeout(pollTimer);
    try {
      await request(path, body);
      setError();
      showToast(message);
      signatures = {};
      const state = await request('/api/host/state');
      renderState(state);
      setStatus('服务运行中', 'connected');
    } catch (error) {
      setError(error.name === 'AbortError' ? '操作超时，请检查列表状态后重试。' : error.message);
    } finally {
      operation = false;
      elements.refresh.disabled = false;
      signatures = {};
      if (currentState) renderState(currentState);
      schedulePoll();
    }
  }

  async function copyAddress(value) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const field = element('textarea', 'copy-field', value);
        field.readOnly = true;
        document.body.append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('copy failed');
      }
      showToast('地址已复制，发送到手机后用 Safari 打开。');
    } catch {
      showToast('复制未完成，请选中地址手动复制。');
    }
  }

  elements.pending.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-request-id]');
    if (!button) return;
    void perform('/api/host/decision', { requestId: button.dataset.requestId, decision: button.dataset.decision }, button.dataset.decision === 'approve' ? '已批准这台设备，现在可以控制电脑。' : '已拒绝此次配对请求。');
  });
  elements.sessions.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-session-id]');
    if (button) void perform('/api/host/revoke', { tokenId: button.dataset.sessionId }, '已撤销此设备的授权，下次连接需要重新配对。');
  });
  elements.addresses.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-copy-url]');
    if (button) void copyAddress(button.dataset.copyUrl);
  });
  elements.refresh.addEventListener('click', () => { void perform('/api/host/code', {}, '已生成新的配对码，旧配对码不再有效。'); });
  elements.revokeAll.addEventListener('click', () => { void perform('/api/host/revoke', { all: true }, '已撤销全部设备授权，下次连接需要重新配对。'); });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer);
    if (document.hidden) setStatus('控制台已暂停');
    else void poll();
  });
  window.addEventListener('pagehide', () => { clearTimeout(pollTimer); clearInterval(expiryTimer); });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      expiryTimer = setInterval(updateExpiry, 1000);
      void poll();
    }
  });
  let expiryTimer = setInterval(updateExpiry, 1000);
  if (!hostToken || hostToken === '__HOST_TOKEN__') {
    setStatus('无法连接', 'failed');
    setError('请在运行服务的电脑上，通过本机管理地址打开此页面。');
    elements.refresh.disabled = true;
  } else void poll();
})();
