import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, ROOT } from './store.mjs';
import { Platform } from './platform.mjs';
import { Sensor } from './sensor.mjs';
import { Repair } from './repair.mjs';
import { Knowledge } from './knowledge.mjs';
import { Model } from './model.mjs';
import { Tasks } from './tasks.mjs';
import { Tools } from './tools.mjs';
import { Agent } from './agent.mjs';
import { Memory } from './memory.mjs';
import { Sessions } from './sessions.mjs';
import { Goals } from './goals.mjs';
import { Scripts } from './scripts.mjs';
import { Runbooks } from './runbooks.mjs';
import { Reviews } from './reviews.mjs';
import { RouterClient, wanDiff } from './router.mjs';
import { triage } from './triage.mjs';
import { decide } from './decide.mjs';
import { Playbooks } from './playbooks.mjs';
import { Identity } from './identity.mjs';
import { Stats } from './stats.mjs';

export class Engine extends EventEmitter {
  constructor({ dir = path.join(ROOT, 'runtime'), codec, platform, probes, knowledgeDir, fetcher, routerFetcher } = {}) {
    super(); this.store = new Store(dir, codec); this.platform = platform || new Platform();
    this.router = new RouterClient(this.store, routerFetcher || fetch); this.routerBaseline = this.store.read('router-baseline.json', null); this.routerPending = null;
    this.sensor = new Sensor(this.store, this.platform, probes); this.sensor.router = this.router; this.repair = new Repair(this.store, this.platform, this.sensor, this.router, this);
    this.playbooks = new Playbooks(this); this.identity = new Identity(this); this.stats = new Stats(this.store);
    this.knowledge = new Knowledge(this.store.config.knowledgePath || knowledgeDir || path.join(ROOT, 'knowledge'));
    this.model = new Model(this.store, fetcher); this.tasks = new Tasks(this.store); this.tools = new Tools(this); this.agent = new Agent(this);
    this.memory = new Memory(this.store); this.sessions = new Sessions(this); this.goals = new Goals(this); this.scripts = new Scripts(this); this.runbooks = new Runbooks(this); this.reviews = new Reviews(this);
    this.repair.externalBlock = () => this.scripts.liveOrphans().length > 0;
    this.recoveredPending = this.store.read('recovered-pending.json', []); this.lastPatrol = this.store.read('patrol.json', { lastAt: Date.now() }).lastAt;
    this.lastPatrolMetrics = this.store.read('patrol.json', {}).metrics || null;
    this.startedAt = Date.now(); this.incident = this.store.read('incident.json', null); this.closing = false; this.autoBusy = false;
    this.sensor.on('sample', s => { this.emit('change'); this.onSample(s).catch(e => this.store.log('error', '事件处理失败', { error: e.message })); });
    this.tasks.on('change', () => this.emit('change')); this.store.on('event', e => this.emit('event', e));
    this.store.on('config', () => { this.sensor.invalidate(); this.emit('change'); });
  }
  async start() {
    await this.repair.recoverPending();
    if (this.incident) { this.incident.fingerprint = null; this.incident.lastRun = 0; }
    this.active = true;
    this.store.log('system', '网络管理员启动', { platform: this.platform.platform, mode: this.store.config.repair.enabled ? '自动修复' : '只诊断', knowledge: this.knowledge.status() });
    this.sensor.start();
    if (this.store.config.agent.autoResume) {
      const interrupted = this.tasks.list().findLast(t => !t.parentId && t.status === 'interrupted' && this.sessions.load(t.id));
      if (interrupted) this.resumeTask(interrupted.id);
    }
    this.backgroundTimer = setInterval(() => this.background().catch(e => this.store.log('error', '后台调度失败', { error: e.message })), 1000);
  }
  state() {
    return this.store.redact({ config: this.store.publicConfig(), current: this.sensor.current, router: this.sensor.current?.router || null, routerBaseline: this.routerBaseline ? { at: this.routerBaseline.at, reason: this.routerBaseline.reason, config: this.routerBaseline.config } : null, routerLocked: this.router.lockedReason, playbooks: this.playbooks.items.slice(-50), identity: { banned: this.identity.state.banned.slice(-10), witnesses: this.identity.state.witnesses, occupied: Object.keys(this.identity.state.occupied).length }, stats: this.stats.snapshot(), history: this.sensor.history, events: this.store.events.slice(-150), tasks: this.tasks.list().map(t => ({ ...t, canResume: !t.parentId && t.status !== 'running' && t.status !== 'completed' && this.sessions.exists(t.id) })), baseline: this.store.baseline, knowledge: this.knowledge.status(), incident: this.incident, startedAt: this.startedAt, runtime: this.store.dir, repairBusy: this.repair.busy, pendingRollback: this.repair.rollback, scripts: this.scripts.items.slice(-100), scriptRuns: this.scripts.runs.slice(-50), runbooks: this.runbooks.items.slice(-100), reviews: this.reviews.items.slice(-30), memory: this.memory.items.slice(-30), recoveredPending: this.recoveredPending });
  }
  saveConfig(patch) {
    // Blank keys from the renderer mean "keep existing". Explicit clearApiKey handles removal.
    const clone = structuredClone(patch);
    if (clone.clearApiKey === true) clone.model = { ...clone.model, apiKey: '' };
    else if (clone.model?.apiKey === '') delete clone.model.apiKey;
    delete clone.clearApiKey;
    if (clone.clearOnlineApiKey === true) clone.onlineModel = { ...clone.onlineModel, apiKey: '' };
    else if (clone.onlineModel?.apiKey === '') delete clone.onlineModel.apiKey;
    delete clone.clearOnlineApiKey;
    if (clone.clearRouterPassword === true) clone.router = { ...clone.router, password: '' };
    else if (clone.router?.password === '') delete clone.router.password;
    delete clone.clearRouterPassword;
    if (clone.router && (clone.router.password !== undefined || clone.router.host !== undefined)) { this.router.unlock(); this.router.token = null; this.router.lastStatus = null; }
    const wasRepair = this.store.config.repair.enabled;
    const result = this.store.saveConfig(clone);
    if (patch.knowledgePath !== undefined) this.knowledge.load(result.knowledgePath || path.join(ROOT, 'knowledge'));
    if (!wasRepair && result.repair.enabled || patch.model?.name || patch.model?.baseUrl) {
      if (this.incident) { this.incident.fingerprint = null; this.incident.lastRun = 0; }
      if (this.active) this.sensor.sample({ fresh: true }).catch(e => this.store.log('error', '配置更新后探测失败', { error: e.message }));
    }
    return result;
  }
  async onSample(s) {
    if (this.closing || !this.active) return;
    this.stats.sample(s);
    if (s.stable === 'healthy' && s.health.kind === 'healthy') {
      if (this.incident) { this.store.log('incident', '连续探针确认网络恢复', { incidentId: this.incident.id }); /* same object: the running task keeps appending steps */ this.recoveredPending.push(Object.assign(this.incident, { recoveredAt: s.at })); this.store.write('recovered-pending.json', this.recoveredPending); this.incident = null; this.store.write('incident.json', null); }
      if (!this.repair.busy) this.maybeRouterBaseline(s);
      if (!this.repair.busy && s.network.connection && JSON.stringify({ connection: this.store.baseline?.network.connection, route: this.store.baseline?.network.route }) !== JSON.stringify({ connection: s.network.connection, route: s.network.route })) this.captureBaseline(s);
      return;
    }
    if (s.stable !== 'offline' || s.health.severity !== 'offline' || this.autoBusy) return;
    // A read-only patrol must not delay outage response: cancel it and handle the incident now.
    const running = this.tasks.list().filter(t => t.status === 'running' && !t.parentId);
    const patrols = running.filter(t => t.kind === 'patrol');
    if (patrols.length) { for (const t of patrols) this.tasks.cancel(t.id); this.store.log('incident', '检测到断网，中止进行中的例行巡检', { taskIds: patrols.map(t => t.id) }); await Promise.allSettled(patrols.map(t => this.tasks.promises.get(t.id))); }
    if (running.some(t => t.kind !== 'patrol')) return;
    const fingerprint = JSON.stringify({ kind: s.health.kind, route: s.network.route, connection: s.network.connection, dns: s.network.dns, addresses: s.network.interfaces.map(i => [i.name, i.addresses.map(a => a.address)]) });
    if (this.incident?.fingerprint === fingerprint) return;
    if (this.incident && Date.now() - this.incident.lastRun < this.store.config.monitor.cooldownMs) return;
    if (!this.incident) this.incident = { id: crypto.randomUUID(), createdAt: s.at, lastRun: 0, kind: s.health.kind, summary: s.health.summary, initial: s };
    this.incident.fingerprint = fingerprint; this.incident.lastRun = Date.now(); this.store.write('incident.json', this.incident);
    this.store.log('incident', '确认网络故障，开始诊断恢复', { incidentId: this.incident.id, health: s.health });
    this.autoBusy = true;
    const incident = this.incident; incident.steps ||= [];
    const task = this.tasks.start('incident', `恢复网络：${s.health.summary}`, async (task, signal) => {
      const results = []; const begun = Date.now(); const cfg = this.store.config;
      if (cfg.scripts.enabled && cfg.repair.enabled) {
        for (const runbook of this.runbooks.matching(s)) {
          for (const scriptId of runbook.scripts) {
            const result = await this.scripts.run(scriptId, { taskId: task.id, incidentId: incident.id, signal }); results.push({ runbookId: runbook.id, scriptId, result });
            if (!result.ok) break;
          }
          if (this.sensor.current?.health.kind === 'healthy') break;
        }
      }
      // 1. Deterministic layered triage (seconds): where is the outage and what could fix it.
      this.tasks.update(task.id, { phase: '分层分诊' });
      let card = await triage(this, s, signal);
      incident.triage ||= card; incident.signals = card.signals; if (this.incident === incident) this.store.write('incident.json', incident);
      this.store.log('triage', `分诊：${card.summary}`, { incidentId: incident.id, layer: card.layer, signals: card.signals, drift: card.drift, candidates: card.candidates.map(x => x.action), evidence: card.evidence });
      this.tasks.update(task.id, { triage: { layer: card.layer, summary: card.summary, signals: card.signals, drift: card.drift } });
      const describe = steps => steps.map(t => `${t.action}[${t.source}]${t.verified ? '✓' : t.blocked ? '⊘' : '✗'}`).join(' → ') || '无';
      if (!cfg.repair.enabled) {
        const note = `已分诊：${card.summary}。当前为只诊断模式；可执行的候选动作：${card.candidates.map(x => x.action).join('、') || '无'}`;
        if (!cfg.model.name) return { status: 'needs_attention', result: `${note}。`, triage: card, networkVerified: false };
        // Diagnose-only still gets a model analysis, but never a network change.
        this.tasks.update(task.id, { objective: `${task.objective}\n${note}。只诊断，说明证据和建议。` });
        const analysis = await this.agent.run(task, signal, { incidentId: incident.id });
        const v = await this.verify(signal);
        return { ...analysis, triage: card, networkVerified: v.verified, status: v.verified ? 'completed' : 'needs_attention', result: `${note}。模型分析：${analysis.result}` };
      }
      const playbook = this.playbooks.match(card);
      if (playbook) this.store.log('playbook', `匹配到${playbook.state === 'active' ? '已验证' : '候选'}方案`, { incidentId: incident.id, id: playbook.id, actions: playbook.actions });
      const tried = [];
      // 2. Decide → act → verify → re-triage, bounded by the action budget.
      for (let step = 0; step < cfg.repair.maxActions; step++) {
        signal.throwIfAborted();
        const remaining = card.candidates.filter(x => !tried.some(t => t.action === x.action));
        if (!remaining.length) break;
        let choice = null;
        if (playbook?.state === 'active') { const a = playbook.actions.find(a => remaining.some(x => x.action === a)); if (a) choice = { action: a, source: 'playbook', reason: `已验证方案 ${playbook.id.slice(0, 8)}：${playbook.rationale}`.slice(0, 300) }; }
        if (!choice && cfg.repair.fastDecision && cfg.model.name) {
          this.tasks.update(task.id, { phase: '本地模型快速决策' });
          const d = await decide(this, card, remaining, tried, { playbook, signal });
          this.store.log('decision', d.action ? `本地模型选择 ${d.action}` : '本地模型未给出有效动作，改用规则', { incidentId: incident.id, tally: d.tally, votes: d.votes, ms: d.ms });
          if (d.action) choice = { action: d.action, source: 'qwen', reason: d.reason, votes: d.tally, decideMs: d.ms };
        }
        if (!choice) choice = { action: remaining[0].action, source: 'rule', reason: remaining[0].why };
        const cheaper = remaining.filter(x => x.action !== 'router_reboot');
        if (choice.action === 'router_reboot' && cheaper.length) {
          this.store.log('decision', '重启路由器代价高，仍有低代价候选，按规则改选', { incidentId: incident.id, chosen: choice.action, instead: cheaper[0].action });
          choice = { action: cheaper[0].action, source: 'rule_guard', reason: `${choice.source} 选择了重启；先尝试 ${cheaper[0].action}`, overridden: choice.action, votes: choice.votes, decideMs: choice.decideMs };
        }
        this.tasks.update(task.id, { phase: `执行 ${choice.action}` });
        const result = await this.repair.execute(choice.action, choice.reason, { signal, incidentId: incident.id });
        const entry = { at: new Date().toISOString(), action: choice.action, source: choice.source, reason: choice.reason, votes: choice.votes, decideMs: choice.decideMs, overridden: choice.overridden, verified: Boolean(result.verified), blocked: Boolean(result.blocked), error: result.error, permission: result.permission, ms: result.ms };
        tried.push(entry); incident.steps.push(entry); results.push({ action: choice.action, result });
        if (result.verified) {
          const check = await this.verify(signal);
          if (check.verified) {
            if (playbook) this.playbooks.record(playbook.id, { success: true, action: choice.action, incidentId: incident.id });
            incident.resolvedBy = entry; incident.recoveryMs = Date.now() - new Date(incident.createdAt).getTime();
            return { status: 'completed', networkVerified: true, triage: card, steps: tried, actions: results, recoveryMs: incident.recoveryMs,
              result: `已恢复：${card.summary}。${choice.action}（决策来源 ${choice.source}）后连续探针确认网络恢复。从发现故障到恢复 ${Math.round(incident.recoveryMs / 1000)} 秒；动作链：${describe(tried)}` };
          }
        }
        const fresh = await this.sensor.sample({ fresh: true });
        if (fresh.health.kind === 'healthy') { const v = await this.verify(signal); if (v.verified) return { status: 'completed', networkVerified: true, triage: card, steps: tried, actions: results, result: `网络已由连续探针确认恢复，但不是由某个已验证动作直接确认（可能自行恢复）。动作链：${describe(tried)}` }; }
        card = await triage(this, fresh, signal);
        this.store.log('triage', `重新分诊：${card.summary}`, { incidentId: incident.id, layer: card.layer, signals: card.signals, candidates: card.candidates.map(x => x.action) });
      }
      if (playbook && tried.some(t => playbook.actions.includes(t.action) && !t.blocked)) this.playbooks.record(playbook.id, { success: false, action: null, incidentId: incident.id });
      if (this.sensor.current?.health.kind === 'healthy') { const v = await this.verify(signal); if (v.verified) return { status: 'completed', result: `探针确认恢复。动作链：${describe(tried)}`, networkVerified: true, actions: results, triage: card, steps: tried }; }
      const unresolved = `自动恢复未成功。分诊：${card.summary}（${card.layer}）；signals：${card.signals.join(', ')}；动作链：${describe(tried)}${tried.some(t => t.permission) ? '；本机动作缺少系统权限（NetworkManager/polkit）' : ''}`;
      if (!cfg.model.name) return { status: 'needs_attention', result: unresolved, actions: results, triage: card, steps: tried };
      // 3. Unresolved: let the agent investigate with full tools; report honestly.
      this.tasks.update(task.id, { objective: `${task.objective}\n${unresolved}。继续诊断：读取 read_events 和 router_status，找出原因；不要重复已失败的动作。` });
      const analysis = await this.agent.run(task, signal, { incidentId: incident.id });
      const verification = await this.verify(signal);
      return { ...analysis, actions: results, triage: card, steps: tried, networkVerified: verification.verified, status: verification.verified ? 'completed' : 'needs_attention',
        result: verification.verified ? `网络已由连续探针确认恢复。${unresolved.replace('自动恢复未成功', '快速恢复阶段未直接修复')}。模型分析：${analysis.result}` : `${unresolved}。模型分析：${analysis.result}` };
    });
    this.tasks.promises.get(task.id).finally(() => {
      const t = this.tasks.get(task.id);
      const outcome = incident.resolvedBy ? 'fixed' : (t?.networkVerified ? 'self' : 'unfixed');
      this.stats.recordIncident({ createdAt: incident.createdAt, kind: incident.kind, outcome, recoveryMs: incident.recoveryMs });
      this.autoBusy = false; this.emit('change');
    });
  }
  // The router WAN baseline is what router_restore_wan returns to. A changed config only becomes the
  // new baseline after it has stayed healthy for baselineSettleMs (so a just-broken config never does).
  maybeRouterBaseline(s) {
    const r = s.router; if (!r?.reachable || r.authError || !r.config || !r.wan?.connected) return;
    if (!this.routerBaseline) return this.saveRouterBaseline(r.config, 'initial');
    const drift = wanDiff(this.routerBaseline.config, r.config);
    if (!drift.length) { this.routerPending = null; return; }
    const key = JSON.stringify(r.config);
    if (this.routerPending?.key !== key) { this.routerPending = { key, since: Date.now() }; this.store.log('router', '路由器 WAN 配置与基线不同且网络健康；稳定期满后更新基线', { drift, settleMs: this.store.config.router.baselineSettleMs }); return; }
    if (Date.now() - this.routerPending.since >= this.store.config.router.baselineSettleMs) this.saveRouterBaseline(r.config, 'settled', drift);
  }
  saveRouterBaseline(config, reason, drift = []) {
    const history = [...(this.routerBaseline?.history || []), ...(this.routerBaseline ? [{ at: this.routerBaseline.at, config: this.routerBaseline.config }] : [])].slice(-5);
    this.routerBaseline = { at: new Date().toISOString(), reason, config, history }; this.routerPending = null;
    this.store.write('router-baseline.json', this.routerBaseline); this.store.log('baseline', '已保存路由器 WAN 健康基线', { reason, drift, config });
  }
  captureBaseline(snapshot = this.sensor.current) {
    if (snapshot?.health.kind !== 'healthy' || snapshot.stable !== 'healthy') throw Error('只有连续探针确认健康后才能保存基线');
    this.store.baseline = { at: snapshot.at, network: snapshot.network }; this.store.write('baseline.json', this.store.baseline);
    this.store.log('baseline', '已保存健康网络基线', this.store.baseline); return this.store.baseline;
  }
  ask(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 3000) throw Error('请输入 1–3000 字的任务');
    if (this.tasks.list().some(t => t.status === 'running' && !t.parentId)) throw Error('管理员正处理另一个任务；请等待或先停止该任务');
    return this.tasks.start('conversation', text, async (task, signal) => {
      const result = await this.agent.run(task, signal, { incidentId: this.incident?.id });
      const check = await this.verify(signal); return { ...result, networkVerified: check.verified };
    });
  }
  retry() {
    if (this.autoBusy) throw Error('恢复任务仍在运行');
    // A retry re-evaluates evidence but shares the action budget for the existing incident.
    if (this.incident) { this.incident.fingerprint = null; this.incident.lastRun = 0; }
    this.sensor.invalidate(); return this.sensor.sample({ fresh: true });
  }
  resumeTask(id) {
    if (this.tasks.list().some(t => t.status === 'running' && !t.parentId)) throw Error('已有主任务运行，暂不能恢复另一会话');
    const previous = this.tasks.get(id); if (!previous || previous.parentId) throw Error('只能恢复主任务');
    if (!this.sessions.load(id)) throw Error('旧任务没有会话检查点');
    return this.tasks.start(previous.kind, previous.objective, (task, signal) => this.agent.run(task, signal, { resume: true, incidentId: this.incident?.id }), { resumeId: id });
  }
  patrolNow() {
    if (!this.store.config.model.name) throw Error('请先配置本地模型');
    if (this.tasks.list().some(t => t.status === 'running' && !t.parentId)) throw Error('已有主任务运行');
    this.lastPatrol = Date.now(); this.store.write('patrol.json', { lastAt: this.lastPatrol, metrics: this.lastPatrolMetrics });
    return this.tasks.start('patrol', '例行自检：采集网络配置与延迟、DNS状态，按需运行固定只读诊断，检索历史经验，报告性能变化与异常。不得改网络。', async (task, signal) => {
      if (this.store.config.scripts.enabled && this.store.config.repair.enabled) for (const runbook of this.runbooks.matching(this.sensor.current)) for (const id of runbook.scripts) {
        if (['diagnostic', 'verify'].includes(this.scripts.get(id).purpose)) await this.scripts.run(id, { taskId: task.id, signal });
      }
      try { return await this.agent.run(task, signal, { readOnly: true }); }
      finally { this.lastPatrolMetrics = this.sensor.statistics(); this.store.write('patrol.json', { lastAt: this.lastPatrol, metrics: this.lastPatrolMetrics }); }
    });
  }
  async background() {
    if (this.closing || this.autoBusy || this.repair.busy || this.scripts.liveOrphans().length || this.tasks.list().some(t => t.status === 'running' && !t.parentId)) return;
    if (this.sensor.current?.stable !== 'healthy' || this.sensor.current?.health.kind !== 'healthy') return;
    if (this.recoveredPending.length) {
      for (const incident of this.recoveredPending) {
        if (!this.memory.items.some(m => m.source?.recoveryId === incident.id)) this.memory.add({ title: `故障恢复记录：${incident.kind || '网络异常'}`, content: `${incident.summary || '网络曾出现异常'}；${incident.recoveredAt} 后连续核心探针确认健康。根因需结合执行日志复盘，不能仅由恢复结果推断。`, source: { recoveryId: incident.id }, verified: true, tags: [incident.kind || 'network', 'observed-recovery'], incidentId: incident.id });
        // Brief blips without any action carry no lesson; don't spend online review on them.
        const duration = new Date(incident.recoveredAt).getTime() - new Date(incident.createdAt).getTime();
        if (incident.steps?.length || duration > 30000) this.reviews.enqueue(incident);
        else this.store.log('review', '短暂波动且未执行动作，跳过在线复盘', { incidentId: incident.id, durationMs: duration });
      }
      this.recoveredPending = []; this.store.write('recovered-pending.json', []);
    }
    await this.reviews.drain();
    if (this.store.config.router.enabled && this.sensor.current?.router?.reachable && Date.now() - (this.lastTrafficAt || 0) >= 30000) {
      this.lastTrafficAt = Date.now();
      try { const j = await this.router.call('misystem/status'); const w = j.wan || {}; this.stats.recordTraffic({ up: Number(w.upload), down: Number(w.download), upBps: Number(w.upspeed), downBps: Number(w.downspeed) }); }
      catch (e) { this.store.log('error', '流量统计读取失败', { error: e.message }); }
    }
    const rc = this.store.config.router;
    if (rc.enabled && rc.allowIdentityChange && this.sensor.current?.router?.config?.wanType === 'static' && Date.now() - this.identity.state.lastLearn >= rc.identityLearnMs) await this.identity.learn(this.sensor.current.router.config).catch(e => this.store.log('error', '邻居采样失败', { error: e.message }));
    if (this.store.config.patrol.enabled && this.store.config.model.name && Date.now() - this.lastPatrol >= this.store.config.patrol.intervalMs) this.patrolNow();
  }
  async verify(signal) {
    const samples = [];
    for (let i = 0; i < this.store.config.monitor.recoveryThreshold; i++) {
      signal?.throwIfAborted();
      if (i) await sleep(this.store.config.monitor.intervalMs, undefined, { signal });
      const s = await this.sensor.sample({ fresh: true }); samples.push({ at: s.at, health: s.health });
      if (s.health.kind !== 'healthy') break;
    }
    const verified = samples.length >= this.store.config.monitor.recoveryThreshold && samples.every(s => s.health.kind === 'healthy');
    this.store.log('verification', verified ? '独立连续探针确认健康' : '网络尚未通过恢复验证', { verified, samples }); return { verified, samples };
  }
  testModel() {
    if (this.tasks.list().some(t => t.status === 'running' && !t.parentId)) throw Error('请等待当前任务结束后测试模型');
    return this.tasks.start('model_test', '验证模型连接与工具往返协议', async (_task, signal) => {
      const tool = { type: 'function', function: { name: 'echo_test', description: '回传测试标记', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } };
      const jsonMode = this.store.config.model.mode === 'json';
      const messages = [{ role: 'system', content: jsonMode ? '只输出JSON。第一轮输出{"tool":"echo_test","arguments":{"value":"network-ok"}}。收到工具反馈后输出{"final":"工具往返通过"}。' : '测试工具协议。先调用echo_test，参数value为network-ok，收到反馈后用中文说测试通过。' }, { role: 'user', content: '开始工具往返测试' }];
      const first = await this.model.complete(messages, [tool], signal);
      const call = first.calls[0];
      if (first.calls.length !== 1 || call?.function.name !== 'echo_test' || JSON.parse(call.function.arguments).value !== 'network-ok') throw Error('接口可连接，但模型没有正确调用测试工具；尝试切换JSON工具模式或检查聊天模板');
      messages.push(jsonMode ? { role: 'assistant', content: JSON.stringify({ tool: 'echo_test', arguments: { value: 'network-ok' } }) } : { role: 'assistant', content: first.content || null, tool_calls: first.calls });
      messages.push(jsonMode ? { role: 'user', content: '工具反馈:{"value":"network-ok","ok":true}' } : { role: 'tool', tool_call_id: call.id, content: '{"value":"network-ok","ok":true}' });
      const second = await this.model.complete(messages, [tool], signal);
      if (!second.content || second.calls.length) throw Error('工具调用已收到，但模型未正确消费反馈并结束测试');
      return { result: `模型连接和工具往返通过。${second.content}`, networkVerified: false };
    });
  }
  testOnline() {
    return this.tasks.start('online_test', '测试在线复盘接口（只发送合成数据）', async (_task, signal) => {
      const result = await this.model.json('这是合成接口验收。只返回JSON:{"ok":true,"summary":"在线模型结构化接口可用"}，不调用工具。', { synthetic: true, test: 'review transport' }, signal, { track: 'online' });
      if (result.ok !== true || typeof result.summary !== 'string') throw Error('在线模型未返回预期结构'); return { result: result.summary };
    });
  }
  runScript(id) {
    if (this.tasks.list().some(t => t.status === 'running' && !t.parentId)) throw Error('请先结束当前主任务');
    return this.tasks.start('script_test', `验证脚本：${this.scripts.get(id).title}`, async (task, signal) => {
      const result = await this.scripts.run(id, { taskId: task.id, incidentId: this.incident?.id, signal }); return { result: JSON.stringify(result, null, 2), status: result.ok ? 'completed' : 'needs_attention', networkVerified: Boolean(result.verified) };
    });
  }
  async close() { this.closing = true; clearInterval(this.backgroundTimer); this.reviews.stop(); await this.tasks.close(); this.sensor.stop(); if (this.reviews.pending) await this.reviews.pending; if (this.repair.rollback) await this.repair.restore(); this.store.log('system', '网络管理员停止'); }
}
