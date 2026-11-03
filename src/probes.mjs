import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { command } from './platform.mjs';

export function tcpProbe(host, port, timeoutMs, signal) {
  const start = performance.now();
  return new Promise(resolve => {
    const socket = new net.Socket(); let done = false;
    const finish = (ok, error) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); socket.destroy(); resolve({ host, port, ok, ms: Math.round(performance.now() - start), ...(error ? { error } : {}) }); };
    const abort = () => finish(false, 'cancelled');
    socket.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    socket.once('error', e => finish(false, e.code || e.message));
    socket.once('connect', () => finish(true));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    socket.connect({ host, port });
  });
}
export function dnsProbe(host, timeoutMs, signal) {
  const start = performance.now(); const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  return new Promise(resolve => {
    let done = false;
    const finish = (ok, answers, error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolver.cancel(); resolve({ host, ok, answers, ms: Math.round(performance.now() - start), ...(error ? { error } : {}) }); };
    const abort = () => finish(false, [], 'cancelled');
    const timer = setTimeout(() => finish(false, [], 'timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) return abort();
    // Accept IPv6-only answers as working DNS too; use OS-configured DNS servers.
    let pending = 2; const failures = [];
    for (const method of ['resolve4', 'resolve6']) resolver[method](host, (err, answers) => {
      if (!err && answers?.length) return finish(true, answers);
      failures.push(err?.code || 'empty'); if (--pending === 0) finish(false, [], failures.join(','));
    });
  });
}
// Resolve a never-cached random name through the system resolver. NXDOMAIN counts as success: it
// proves an upstream server answered. Cached names alone can hide a broken upstream DNS for minutes.
export function dnsCanary(zone, timeoutMs, signal) {
  const host = `nw${crypto.randomUUID().slice(0, 8)}.${zone}`; const start = performance.now();
  return new Promise(resolve => {
    let done = false;
    const finish = (ok, error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ host: zone, canary: true, ok, ms: Math.round(performance.now() - start), ...(error ? { error } : {}) }); };
    const abort = () => finish(false, 'cancelled');
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) return abort();
    dns.lookup(host, { family: 4 }, err => !err ? finish(true) : ['ENOTFOUND', 'ENODATA'].includes(err.code) ? finish(true) : finish(false, err.code || err.message));
  });
}
// Query a specific DNS server (not the system resolver). Answers prove that server responded.
export function dnsQuery(name, server, timeoutMs, signal) {
  const start = performance.now(); const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  try { resolver.setServers([server]); } catch (e) { return Promise.resolve({ name, server, ok: false, answers: [], error: 'invalid_server', ms: 0 }); }
  return new Promise(resolve => {
    let done = false;
    const finish = (ok, answers, error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolver.cancel(); resolve({ name, server, ok, answers, ms: Math.round(performance.now() - start), ...(error ? { error } : {}) }); };
    const abort = () => finish(false, [], 'cancelled');
    const timer = setTimeout(() => finish(false, [], 'timeout'), timeoutMs + 100);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) return abort();
    resolver.resolve4(name, (err, answers) => err ? finish(false, [], err.code || err.message) : finish(true, answers));
  });
}
export function httpProbe(url, timeoutMs, signal) {
  if (!url) return Promise.resolve({ skipped: true, ok: null });
  const start = performance.now();
  return new Promise(resolve => {
    let req; let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); req?.destroy(); resolve({ ...value, ms: Math.round(performance.now() - start) }); };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    try {
      req = (url.startsWith('https:') ? https : http).get(url, { signal, headers: { 'User-Agent': 'NetworkRepairMaster/0.1' } }, res => {
        res.resume(); const redirect = res.statusCode >= 300 && res.statusCode < 400;
        finish({ ok: res.statusCode === 204, status: res.statusCode, portal: redirect || res.statusCode === 200, location: res.headers.location?.slice(0, 300) });
      });
      req.on('error', e => finish({ ok: false, error: e.code || e.message }));
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}
export async function gatewayProbe(gateway, timeoutMs, signal, platform = process.platform, run = command) {
  if (!gateway || !net.isIP(gateway.split('%')[0])) return { skipped: true, ok: null };
  const start = performance.now();
  const args = platform === 'win32' ? ['-n', '1', '-w', String(timeoutMs), gateway] : platform === 'darwin' ? ['-n', '-c', '1', '-W', String(timeoutMs), gateway] : ['-n', '-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), gateway];
  const r = await run(platform === 'win32' ? 'ping.exe' : '/sbin/ping', args, { timeout: timeoutMs + 200, signal });
  // Linux usually installs ping in /usr/bin, unlike macOS.
  const result = platform === 'linux' && r.code === 'ENOENT' ? await run('ping', args, { timeout: timeoutMs + 200, signal }) : r;
  return { ok: result.ok, gateway, ms: Math.round(performance.now() - start), error: result.ok ? undefined : result.stderr };
}
// Fastest successful TCP connect above this means the uplink is congested, not down.
export const CONGESTION_MS = 800;
export function classify(snapshot) {
  const { network: n, tcp, dns: d, http: h } = snapshot;
  if (!n.interfaces.length) return { kind: 'link_down', severity: 'offline', summary: '没有可用的非回环 IP 地址' };
  if (n.routeKnown && !n.route) return { kind: 'no_route', severity: 'offline', summary: '未发现默认路由' };
  const canary = d.find(p => p.canary);
  // The canary (an uncached random name) needs a full upstream recursion, so it is the first thing to time
  // out when the uplink is merely slow. It alone never makes the network "offline": names already
  // resolving means users can still browse. Offline DNS = every ordinary name fails too.
  const tcpOk = tcp.some(p => p.ok); const dnsOk = d.some(p => !p.canary && p.ok);
  const slowest = tcp.filter(p => p.ok).reduce((m, p) => Math.min(m, p.ms ?? 0), Infinity);
  const r = snapshot.router;
  if (r?.enabled && !tcpOk && !h.ok) {
    // Router layer first: it explains *where* the outage is, which decides the repair.
    if (!r.reachable && !snapshot.gateway?.ok) return { kind: 'lan_failure', severity: 'offline', summary: '本机到路由器不通（网关无应答、路由器管理接口不可达）' };
    if (r.reachable && !r.authError && r.wan) {
      if (r.wan.link === 0) return { kind: 'wan_link_down', severity: 'offline', summary: '路由器 WAN 口物理链路断开' };
      if (!r.wan.connected) return { kind: 'wan_down', severity: 'offline', summary: '路由器 WAN 未连通（未获取地址或拨号失败）' };
    }
  }
  if (tcpOk && !dnsOk) return { kind: 'dns_failure', severity: 'offline', summary: '外网 IP 可达，但 DNS 查询全部失败' };
  if (h.portal) return { kind: 'captive_portal', severity: 'degraded', summary: 'HTTP 探针被重定向或返回页面，可能需要网络认证' };
  if (!tcpOk && !h.ok) return { kind: 'upstream_failure', severity: 'offline', summary: '外网探针均不可达；网关 ICMP 仅作为辅助证据' };
  if (!dnsOk) return { kind: 'dns_failure', severity: 'offline', summary: 'DNS 查询失败' };
  if (!n.routeKnown || !tcpOk || tcp.some(p => !p.ok)) return { kind: 'partial_failure', severity: 'degraded', summary: '部分核心探针异常，暂不执行破坏性恢复' };
  if (canary && !canary.ok) return { kind: 'dns_slow', severity: 'degraded', summary: '常用域名解析正常，但未缓存的新域名查询超时：上游 DNS 变慢', warnings: ['仅记录，不触发修复'] };
  if (slowest >= CONGESTION_MS) return { kind: 'congestion', severity: 'degraded', summary: `外网可达但明显变慢（最快 TCP 连接 ${slowest} ms），疑似上游拥塞`, warnings: ['仅记录，不触发修复'] };
  const warnings = !h.skipped && !h.ok ? ['HTTP 辅助探针无应答；核心 IP 与 DNS 连通性正常'] : [];
  return { kind: 'healthy', severity: 'healthy', summary: warnings.length ? '路由、外网与 DNS 正常；HTTP 辅助探针异常' : '默认路由、外网和 DNS 探测正常', warnings };
}
