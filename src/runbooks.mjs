export class Runbooks {
  constructor(app) { this.app = app; this.items = app.store.read('runbooks.json', []); }
  persist() { this.app.store.write('runbooks.json', this.items); }
  create(candidate, reviewId) {
    if (!candidate || typeof candidate.title !== 'string' || candidate.title.length > 200 || typeof candidate.description !== 'string' || candidate.description.length > 3000) throw Error('长期方案格式无效');
    const match = candidate.match || {};
    if (!['dns_failure', 'no_route', 'link_down', 'upstream_failure', 'partial_failure', 'lan_failure', 'wan_link_down', 'wan_down', 'healthy'].includes(match.kind) || !['linux', 'darwin', 'win32'].includes(match.platform)) throw Error('长期方案必须声明故障类型和单个平台');
    const rollback = candidate.rollback ? this.app.scripts.create({ ...candidate.rollback, title: `${candidate.title} · 回滚`, purpose: 'rollback', platforms: [match.platform] }, { reviewId }) : null;
    const scripts = [];
    for (const purpose of ['diagnostic', 'repair', 'verify']) if (candidate[purpose]) scripts.push(this.app.scripts.create({ ...candidate[purpose], title: `${candidate.title} · ${purpose}`, purpose, platforms: [match.platform], rollbackId: purpose === 'repair' ? rollback?.id : null }, { reviewId }));
    if (!scripts.length) throw Error('长期方案至少需要一个脚本');
    const previous = this.items.findLast(r => r.title === candidate.title && r.match.platform === match.platform && r.match.kind === match.kind);
    const item = { id: crypto.randomUUID(), version: (previous?.version || 0) + 1, previousId: previous?.id, title: candidate.title, description: candidate.description, preconditions: String(candidate.preconditions || '').slice(0, 2000), match, reviewId, scripts: scripts.map(s => s.id), rollbackId: rollback?.id, state: 'candidate', at: new Date().toISOString() };
    this.items.push(item); this.persist(); return item;
  }
  activate(id) {
    const item = this.items.find(r => r.id === id); if (!item) throw Error('方案不存在');
    const validations = item.scripts.map(id => {
      const script = this.app.scripts.get(id);
      return this.app.scripts.runs.find(run => run.hash === script.hash && run.ok && run.verified && run.platform === item.match.platform && (script.purpose !== 'repair' || run.restoredNetwork && run.before?.kind === item.match.kind) && !run.outcomeUnknown);
    });
    if (validations.some(v => !v)) throw Error('新版本脚本尚未通过实际执行与探针验证；修复脚本还需有从故障到恢复的证据。不能仅凭在线模型推荐启用');
    for (const old of this.items) if (old.id !== id && old.title === item.title && old.match.platform === item.match.platform && old.match.kind === item.match.kind && old.state === 'active') old.state = 'superseded';
    item.state = 'active'; item.validationRuns = validations.map(r => r.id); this.persist(); this.app.store.log('runbook', '长期方案已启用', { id, validationRuns: item.validationRuns }); return item;
  }
  deactivate(id) { const item = this.items.find(r => r.id === id); if (!item) throw Error('方案不存在'); item.state = 'disabled'; this.persist(); return item; }
  matching(snapshot) { return this.items.filter(r => r.state === 'active' && r.match.kind === snapshot.health.kind && r.match.platform === snapshot.network.platform && (!r.match.connectionMethod || r.match.connectionMethod === snapshot.network.connection?.method)); }
}
