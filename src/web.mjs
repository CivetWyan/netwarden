import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { ROOT } from './store.mjs';

export function webActions(a) {
  return {
    state: () => a.state(), sample: () => a.sensor.sample({ fresh: true }),
    saveConfig: patch => { if (patch?.startAtLogin) throw Error('服务器自启动由 systemd 管理'); return a.saveConfig(patch); },
    ask: text => a.ask(text), cancel: id => a.tasks.cancel(id), testModel: () => a.testModel(),
    testOnline: () => a.testOnline(), patrol: () => a.patrolNow(), resume: id => a.resumeTask(id),
    script: (id, action) => {
      if (action === 'acknowledge-interrupted') return a.scripts.acknowledgeRun(id);
      if (action === 'approve') return a.scripts.approve(id);
      if (action === 'run') return a.runScript(id);
      throw Error('未知脚本动作');
    },
    review: (id, action) => {
      if (action === 'preview') return a.reviews.preview(id);
      if (['retry', 'approve'].includes(action)) return a.reviews.approve(id);
      throw Error('未知复盘动作');
    },
    runbook: (id, action) => {
      if (action === 'activate') return a.runbooks.activate(id);
      if (action === 'deactivate') return a.runbooks.deactivate(id);
      throw Error('未知方案动作');
    },
    playbook: (id, action) => { if (!['active', 'candidate', 'disabled'].includes(action)) throw Error('未知方案动作'); return a.playbooks.setState(id, action); },
    routerUnlock: () => { a.router.unlock(); a.router.lastStatus = null; return { ok: true }; },
    baseline: () => a.captureBaseline(), retry: () => a.retry(),
    restore: () => { if (a.repair.busy) throw Error('等待当前恢复动作结束后再回滚'); return a.repair.restore(); },
    search: query => { if (typeof query !== 'string' || query.length > 2000) throw Error('检索词过长'); return a.knowledge.search(query, 6, 12000); },
    export: () => ({ filename: `network-report-${Date.now()}.json`, report: a.state() })
  };
}
const hash = text => createHash('sha256').update(text).digest();
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function startWeb(app, { host = '127.0.0.1', port = 8088, password } = {}) {
  if (!password) {
    const file = path.join(app.store.dir, 'web-access.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ password: randomBytes(12).toString('base64url') }), { mode: 0o600, flag: 'wx' });
    password = JSON.parse(fs.readFileSync(file, 'utf8')).password;
  }
  if (typeof password !== 'string' || password.length < 12) throw Error('网页访问密码至少需要12位');
  const expected = hash(password); const sessions = new Map(); const failures = new Map(); const actions = webActions(app);
  let authority; let boundPort;
  // With host 0.0.0.0 the server follows DHCP address changes: accept any local IPv4 as Host, but only
  // from loopback or the subnet of the default-route interface (not container bridges).
  const ipv4s = () => Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).filter(x => x.family === 'IPv4' && !x.internal).map(x => ({ name, address: x.address, cidr: x.cidr })));
  const toInt = ip => ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
  const inCidr = (ip, cidr) => { const [base, bits] = cidr.split('/'); const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0; return (toInt(ip) & mask) === (toInt(base) & mask); };
  const hostOk = value => {
    if (host !== '0.0.0.0') return value === authority;
    const m = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(value || ''); if (!m || Number(m[2]) !== boundPort) return false;
    return ['localhost', '127.0.0.1'].includes(m[1]) || ipv4s().some(x => x.address === m[1]);
  };
  const remoteOk = req => {
    if (host !== '0.0.0.0') return true;
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1') return true;
    const iface = app.sensor.current?.network?.route?.interface; const nets = ipv4s().filter(x => !iface || x.name === iface);
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && nets.some(x => inCidr(ip, x.cidr));
  };
  const auth = req => {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('netwarden_session='))?.slice(18);
    if (!token) return false;
    const expiry = sessions.get(token); if (!expiry || expiry < Date.now()) { sessions.delete(token); return false; }
    return true;
  };
  async function body(req) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw Error('请求必须是 JSON');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw Error('请求超过256KB'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function send(res, status, data, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': csp });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (!remoteOk(req)) return send(res, 403, { error: '来源网段不允许访问' });
      if (!hostOk(req.headers.host)) return send(res, 403, { error: '访问地址不匹配' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: '拒绝跨站请求' });
        if (url.pathname === '/api/session') {
          const ip = req.socket.remoteAddress; const now = Date.now();
          for (const [key, v] of failures) if (v.until < now) failures.delete(key);
          if (failures.size >= 256 || (failures.get(ip)?.count || 0) >= 5) return send(res, 429, { error: '尝试次数过多，请5分钟后重试' });
          const input = await body(req);
          if (typeof input.password !== 'string' || !timingSafeEqual(hash(input.password), expected)) {
            const entry = failures.get(ip) || { count: 0, until: now + 300000 }; entry.count++; failures.set(ip, entry);
            return send(res, 401, { error: '访问密码不正确' });
          }
          failures.delete(ip);
          for (const [token, expiry] of sessions) if (expiry < now) sessions.delete(token);
          if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
          const token = randomBytes(32).toString('base64url'); sessions.set(token, now + 43200000);
          res.setHeader('Set-Cookie', `netwarden_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
          return send(res, 200, { ok: true });
        }
        if (!auth(req)) return send(res, 401, { error: '请先登录网管界面' });
        if (url.pathname === '/api/logout') {
          const token = req.headers.cookie?.match(/(?:^|;\s*)netwarden_session=([^;]+)/)?.[1]; sessions.delete(token);
          res.setHeader('Set-Cookie', 'netwarden_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/rpc') {
          const { method, args } = await body(req);
          if (!Object.hasOwn(actions, method) || !Array.isArray(args) || args.length > 3) return send(res, 400, { error: '未知请求' });
          return send(res, 200, { ok: true, data: await actions[method](...args) });
        }
        return send(res, 404, { error: '页面不存在' });
      }
      if (req.method !== 'GET') return send(res, 405, { error: '不支持的请求方法' });
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!auth(req)) return send(res, 200, fs.readFileSync(path.join(ROOT, 'ui/web-login.html'), 'utf8'), 'text/html');
        const html = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8').replace("connect-src 'none'", "connect-src 'self'").replace('<script src="app.js">', '<script src="web-bridge.js"></script><script src="app.js">');
        return send(res, 200, html, 'text/html');
      }
      const name = url.pathname.slice(1);
      if (!['app.js', 'style.css', 'tray.png', 'web-bridge.js', 'web-login.js', 'web-login.css'].includes(name)) return send(res, 404, { error: '页面不存在' });
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'ui', name)), contentTypes[path.extname(name)]);
    } catch (e) { if (!res.headersSent) send(res, 400, { error: app.store.redact({ message: e.message }).message }); else res.destroy(); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 150000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  boundPort = server.address().port; authority = `${host}:${boundPort}`;
  app.store.log('system', `网页管理已启动：http://${authority}`);
  return { server, url: `http://${authority}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
