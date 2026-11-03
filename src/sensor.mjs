import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { tcpProbe, dnsProbe, dnsCanary, httpProbe, gatewayProbe, classify } from './probes.mjs';

export class Sensor extends EventEmitter {
  constructor(store, platform, probes = {}) {
    super(); this.store = store; this.platform = platform;
    this.probes = { tcp: tcpProbe, dns: dnsProbe, canary: dnsCanary, http: httpProbe, gateway: gatewayProbe, ...probes };
    this.current = null; this.history = []; this.running = false; this.pending = null; this.failures = 0; this.recoveries = 0; this.stable = 'unknown'; this.lastInventory = 0;
  }
  sample({ fresh = false } = {}) {
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    this.pending = this.collect(fresh, this.controller.signal).finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect(fresh, signal) {
    const start = performance.now(); const c = this.store.config.monitor;
    const inspect = fresh || !this.inventory || Date.now() - this.lastInventory > 10000;
    const inventoryPromise = inspect ? this.platform.inspect(signal).then(n => { this.inventory = n; this.lastInventory = Date.now(); return n; }) : Promise.resolve(this.inventory);
    const routerMaxAge = fresh ? 0 : this.current?.health.severity === 'healthy' ? this.store.config.router.pollMs : 0;
    const [network, tcp, dns, http, gateway, router] = await Promise.all([
      inventoryPromise,
      Promise.all(c.tcpTargets.map(t => this.probes.tcp(t.host, t.port, c.probeTimeoutMs, signal))),
      Promise.all([...c.dnsHosts.map(h => this.probes.dns(h, c.probeTimeoutMs, signal)), ...(c.dnsCanary ? [this.probes.canary(c.dnsCanary, c.probeTimeoutMs, signal)] : [])]),
      this.probes.http(c.httpUrl, c.probeTimeoutMs, signal),
      inventoryPromise.then(n => this.probes.gateway(n.route?.gateway, c.probeTimeoutMs, signal, this.platform.platform, this.platform.run)),
      this.router ? this.router.status({ maxAgeMs: routerMaxAge, signal }) : Promise.resolve(undefined)
    ]);
    if (signal.aborted) throw Error('感知已取消');
    const snapshot = { id: crypto.randomUUID(), at: new Date().toISOString(), network, tcp, dns, http, gateway, ...(router ? { router } : {}), durationMs: Math.round(performance.now() - start) };
    snapshot.health = classify(snapshot);
    // Invalidate inventory immediately on failure; don't wait for the slow refresh interval.
    if (snapshot.health.severity !== 'healthy') this.lastInventory = 0;
    const offline = snapshot.health.severity === 'offline';
    this.failures = offline ? this.failures + 1 : 0; this.recoveries = snapshot.health.kind === 'healthy' ? this.recoveries + 1 : 0;
    const prev = this.stable;
    if (this.failures >= c.failureThreshold) this.stable = 'offline';
    else if (this.recoveries >= c.recoveryThreshold) this.stable = 'healthy';
    else if (!offline && snapshot.health.severity === 'degraded') this.stable = 'degraded';
    snapshot.stable = this.stable; this.current = snapshot;
    this.history.push({ at: snapshot.at, severity: snapshot.health.severity, kind: snapshot.health.kind, ms: tcp.find(p => p.ok)?.ms ?? null }); this.history = this.history.slice(-120);
    this.emit('sample', snapshot);
    if (prev !== this.stable) { this.store.log('state', `${prev} → ${this.stable}`, snapshot); this.emit('transition', snapshot); }
    return snapshot;
  }
  start() { if (this.running) return; this.running = true; this.tick(); }
  async tick() {
    if (!this.running) return;
    const start = Date.now();
    if (this.store.config.monitor.enabled) try { await this.sample(); } catch (e) { if (this.running) this.store.log('error', '网络感知失败', { error: e.message }); }
    if (this.running) this.timer = setTimeout(() => this.tick(), Math.max(50, this.store.config.monitor.intervalMs - (Date.now() - start)));
  }
  stop() { this.running = false; clearTimeout(this.timer); this.controller?.abort(); }
  invalidate() { this.lastInventory = 0; }
  statistics() {
    const values = this.history.map(s => s.ms).filter(Number.isFinite).sort((a,b) => a-b);
    return { samples: this.history.length, healthySamples: this.history.filter(s => s.severity === 'healthy').length, reachableSamples: values.length,
      latencyMs: values.length ? { min: values[0], average: Math.round(values.reduce((a,b)=>a+b,0)/values.length), p95: values[Math.min(values.length-1,Math.ceil(values.length*.95)-1)], max: values.at(-1) } : null,
      from: this.history[0]?.at, to: this.history.at(-1)?.at };
  }
}
