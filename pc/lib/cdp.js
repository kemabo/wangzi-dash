// CDP 会话工具：注入 cookie、导航、抓取 XHR 请求+响应体
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpJson(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return res.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) { const r = this.pending.get(msg.id); this.pending.delete(msg.id); r(msg); }
      else if (msg.method) this.events.push(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  drain() { const e = this.events; this.events = []; return e; }
  evalAsync(expr, awaitPromise = false) {
    return this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  }
}

async function launchChrome(port) {
  const userDir = path.join(os.tmpdir(), 'cdp-profile-' + port);
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1920,1080',
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { const v = await httpJson(port, '/json/version'); if (v.webSocketDebuggerUrl) return proc; } catch (e) {}
    await sleep(400);
  }
  throw new Error('Chrome 启动失败');
}

async function openSession(port) {
  const targets = await httpJson(port, '/json/list');
  const page = targets.find(t => t.type === 'page') || await httpJson(port, '/json/new?about:blank', 'PUT');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  return new CDP(ws);
}

module.exports = { launchChrome, openSession, sleep, httpJson, CDP, CHROME };
