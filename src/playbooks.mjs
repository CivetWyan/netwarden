import { SIGNALS, ACTION_INFO } from './triage.mjs';

// Declarative learned remediation: "when these signals appear, try these whitelisted actions in this
// order". Produced by the online review; candidate until it fixes a real incident, then active.
export class Playbooks {
  constructor(app) { this.app = app; this.items = app.store.read('playbooks.json', []); }
  persist() { this.app.store.write('playbooks.json', this.items.slice(-200)); this.app.emit?.('change'); }
  create(candidate, { reviewId, incidentId, observed } = {}) {
    if (!candidate || typeof candidate !== 'object') throw Error('方案格式无效');
    const signals = [...new Set(Array.isArray(candidate.signals) ? candidate.signals : [])];
    const actions = [...new Set(Array.isArray(candidate.actions) ? candidate.actions : [])];
    if (!signals.length || signals.length > 8 || signals.some(s => !SIGNALS.includes(s))) throw Error(`signals 必须取自固定词表：${JSON.stringify(signals)}`);
    if (!actions.length || actions.length > 4 || actions.some(a => !Object.hasOwn(ACTION_INFO, a))) throw Error(`actions 必须是白名单动作：${JSON.stringify(actions)}`);
    // A playbook may only match on what was actually observed in its source incident.
    if (Array.isArray(observed)) { const extra = signals.filter(s => !observed.includes(s)); if (extra.length) throw Error(`signals 含本次故障未出现的信号：${extra.join(', ')}`); }
    if (actions.indexOf('router_reboot') >= 0 && actions.indexOf('router_reboot') !== actions.length - 1) throw Error('router_reboot 只能放在最后');
    const kind = typeof candidate.kind === 'string' ? candidate.kind.slice(0, 40) : null;
    const same = this.items.find(p => p.kind === kind && JSON.stringify([...p.signals].sort()) === JSON.stringify([...signals].sort()) && JSON.stringify(p.actions) === JSON.stringify(actions) && p.state !== 'disabled');
    if (same) { same.sources.push({ reviewId, incidentId }); same.updatedAt = new Date().toISOString(); this.persist(); return same; }
    const item = { id: crypto.randomUUID(), kind, signals, actions, rationale: String(candidate.rationale || '').slice(0, 1000), state: 'candidate', successes: 0, failures: 0, sources: [{ reviewId, incidentId }], at: new Date().toISOString() };
    this.items.push(item); this.persist(); this.app.store.log('playbook', '在线复盘生成候选修复方案', { id: item.id, signals, actions }); return item;
  }
  // Most specific applicable playbook; active ones win over candidates.
  match(card) {
    const rank = p => (p.state === 'active' ? 100 : 0) + p.signals.length * 5 + p.successes - p.failures * 3;
    return this.items.filter(p => p.state !== 'disabled' && (!p.kind || p.kind === card.kind) && p.signals.every(s => card.signals.includes(s))).sort((a, b) => rank(b) - rank(a))[0] || null;
  }
  record(id, { success, action, incidentId }) {
    const p = this.items.find(x => x.id === id); if (!p) return null;
    if (success && p.actions.includes(action)) { p.successes++; if (p.state === 'candidate') { p.state = 'active'; this.app.store.log('playbook', '候选方案在真实故障中验证通过，已启用', { id, action, incidentId }); } }
    else if (!success) { p.failures++; if (p.failures >= 2 && p.failures > p.successes) { p.state = 'disabled'; this.app.store.log('playbook', '方案多次未能修复，已停用', { id }); } }
    p.lastUsed = { at: new Date().toISOString(), incidentId, success, action }; this.persist(); return p;
  }
  setState(id, state) { const p = this.items.find(x => x.id === id); if (!p) throw Error('方案不存在'); if (!['candidate', 'active', 'disabled'].includes(state)) throw Error('状态无效'); p.state = state; this.persist(); return p; }
}
