import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

export function network(kind = 'healthy') {
  return { platform: 'linux', interfaces: kind === 'link_down' ? [] : [{ name: 'eth0', addresses: [{ address: '192.168.8.20', family: 'IPv4' }] }], routeKnown: true, route: ['no_route', 'link_down'].includes(kind) ? null : { gateway: '192.168.8.1', interface: 'eth0', family: 'IPv4' }, dns: ['192.168.8.1'], connection: { name: 'Wired', uuid: 'aabbccdd-1111-2222-3333-123456789abc', device: 'eth0', method: 'auto', dns: [], ignoreAutoDns: 'no' }, errors: [] };
}
export function fixture(t, { kind = 'healthy', fetcher, platformName = 'linux', routerFetcher } = {}) {
  const parent = path.join(ROOT, 'test-results', 'unit'); fs.mkdirSync(parent, { recursive: true }); const dir = fs.mkdtempSync(path.join(parent, 'run-'));
  const ctx = { kind, actions: [], network: null };
  const platform = { platform: platformName, inspect: async () => structuredClone(ctx.network || network(ctx.kind)), run: async (file, args) => ({ ok: true, file, args, stdout: 'fixture diagnostics', stderr: '', code: 0 }), diagnose: async topic => ({ ok: true, topic, stdout: 'fixture diagnostics' }), repair: async (action, connection, servers) => { ctx.actions.push({ action, connection, servers }); return { ok: true, code: 0, stdout: 'fixture action', stderr: '' }; } };
  const probes = {
    tcp: async (host, port) => ({ host, port, ok: !['upstream_failure', 'link_down', 'no_route'].includes(ctx.kind), ms: 3 }),
    dns: async host => ({ host, ok: !['dns_failure', 'upstream_failure', 'link_down'].includes(ctx.kind), answers: ['192.0.2.1'], ms: 2 }),
    http: async () => ({ ok: ctx.kind === 'healthy', portal: ctx.kind === 'captive_portal', status: ctx.kind === 'healthy' ? 204 : ctx.kind === 'captive_portal' ? 302 : 0 }),
    gateway: async () => ({ ok: ctx.kind !== 'link_down', ms: 1 }),
    canary: async zone => ({ host: zone, canary: true, ok: !['dns_failure', 'upstream_failure', 'link_down'].includes(ctx.kind), ms: 2 }),
    query: async (name, server) => ({ name, server, ok: ctx.dnsServers ? ctx.dnsServers(server) : server !== '192.0.2.53', ...(server === '192.0.2.53' && !ctx.dnsServers ? { error: 'ETIMEOUT' } : {}), answers: [], ms: 1 }),
    upstream: async host => ({ ok: ctx.upstreamHosts ? ctx.upstreamHosts(host) : (ctx.upstreamOk ?? true), gateway: host, ms: 1 })
  };
  const app = new Engine({ dir, platform, probes, fetcher, routerFetcher, knowledgeDir: path.join(ROOT, 'tests', 'no-knowledge') });
  app.store.saveConfig({ model: { name: 'mock-model' }, agent: { goalChecks: false, semanticCompact: false, autoResume: false }, monitor: { enabled: false, intervalMs: 500, probeTimeoutMs: 200, failureThreshold: 1, recoveryThreshold: 1 }, repair: { verifyDelayMs: 100 } });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, ctx, dir };
}
export const response = (content = '已根据探针结果完成分析。', calls) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { total_tokens: 100 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
export const call = (name, args = {}, id = crypto.randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// In-memory Xiaomi BE6500 admin API. `state.onChange` lets a test couple router config to probe results.
export function fakeRouter({ password = 'routerpass1' } = {}) {
  const sha = s => createHash('sha256').update(s).digest('hex'); const KEY = '00112233445566778899aabbccddeeff';
  const state = { details: { wanType: 'static', ifname: 'eth0.1', ipaddr: '198.51.100.113', netmask: '255.255.255.0', gateway: '198.51.100.254', dns: ['203.0.113.53', '8.8.8.8'], mtu: '1500' }, mac: '02:00:00:00:00:26', speed: 0, link: 1, logins: 0, failedLogins: 0, writes: [], reboots: 0, token: null, onChange: () => {} };
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = async (url, opts = {}) => {
    const u = new URL(url); const form = new URLSearchParams(opts.body || u.search.slice(1));
    if (u.pathname === '/cgi-bin/luci/web') return new Response("<script>var x={key: '" + KEY + "'}; deviceId = 'aa:bb:cc:dd:ee:ff';</script>");
    if (u.pathname === '/cgi-bin/luci/api/xqsystem/login') {
      const nonce = form.get('nonce'); state.logins++;
      if (form.get('password') !== sha(nonce + sha(password + KEY))) { state.failedLogins++; return json({ code: 401, msg: 'not auth' }); }
      state.token = 'tok' + state.logins; return json({ code: 0, token: state.token });
    }
    const m = u.pathname.match(/^\/cgi-bin\/luci\/;stok=([^/]+)\/api\/(.+)$/);
    if (!m) return new Response('No page is registered', { status: 404 });
    if (m[1] !== state.token) return json({ code: 401, msg: 'Invalid token' });
    const api = m[2]; const connected = state.link === 1;
    switch (api) {
      case 'xqnetwork/wan_info': return json({ code: 0, info: { mac: state.mac, link: state.link, status: connected ? 1 : 0, details: structuredClone(state.details), gateWay: state.details.gateway, ipv4: [{ ip: state.details.ipaddr }], uptime: 10 } });
      case 'xqnetwork/mac_clone': { const m = (form.get('mac') || '').toUpperCase(); if (m === state.mac.toUpperCase()) return json({ msg: '参数有误', code: 1537 }); state.writes.push({ api, params: { mac: m } }); state.mac = m; state.onChange(state); return json({ code: 0 }); }
      case 'xqnetwork/wan_link': return json({ code: 0, link: state.link });
      case 'xqnetwork/pppoe_status': return json({ code: 0, proto: state.details.wanType, status: connected ? 2 : 0, gw: state.details.gateway, dns: state.details.dns, ip: { address: state.details.ipaddr }, wanSpeed: '100' });
      case 'xqnetwork/wan_speed': return json({ code: 0, speed: state.speed });
      case 'xqnetwork/set_wan': {
        const p = Object.fromEntries(form); state.writes.push({ api, params: p });
        if (p.wanType === 'static') state.details = { ...state.details, wanType: 'static', ipaddr: p.staticIp, netmask: p.staticMask, gateway: p.staticGateway, dns: [p.dns1, p.dns2].filter(Boolean) };
        state.onChange(state); return json({ code: 0 });
      }
      case 'xqnetwork/set_wan_speed': state.writes.push({ api, params: Object.fromEntries(form) }); state.speed = Number(form.get('speed')); state.onChange(state); return json({ code: 0 });
      case 'xqsystem/reboot': state.reboots++; state.token = null; state.onChange(state); return json({ code: 0 });
      default: return new Response('No page is registered', { status: 404 });
    }
  };
  return { state, fetcher, password };
}
