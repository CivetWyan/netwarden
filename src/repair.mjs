import { setTimeout as sleep } from 'node:timers/promises';
import { wanDiff } from './router.mjs';

export const LOCAL_ACTIONS = ['flush_dns', 'renew_dhcp', 'reconnect', 'set_dns'];
export const ROUTER_ACTIONS = ['router_restore_wan', 'router_reconnect_wan', 'router_change_identity', 'router_reboot'];
export const ACTIONS = [...LOCAL_ACTIONS, ...ROUTER_ACTIONS];
export class Repair {
  constructor(store, platform, sensor, router = null, app = null) {
    this.store = store; this.platform = platform; this.sensor = sensor; this.router = router; this.app = app; this.busy = false;
    this.attempts = new Map(store.read('repair-attempts.json', [])); this.rollback = store.read('rollback.json', null); this.routerRollback = store.read('router-rollback.json', null);
  }
  async recoverPending() {
    if (this.rollback) { this.store.log('rollback', '发现上次未完成的 DNS 事务，优先恢复原配置', this.rollback); await this.restore(); }
    // An interrupted router write is NOT blindly reverted at startup: the pre-action config was the
    // broken one. Keep it on record for the operator and let fresh triage decide.
    if (this.routerRollback) {
      this.store.log('rollback', '发现上次中断的路由器 WAN 事务；动作前配置已记录，不自动写回（重新分诊决定）', { action: this.routerRollback.action, createdAt: this.routerRollback.createdAt, before: this.routerRollback.before });
      this.routerRollback = null; this.store.write('router-rollback.json', null);
    }
  }
  async restore() {
    if (!this.rollback) return { ok: true, skipped: true };
    const transaction = this.rollback;
    const result = await this.platform.repair('restore_dns', transaction.connection, transaction.servers);
    this.store.log('rollback', result.ok ? 'DNS 原配置已恢复' : 'DNS 回滚失败；保留事务供重试', result);
    if (result.ok) { this.rollback = null; this.store.write('rollback.json', null); }
    this.sensor.invalidate(); return result;
  }
  // Router actions return {ok, ...}; they never throw for an expected router refusal.
  async routerAction(action, signal) {
    const router = this.router; const cfg = this.store.config.router;
    if (!router?.enabled) return { ok: false, blocked: true, error: '未启用路由器管理' };
    if (action === 'router_reboot') {
      const j = await router.reboot(signal);
      const ready = await router.waitReady(cfg.rebootWaitMs, signal);
      return { ok: j.code === 0 && ready.ready, code: j.code, readyTrace: ready.trace.slice(-8), error: ready.ready ? undefined : '路由器重启后在等待时间内未恢复 WAN' };
    }
    if (action === 'router_change_identity') return this.identityAction(signal);
    const before = await router.readWanConfig(signal);
    if (!before) return { ok: false, error: '无法读取路由器当前 WAN 配置' };
    const target = action === 'router_restore_wan' ? this.app?.routerBaseline?.config : before;
    if (!target) return { ok: false, blocked: true, error: '没有健康 WAN 基线可恢复' };
    if (action === 'router_restore_wan' && !wanDiff(target, before).length) return { ok: false, blocked: true, error: '当前 WAN 配置已与健康基线一致，恢复不会改变任何内容' };
    this.routerRollback = { action, before, createdAt: new Date().toISOString() }; this.store.write('router-rollback.json', this.routerRollback);
    let applied;
    if (action === 'router_reconnect_wan') { await router.setWan(target, signal); applied = ['set_wan']; }
    else applied = await router.applyConfig(target, before, signal);
    // The router answers code 0 even when a value did not apply; read back before trusting it.
    let after = null; for (let i = 0; i < 3 && !after; i++) { await sleep(1000, undefined, { signal }); try { after = await router.readWanConfig(signal); } catch {} }
    const mismatch = after ? wanDiff(target, after) : [{ field: 'readback', baseline: 'expected', current: 'unreadable' }];
    return { ok: !mismatch.length, applied, changed: wanDiff(before, target), readbackMismatch: mismatch, error: mismatch.length ? '写入后读回与目标配置不一致' : undefined };
  }
  async identityAction(signal) {
    const router = this.router; const identity = this.app?.identity;
    if (!identity) return { ok: false, blocked: true, error: '未启用身份轮换' };
    const before = await router.readWanConfig(signal);
    if (before?.wanType !== 'static') return { ok: false, blocked: true, error: '仅在静态 IP 的 WAN 上更换身份' };
    const beforeMac = await router.currentMac(signal);
    const freeIp = await identity.chooseFreeIp(before, signal);
    if (!freeIp) return { ok: false, blocked: true, error: '同网段没有找到可用的空闲 IP（名单用尽或都在占用）' };
    const newMac = (await import('./identity.mjs')).randomMac([beforeMac, ...identity.bannedMacs()]);
    const target = { ...before, ipaddr: freeIp };
    this.routerRollback = { action: 'router_change_identity', before: { config: before, mac: beforeMac }, createdAt: new Date().toISOString() };
    this.store.write('router-rollback.json', this.routerRollback);
    await router.macClone(newMac, signal);
    await router.setWan(target, signal);
    let after = null; for (let i = 0; i < 3 && !after; i++) { await sleep(1500, undefined, { signal }); try { after = await router.readWanConfig(signal); } catch {} }
    const afterMac = await router.currentMac(signal).catch(() => '');
    const mismatch = after ? wanDiff(target, after) : [{ field: 'readback', current: 'unreadable' }];
    return { ok: !mismatch.length && afterMac === newMac.toUpperCase(), applied: ['mac_clone', 'set_wan'], changed: { ip: [before.ipaddr, freeIp], mac: [beforeMac, newMac] }, readbackMismatch: mismatch, error: mismatch.length ? '写入后读回与目标不一致' : afterMac !== newMac.toUpperCase() ? 'MAC 未生效' : undefined };
  }
  async revertRouter(signal) {
    if (!this.routerRollback) return null;
    const { before, action } = this.routerRollback;
    try {
      if (action === 'router_restore_wan') { const now = await this.router.readWanConfig(signal); await this.router.applyConfig(before, now, signal); this.store.log('rollback', '路由器 WAN 恢复未通过验证，已写回动作前配置', {}); }
      else if (action === 'router_change_identity') { await this.router.macClone(before.mac, signal); await this.router.setWan(before.config, signal); this.store.log('rollback', '身份更换未通过验证，已换回原 MAC 与原 IP', {}); }
      this.routerRollback = null; this.store.write('router-rollback.json', null); return { ok: true };
    } catch (e) { this.store.log('rollback', '路由器 WAN 回滚失败，保留事务', { error: e.message }); return { ok: false, error: e.message }; }
  }
  async execute(action, reason, { signal, incidentId = 'manual' } = {}) {
    if (!ACTIONS.includes(action)) throw Error('动作不在恢复白名单中');
    if (!this.store.config.repair.enabled) return { ok: false, blocked: true, error: '当前为只诊断模式，请先开启自动修复' };
    if (this.externalBlock?.()) return { ok: false, blocked: true, error: '存在未确认结束的中断脚本进程，暂缓修改网络' };
    if (this.busy) return { ok: false, blocked: true, error: '另一个恢复动作正在执行' };
    this.busy = true; const started = Date.now(); const isRouter = ROUTER_ACTIONS.includes(action);
    try {
      signal?.throwIfAborted();
      const evidence = await this.sensor.sample({ fresh: true });
      this.store.log('evidence', '动作前重新采集现场', { incidentId, action, snapshot: evidence });
      signal?.throwIfAborted();
      const config = this.store.config.repair; const rc = this.store.config.router;
      if (!config.enabled) return { ok: false, blocked: true, error: '采集现场期间已关闭自动修复，取消本次动作' };
      if (evidence.health.severity !== 'offline') return { ok: false, blocked: true, error: '当前未确认离线，拒绝修改网络', health: evidence.health };
      const key = `${incidentId}:${action}`;
      if (this.attempts.has(key)) return { ok: false, blocked: true, error: '本轮此动作已尝试；请根据已记录的执行结果和新现场重新诊断' };
      if ([...this.attempts.keys()].filter(k => k.startsWith(`${incidentId}:`)).length >= config.maxActions) return { ok: false, blocked: true, error: '本轮修复动作预算已耗尽' };
      const current = evidence.network.connection;
      const baseline = this.store.baseline?.network?.connection;
      const connection = current || (['link_down', 'no_route'].includes(evidence.health.kind) ? baseline : null);
      if (action === 'renew_dhcp' && (!config.allowDhcp || connection?.method !== 'auto')) return { ok: false, blocked: true, error: 'DHCP 续租未授权或该连接不是自动地址配置' };
      if (action === 'reconnect' && !config.allowReconnect) return { ok: false, blocked: true, error: '重连未授权' };
      if (action === 'set_dns' && (!config.allowDnsChange || evidence.health.kind !== 'dns_failure' || !current || !Array.isArray(current.dns))) return { ok: false, blocked: true, error: '仅允许在明确 DNS 故障、原配置完整且已授权时替换 DNS' };
      if (action === 'router_restore_wan' && !rc.allowRestore) return { ok: false, blocked: true, error: '路由器配置回滚未授权' };
      if (action === 'router_reconnect_wan' && !rc.allowReconnect) return { ok: false, blocked: true, error: '路由器 WAN 重连未授权' };
      if (action === 'router_change_identity' && !rc.allowIdentityChange) return { ok: false, blocked: true, error: '更换 WAN 身份未授权' };
      if (action === 'router_reboot' && !rc.allowReboot) return { ok: false, blocked: true, error: '路由器重启未授权' };
      if (isRouter && (!evidence.router?.reachable || evidence.router.authError)) return { ok: false, blocked: true, error: `路由器管理接口不可用：${evidence.router?.authError || evidence.router?.error || '未启用'}` };
      if (this.rollback) return { ok: false, blocked: true, error: '有尚未恢复的 DNS 事务；先处理回滚' };
      this.attempts.set(key, Date.now()); if (this.attempts.size > 200) this.attempts.delete(this.attempts.keys().next().value);
      this.store.write('repair-attempts.json', [...this.attempts.entries()]);
      if (action === 'set_dns') {
        this.rollback = { connection: current, servers: current.dns, createdAt: new Date().toISOString(), incidentId };
        this.store.write('rollback.json', this.rollback); // Durable journal BEFORE any mutation.
      }
      this.store.log('action', `执行 ${action}`, { incidentId, reason: String(reason).slice(0, 2000), ...(isRouter ? {} : { connection }) });
      let result;
      try { result = isRouter ? await this.routerAction(action, signal) : await this.platform.repair(action, connection, config.fallbackDns, signal); }
      catch (e) { if (signal?.aborted) throw e; result = { ok: false, error: e.message }; }
      this.store.log('action_result', `${action} ${result.ok ? '命令完成，等待验证' : '命令失败'}`, { incidentId, result });
      if (!result.ok) {
        if (this.rollback) await this.restore();
        if (isRouter) await this.revertRouter(signal);
        return { ok: false, result, error: result.error || '执行失败；查看退出码、权限提示与 stderr', permission: /auth|permission|not authorized|password is required|权限/i.test(`${result.stderr || ''} ${result.error || ''}`) || undefined, ms: Date.now() - started };
      }
      let verified = false; const samples = [];
      // WAN speed renegotiation takes ~32 s (measured); PPPoE redial up to ~43 s.
      const window = action === 'set_dns' ? config.rollbackMs : isRouter ? (action === 'router_reconnect_wan' || result.applied?.includes('set_wan_speed') ? 60000 : 30000) : Math.max(config.verifyDelayMs * 2, 7000);
      const deadline = Date.now() + window;
      do {
        await sleep(config.verifyDelayMs, undefined, { signal }); this.sensor.invalidate();
        const s = await this.sensor.sample({ fresh: true }); samples.push({ at: s.at, health: s.health });
        this.store.log('verification', '修复后的独立验证', { incidentId, action, snapshot: s });
        verified = samples.length >= this.store.config.monitor.recoveryThreshold && samples.slice(-this.store.config.monitor.recoveryThreshold).every(s => s.health.kind === 'healthy');
        if (verified || (!isRouter && s.health.severity === 'degraded')) break;
      } while (Date.now() < deadline);
      if (this.rollback) {
        if (verified) { this.rollback = null; this.store.write('rollback.json', null); this.store.log('rollback', 'DNS 替换经连续验证通过，提交事务'); }
        else await this.restore();
      }
      if (isRouter) {
        if (verified) {
          if (action === 'router_change_identity' && result.changed) { this.app?.identity?.markBanned({ ip: result.changed.ip[0], mac: result.changed.mac[0], incidentId }); this.store.log('router', '身份更换成功，旧 IP/MAC 记为疑似被封', { old: { ip: result.changed.ip[0], mac: result.changed.mac[0] }, new: { ip: result.changed.ip[1], mac: result.changed.mac[1] } }); }
          this.routerRollback = null; this.store.write('router-rollback.json', null);
        } else await this.revertRouter(signal);
      }
      return { ok: verified, commandOk: true, verified, result, samples, ms: Date.now() - started, error: verified ? undefined : '命令已完成，但未通过连续连通性验证；需继续分析日志' };
    } catch (e) {
      if (this.rollback) await this.restore();
      if (this.routerRollback && !signal?.aborted) await this.revertRouter();
      this.store.log('error', '恢复动作中止', { action, error: e.message });
      return { ok: false, error: e.message, cancelled: Boolean(signal?.aborted), ms: Date.now() - started };
    } finally { this.busy = false; }
  }
}
