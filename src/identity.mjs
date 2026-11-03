import { randomBytes, randomInt } from 'node:crypto';
import { gatewayProbe } from './probes.mjs';

// WAN identity rotation. Context: the campus network operator (property management) sanctions changing
// the router's WAN IP and MAC as the recovery method when a stale ban policy blocks this router. This
// module picks a new MAC and a same-subnet IP that does not answer ping, so a change is unlikely to
// collide with another tenant; occupancy can only be checked weakly, so repair verifies and reverts.
const ip2n = ip => ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
const n2ip = n => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');
export const isIPv4 = s => typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(x => +x <= 255);
export const isMac = s => typeof s === 'string' && /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(s);

export function randomMac(exclude = []) {
  const taken = new Set(exclude.filter(isMac).map(m => m.toUpperCase()));
  for (let i = 0; i < 100; i++) {
    const b = randomBytes(6); b[0] = (b[0] & 0xfc) | 0x02; // locally-administered, unicast
    const mac = [...b].map(x => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
    if (!taken.has(mac)) return mac;
  }
  throw Error('无法生成新 MAC');
}
export function subnetRange(ip, mask) {
  const m = ip2n(mask); const net = (ip2n(ip) & m) >>> 0; const bcast = (net | (~m >>> 0)) >>> 0;
  return { first: net + 1, last: bcast - 1, size: Math.max(0, bcast - net - 1), contains: x => isIPv4(x) && ((ip2n(x) & m) >>> 0) === net };
}
// Preferred IPs (in order) first, then random same-subnet hosts; never a skipped address.
export function pickCandidates(cfg, { skip = [], preferred = [], count = 6 } = {}) {
  if (cfg?.wanType !== 'static' || !isIPv4(cfg.ipaddr) || !isIPv4(cfg.netmask)) return [];
  const r = subnetRange(cfg.ipaddr, cfg.netmask); const skipSet = new Set([cfg.ipaddr, cfg.gateway, ...skip]);
  const out = preferred.filter(ip => r.contains(ip) && !skipSet.has(ip));
  for (let tries = 0; out.length < preferred.length + count && tries < count * 40 && r.size > 2; tries++) {
    const ip = n2ip(r.first + randomInt(r.size)); if (!skipSet.has(ip) && !out.includes(ip)) out.push(ip);
  }
  return out;
}
export class Identity {
  constructor(app) { this.app = app; this.state = { banned: [], occupied: {}, witnesses: [], lastLearn: 0, ...app.store.read('identity.json', {}) }; this.learning = false; }
  save() { this.app.store.write('identity.json', this.state); }
  ping(ip, signal) { const probe = this.app.sensor.probes.upstream || gatewayProbe; return probe(ip, 1000, signal, this.app.platform.platform, this.app.platform.run).then(x => Boolean(x.ok)).catch(() => false); }
  bannedIps() { return this.state.banned.map(b => b.ip).filter(isIPv4); }
  bannedMacs() { return this.state.banned.map(b => b.mac).filter(isMac); }
  recentlyOccupied(days = 7) { const since = Date.now() - days * 86400000; return Object.entries(this.state.occupied).filter(([, at]) => at >= since).map(([ip]) => ip); }
  markOccupied(ip) { if (isIPv4(ip)) { this.state.occupied[ip] = Date.now(); this.save(); } }
  markBanned(entry) { this.state.banned.push({ ...entry, at: new Date().toISOString() }); this.state.banned = this.state.banned.slice(-20); this.save(); }
  // During healthy time: a few pings (never a full sweep — that reads as scanning) to learn live
  // neighbours. They serve as "is the WAN segment itself reachable?" witnesses and as occupied IPs.
  async learn(cfg, signal) {
    if (this.learning || cfg?.wanType !== 'static' || !isIPv4(cfg.ipaddr)) return;
    this.learning = true;
    try {
      const found = [];
      for (const ip of pickCandidates(cfg, { count: 8 })) { if (await this.ping(ip, signal)) { this.state.occupied[ip] = Date.now(); found.push(ip); } }
      if (found.length) this.state.witnesses = [...new Set([...found, ...this.state.witnesses])].slice(0, 5);
      this.state.lastLearn = Date.now(); this.save();
      this.app.store.log('router', 'WAN 网段邻居采样', { found: found.length, witnesses: this.state.witnesses.length });
    } finally { this.learning = false; }
  }
  // true = a known neighbour still answers (segment alive, only we are blocked → suspected ban);
  // false = none answer (whole segment down); null = no witnesses learned yet (cannot tell).
  async witnessAlive(signal) {
    const ws = this.state.witnesses.slice(0, 3); if (!ws.length) return null;
    const res = await Promise.all(ws.map(ip => this.ping(ip, signal))); return res.some(Boolean);
  }
  // A new MAC and a same-subnet IP that does not answer ping. Returns null if none found.
  async chooseFreeIp(cfg, signal) {
    const c = this.app.store.config.router;
    const skip = [...this.bannedIps(), ...this.recentlyOccupied()];
    for (const ip of pickCandidates(cfg, { skip, preferred: c.identityIps || [], count: c.identityProbeCount })) {
      signal?.throwIfAborted();
      if (await this.ping(ip, signal)) { this.markOccupied(ip); continue; } // answered → in use
      return ip;
    }
    return null;
  }
}
