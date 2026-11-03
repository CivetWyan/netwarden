import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// Xiaomi router admin API (verified on BE6500 / RN02). Endpoint notes: docs/xiaomi-router.md.
// Hard safety boundary: only these endpoints can ever be requested. Reset, firmware, LAN subnet,
// admin password, WiFi mode (ax/MLO drop all wireless clients) are intentionally absent.
const READ_APIS = new Set(['xqnetwork/wan_speed', 'xqnetwork/wan_info', 'xqnetwork/wan_link', 'xqnetwork/pppoe_status', 'xqnetwork/lan_dhcp', 'xqnetwork/macbind_info', 'misystem/status', 'misystem/devicelist', 'xqnetwork/wifi_status']);
// set_wan_speed is only ever used to write back the baseline value (normally 0 = auto-negotiate).
// mac_clone changes the WAN MAC (operator-sanctioned recovery when a stale campus ban blocks us).
const WRITE_APIS = new Set(['xqnetwork/set_wan', 'xqnetwork/set_wan_speed', 'xqnetwork/mac_clone', 'xqsystem/reboot']);
const sha256 = s => createHash('sha256').update(s).digest('hex');
const ipv4 = s => typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(n => +n <= 255);

// Comparable subset of wan_info.info.details; used for drift detection and restore.
export function wanConfig(details) {
  if (!details || typeof details !== 'object') return null;
  const d = details; const out = { wanType: d.wanType };
  if (d.wanType === 'static') Object.assign(out, { ipaddr: d.ipaddr, netmask: d.netmask, gateway: d.gateway, dns: Array.isArray(d.dns) ? d.dns.slice(0, 2) : [] });
  else if (d.wanType === 'dhcp') Object.assign(out, { peerdns: String(d.peerdns ?? '1'), dns: d.peerdns === '0' && Array.isArray(d.dns) ? d.dns.slice(0, 2) : [] });
  else if (d.wanType === 'pppoe') Object.assign(out, { username: d.username, password: d.password, special: String(d.special ?? '1'), peerdns: String(d.peerdns ?? '1'), mtu: String(d.mtu ?? ''), dns: d.peerdns === '0' && Array.isArray(d.dns) ? d.dns.slice(0, 2) : [] });
  return out;
}
export function wanDiff(baseline, current) {
  if (!baseline || !current) return [];
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  return [...keys].filter(k => JSON.stringify(baseline[k] ?? null) !== JSON.stringify(current[k] ?? null)).map(k => ({ field: k, baseline: k === 'password' ? '[SECRET]' : baseline[k] ?? null, current: k === 'password' ? '[SECRET]' : current[k] ?? null }));
}
// Map saved details back to set_wan form fields (doc §8 "修复工具提示").
export function setWanParams(c) {
  if (c.wanType === 'static') {
    if (![c.ipaddr, c.netmask, c.gateway, c.dns?.[0]].every(ipv4)) throw Error('静态 WAN 基线不完整，拒绝写入');
    return { wanType: 'static', staticIp: c.ipaddr, staticMask: c.netmask, staticGateway: c.gateway, dns1: c.dns[0], ...(ipv4(c.dns[1]) ? { dns2: c.dns[1] } : {}) };
  }
  if (c.wanType === 'dhcp') return c.peerdns === '0' && ipv4(c.dns?.[0]) ? { wanType: 'dhcp', autoset: '0', dns1: c.dns[0], ...(ipv4(c.dns[1]) ? { dns2: c.dns[1] } : {}) } : { wanType: 'dhcp', autoset: '1' };
  if (c.wanType === 'pppoe') {
    if (!c.username || typeof c.password !== 'string') throw Error('PPPoE 基线缺少账号，拒绝写入');
    const manual = c.peerdns === '0' || (c.mtu && c.mtu !== '1480');
    return { wanType: 'pppoe', pppoeName: c.username, pppoePwd: c.password, special: c.special || '1', autoset: manual ? '0' : '1', ...(manual ? { mtu: c.mtu || '1480', ...(ipv4(c.dns?.[0]) ? { dns1: c.dns[0] } : {}), ...(ipv4(c.dns?.[1]) ? { dns2: c.dns[1] } : {}) } : {}) };
  }
  throw Error(`未知 WAN 类型 ${c.wanType}`);
}

export class RouterClient {
  constructor(store, fetcher = fetch) { this.store = store; this.fetcher = fetcher; this.token = null; this.lastNonce = 0; this.lockedReason = null; this.lastStatus = null; this.inflight = null; }
  get cfg() { return this.store.config.router; }
  get enabled() { return Boolean(this.cfg.enabled && this.cfg.password); }
  unlock() { this.lockedReason = null; }
  async http(path, { method = 'GET', params, timeoutMs = this.cfg.timeoutMs, signal } = {}) {
    const q = new URLSearchParams(params || {}).toString();
    const url = `${this.cfg.host}${path}${method === 'GET' && q ? `?${q}` : ''}`;
    const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const res = await this.fetcher(url, { method, signal: s, redirect: 'manual', headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}, body: method === 'POST' ? q : undefined });
    const text = await res.text();
    return { status: res.status, text };
  }
  // Single-flight: parallel API calls must share one login (nonce timestamps must strictly increase,
  // and a newer token invalidates the older one).
  login(signal) {
    if (!this.loginPending) this.loginPending = this.doLogin(signal).finally(() => { this.loginPending = null; });
    return this.loginPending;
  }
  async doLogin(signal) {
    // A wrong password is not retried: the router locks the account after a few failures.
    if (this.lockedReason) throw Error(`路由器登录已暂停：${this.lockedReason}。修改路由器密码设置后自动解除`);
    const page = await this.http('/cgi-bin/luci/web', { signal });
    const key = page.text.match(/key:\s*'([0-9a-f]+)'/)?.[1]; const deviceId = page.text.match(/deviceId\s*=\s*'([^']+)'/)?.[1];
    if (!key || !deviceId) throw Error('无法从路由器登录页解析 key/deviceId（可能未初始化或不是小米路由器）');
    let ts = Math.floor(Date.now() / 1000);
    if (ts <= this.lastNonce) { await sleep((this.lastNonce + 1 - ts) * 1000 + 50, undefined, { signal }); ts = this.lastNonce + 1; }
    this.lastNonce = ts;
    const nonce = `0_${deviceId}_${ts}_${Math.floor(Math.random() * 10000)}`;
    const r = await this.http('/cgi-bin/luci/api/xqsystem/login', { method: 'POST', signal, params: { username: 'admin', password: sha256(nonce + sha256(this.cfg.password + key)), logtype: '2', nonce } });
    let j; try { j = JSON.parse(r.text); } catch { throw Error(`路由器登录返回非 JSON（HTTP ${r.status}）`); }
    if (j.code !== 0 || !j.token) { this.lockedReason = `登录失败 code=${j.code} ${j.msg || ''}`.trim(); this.store.log('router', '路由器登录失败，已停止重试以免锁定', { code: j.code, msg: j.msg }); throw Error(this.lockedReason); }
    this.token = j.token; return j.token;
  }
  async call(api, { method = 'GET', params, timeoutMs, signal } = {}) {
    if (!this.enabled) throw Error('未启用路由器管理或未配置管理密码');
    if (!READ_APIS.has(api) && !WRITE_APIS.has(api)) throw Error(`接口 ${api} 不在网管允许范围内`);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.token) await this.login(signal);
      const used = this.token;
      const r = await this.http(`/cgi-bin/luci/;stok=${used}/api/${api}`, { method, params, timeoutMs, signal });
      if (r.status === 404) throw Error(`路由器未注册接口 ${api}`);
      let j; try { j = JSON.parse(r.text); } catch { throw Error(`路由器 ${api} 返回非 JSON（HTTP ${r.status}）`); }
      if (j.code === 401) { if (this.token === used) this.token = null; continue; }
      return j;
    }
    throw Error('路由器令牌连续失效');
  }
  // One consolidated status read. Never throws: unreachable router is itself evidence.
  status({ maxAgeMs = 0, signal } = {}) {
    if (!this.enabled) return Promise.resolve({ enabled: false });
    // maxAgeMs=0 means never reuse, even within the same millisecond.
    if (maxAgeMs > 0 && this.lastStatus && Date.now() - this.lastStatus.atMs <= maxAgeMs) return Promise.resolve(this.lastStatus);
    if (this.inflight) return this.inflight;
    const start = Date.now();
    this.inflight = (async () => {
      try {
        const [wan, link, conn] = await Promise.all(['xqnetwork/wan_info', 'xqnetwork/wan_link', 'xqnetwork/pppoe_status'].map(api => this.call(api, { signal })));
        const info = wan.info || {};
        let speedSetting; try { const sp = await this.call('xqnetwork/wan_speed', { signal }); if (sp.code === 0 && sp.speed !== undefined) speedSetting = String(sp.speed); } catch {}
        return { enabled: true, reachable: true, atMs: Date.now(), at: new Date().toISOString(), ms: Date.now() - start,
          wan: { type: info.details?.wanType, mac: (info.mac || '').toUpperCase(), link: link.link ?? info.link, status: conn.status, connected: conn.status === 2 && info.status === 1, ip: conn.ip?.address || info.ipv4?.[0]?.ip || '', gateway: conn.gw || info.gateWay || '', dns: Array.isArray(conn.dns) ? conn.dns : [], speed: conn.wanSpeed, uptime: info.uptime, error: conn.code && conn.code !== 0 ? { code: conn.code, msg: conn.msg, errcode: conn.errcode } : null },
          config: info.details ? { ...wanConfig(info.details), ...(speedSetting !== undefined ? { speedSetting } : {}) } : null };
      } catch (e) {
        const authLocked = Boolean(this.lockedReason);
        return { enabled: true, reachable: authLocked, authError: authLocked ? e.message : undefined, error: e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message, atMs: Date.now(), at: new Date().toISOString(), ms: Date.now() - start };
      }
    })().then(s => { this.lastStatus = s; return s; }).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async setWan(config, signal) {
    const params = setWanParams(config);
    const j = await this.call('xqnetwork/set_wan', { method: 'POST', params, signal, timeoutMs: 15000 });
    if (j.code !== 0) throw Error(`set_wan 被拒绝 code=${j.code} ${j.msg || ''}`);
    return j;
  }
  async readWanConfig(signal) {
    const [j, sp] = await Promise.all([this.call('xqnetwork/wan_info', { signal }), this.call('xqnetwork/wan_speed', { signal }).catch(() => null)]);
    const c = wanConfig(j.info?.details); if (c && sp?.code === 0 && sp.speed !== undefined) c.speedSetting = String(sp.speed); return c;
  }
  async setWanSpeed(value, signal) {
    if (!['0', '100', '1000', '2500'].includes(String(value))) throw Error('WAN 速率值无效');
    const j = await this.call('xqnetwork/set_wan_speed', { method: 'POST', params: { speed: String(value) }, signal, timeoutMs: 15000 });
    if (j.code !== 0) throw Error(`set_wan_speed 被拒绝 code=${j.code} ${j.msg || ''}`); return j;
  }
  // Apply only the parts that differ: WAN form (set_wan) and/or the negotiated-speed setting.
  async applyConfig(target, current, signal) {
    const diff = wanDiff(current, target); const applied = [];
    if (diff.some(d => d.field !== 'speedSetting')) { await this.setWan(target, signal); applied.push('set_wan'); }
    if (diff.some(d => d.field === 'speedSetting') && target.speedSetting !== undefined) { await this.setWanSpeed(target.speedSetting, signal); applied.push('set_wan_speed'); }
    return applied;
  }
  async currentMac(signal) { const j = await this.call('xqnetwork/wan_info', { signal }); return (j.info?.mac || '').toUpperCase(); }
  async macClone(mac, signal) {
    const cur = await this.currentMac(signal);
    if (cur === mac.toUpperCase()) return { code: 0, skipped: 'WAN MAC 已是目标值' };
    const j = await this.call('xqnetwork/mac_clone', { params: { mac }, signal, timeoutMs: 15000 });
    if (j.code !== 0) throw Error(`mac_clone 被拒绝 code=${j.code} ${j.msg || ''}`);
    this.lastStatus = null; return j;
  }
  async reboot(signal) { const j = await this.call('xqsystem/reboot', { params: { client: 'web' }, signal }); this.token = null; this.lastStatus = null; return j; }
  // Wait until the admin API answers again and WAN reports connected (or deadline).
  async waitReady(deadlineMs, signal) {
    const trace = []; const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
      signal?.throwIfAborted();
      this.lastStatus = null; const s = await this.status({ signal });
      trace.push({ t: s.at, reachable: s.reachable, link: s.wan?.link, status: s.wan?.status });
      if (s.reachable && s.wan?.connected) return { ready: true, trace };
      await sleep(3000, undefined, { signal });
    }
    return { ready: false, trace };
  }
}
