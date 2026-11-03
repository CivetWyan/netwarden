/* All external content is rendered as text. The renderer has no network or filesystem access. */
const api = window.netwarden;
const $ = id => document.getElementById(id);
const node = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const text = (id, value) => { $(id).textContent = value; };
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const statusNames = { running: '处理中', queued: '等待中', completed: '已结束', needs_attention: '需要处理', cancelled: '已停止', interrupted: '运行中断', failed: '执行失败' };
let state; let page = 'overview'; let dirty = false; let settingsLoaded = false; let toastTimer; let assistantKey = ''; let eventsKey = ''; let learningKey = '';
function toast(message, error = false) { $('toast').hidden = false; $('toast').className = `toast${error ? ' error' : ''}`; text('toast', message); clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 10000 : 6000); }
async function action(button, fn, message) { if (button) button.disabled = true; try { const result = await fn(); if (message) toast(typeof message === 'function' ? message(result) : message); state = await api.state(); render(); return result; } catch (e) { toast(e.message, true); } finally { if (button) button.disabled = false; } }
function go(next) {
  page = next; document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  text('page-label', document.querySelector(`[data-page="${page}"]`).textContent.replace('✧', '').trim()); render();
}
document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => go(b.dataset.page)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => go(b.dataset.goto)));
function fillSettings() {
  const c = state.config; const values = { 'cfg-url': c.model.baseUrl, 'cfg-model': c.model.name, 'cfg-mode': c.model.mode, 'cfg-reasoning': c.model.reasoningEffort || '', 'cfg-context': c.model.contextChars, 'cfg-tokens': c.model.maxTokens, 'cfg-turns': c.model.maxTurns, 'cfg-timeout': c.model.timeoutMs / 1000, 'cfg-fallback-dns': c.repair.fallbackDns.join(', '), 'cfg-interval': c.monitor.intervalMs, 'cfg-probe-timeout': c.monitor.probeTimeoutMs, 'cfg-targets': c.monitor.tcpTargets.map(t => `${t.host}:${t.port}`).join('\n'), 'cfg-domains': c.monitor.dnsHosts.join(', '), 'cfg-http': c.monitor.httpUrl };
  for (const [id, value] of Object.entries(values)) $(id).value = value;
  const checks = { 'cfg-repair': c.repair.enabled, 'cfg-dhcp': c.repair.allowDhcp, 'cfg-reconnect': c.repair.allowReconnect, 'cfg-dns-change': c.repair.allowDnsChange, 'cfg-monitor': c.monitor.enabled, 'cfg-login': c.startAtLogin };
  for (const [id, value] of Object.entries(checks)) $(id).checked = value;
  const extraValues = { 'cfg-online-url': c.onlineModel.baseUrl, 'cfg-online-model': c.onlineModel.name, 'cfg-upload': c.review.upload, 'cfg-privacy': c.review.privacy, 'cfg-patrol-minutes': c.patrol.intervalMs / 60000, 'cfg-script-approval': c.scripts.approval, 'cfg-script-timeout': c.scripts.timeoutMs / 1000 };
  for (const [id,value] of Object.entries(extraValues)) $(id).value = value;
  const extraChecks = { 'cfg-review': c.review.enabled, 'cfg-patrol': c.patrol.enabled, 'cfg-scripts': c.scripts.enabled, 'cfg-resume': c.agent.autoResume, 'cfg-semantic': c.agent.semanticCompact, 'cfg-goals': c.agent.goalChecks };
  for (const [id,value] of Object.entries(extraChecks)) $(id).checked = value;
  $('cfg-online-key').value = ''; $('cfg-clear-online-key').checked = false; text('online-key-status',c.onlineModel.hasApiKey ? '已有在线 Key · 留空保留' : '尚未配置在线 Key');
  $('cfg-key').value = ''; $('cfg-clear-key').checked = false;
  text('key-status', c.model.hasApiKey ? '已有 Key · 留空保留' : '尚未保存 Key · 本地可留空');
  text('runtime-path', `运行数据与日志：${state.runtime}`); settingsLoaded = true;
}
function configPatch() {
  const list = id => $(id).value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  const targets = list('cfg-targets').map(t => { const split = t.lastIndexOf(':'); if (split < 1) throw Error('TCP 探针格式应为 host:port'); return { host: t.slice(0, split).replace(/^\[|\]$/g, ''), port: Number(t.slice(split + 1)) }; });
  return { onlineModel: { baseUrl: $('cfg-online-url').value.trim(), name: $('cfg-online-model').value.trim(), apiKey: $('cfg-online-key').value }, clearOnlineApiKey: $('cfg-clear-online-key').checked, review: { enabled: $('cfg-review').checked, upload: $('cfg-upload').value, privacy: $('cfg-privacy').value }, patrol: { enabled: $('cfg-patrol').checked, intervalMs: Math.round(+$('cfg-patrol-minutes').value * 60000) }, scripts: { enabled: $('cfg-scripts').checked, approval: $('cfg-script-approval').value, timeoutMs: +$('cfg-script-timeout').value * 1000 }, agent: { autoResume: $('cfg-resume').checked, semanticCompact: $('cfg-semantic').checked, goalChecks: $('cfg-goals').checked }, model: { baseUrl: $('cfg-url').value.trim(), name: $('cfg-model').value.trim(), apiKey: $('cfg-key').value, mode: $('cfg-mode').value, reasoningEffort: $('cfg-reasoning').value, contextChars: +$('cfg-context').value, maxTokens: +$('cfg-tokens').value, maxTurns: +$('cfg-turns').value, timeoutMs: +$('cfg-timeout').value * 1000 }, clearApiKey: $('cfg-clear-key').checked, repair: { enabled: $('cfg-repair').checked, allowDhcp: $('cfg-dhcp').checked, allowReconnect: $('cfg-reconnect').checked, allowDnsChange: $('cfg-dns-change').checked, fallbackDns: list('cfg-fallback-dns') }, monitor: { enabled: $('cfg-monitor').checked, intervalMs: +$('cfg-interval').value, probeTimeoutMs: +$('cfg-probe-timeout').value, tcpTargets: targets, dnsHosts: list('cfg-domains'), httpUrl: $('cfg-http').value.trim() }, startAtLogin: $('cfg-login').checked };
}
document.querySelectorAll('#page-settings input,#page-settings textarea,#page-settings select').forEach(e => e.addEventListener('input', () => { dirty = true; }));
async function save() { await api.saveConfig(configPatch()); dirty = false; state = await api.state(); fillSettings(); }
$('save-config').onclick = () => action($('save-config'), save, '设置已保存。');
$('test-model').onclick = () => action($('test-model'), async () => { await save(); const task = await api.testModel(); go('assistant'); return task; }, '已开始工具往返测试，请查看任务结果。');
$('test-online').onclick = () => action($('test-online'), async () => { await save(); const task=await api.testOnline(); go('assistant'); return task; }, '已开始在线接口合成测试。');
$('patrol-now').onclick = () => action($('patrol-now'), () => api.patrol(), '已开始本地模型只读自检。');
$('sample').onclick = () => action($('sample'), () => api.sample(), '已重新采集网络现场。');
$('export').onclick = () => action($('export'), () => api.export(), filename => `诊断报告已导出：${filename}`);
$('capture-baseline').onclick = () => action($('capture-baseline'), () => api.baseline(), '已保存当前健康网络基线。');
$('restore-dns').onclick = () => action($('restore-dns'), () => api.restore(), r => r.ok ? 'DNS 事务已处理。' : '回滚未完成，请查看日志。');
$('retry').onclick = () => action($('retry'), () => api.retry(), '正在重新评估现场；同一故障已尝试的动作不会重复。');
$('toggle-repair').onclick = () => action($('toggle-repair'), async () => { const result = await api.saveConfig({ repair: { enabled: !state.config.repair.enabled } }); if (!dirty) { state.config = result; fillSettings(); } if (result.repair.enabled) await api.retry(); return result; }, c => c.repair.enabled ? '已开启自动修复：允许已勾选的恢复动作。' : '已切换为只诊断模式。正在执行的动作会完成验证和回滚。');
$('ask-form').onsubmit = e => { e.preventDefault(); const value = $('ask-text').value.trim(); if (!value) return; action($('send-task'), async () => { const task = await api.ask(value); $('ask-text').value = ''; return task; }); };
$('ask-text').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('ask-form').requestSubmit(); } };
document.querySelectorAll('[data-prompt]').forEach(b => { b.onclick = () => { $('ask-text').value = b.dataset.prompt; $('ask-form').requestSubmit(); }; });
$('search-form').onsubmit = e => { e.preventDefault(); const query = $('search-text').value.trim(); if (!query) return; action(e.submitter, async () => { const hits = await api.search(query); $('search-results').replaceChildren(); if (!hits.length) $('search-results').append(node('div', 'panel empty large-empty', '没有匹配片段，请换一组网络关键词。')); for (const hit of hits) { const card = node('article', 'panel knowledge-result'); const tag = node('span', 'tag', `[${hit.id}]`); card.append(tag); if (hit.warning) card.append(node('span', 'tag warning-tag', '⚑ 原始资料含疑点')); card.append(node('h3', '', hit.breadcrumb), node('pre', '', hit.text), node('div', 'source', `来源：${hit.sources?.join(' / ') || 'HCIA 章节原文'}${hit.truncated ? ' · 片段展示已截断' : ''}`)); $('search-results').append(card); } }); };
$('event-filter').onchange = () => { eventsKey = ''; renderEvents(); };
function fmtDur(ms) {
  if (ms == null || ms < 0) return '—';
  const sec = Math.floor(ms / 1000); const d = Math.floor(sec / 86400); const h = Math.floor(sec % 86400 / 3600); const m = Math.floor(sec % 3600 / 60); const ss = sec % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}
function fmtGB(gb) { return gb >= 1024 ? `${(gb / 1024).toFixed(2)} TB` : `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`; }
function fmtBps(bps) { const b = bps * 8; return b >= 1e9 ? `${(b / 1e9).toFixed(1)} Gbps` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbps` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} Kbps` : `${Math.round(b)} bps`; }
function renderAchievements() {
  const a = state.stats; const el = $('achievements'); if (!a) { if (el) el.hidden = true; return; } el.hidden = false;
  const cur = $('ach-current'); cur.classList.toggle('broken', a.broken);
  if (a.broken) { text('ach-current-value', '已损坏'); text('ach-current-sub', `已持续 ${fmtDur(a.brokenMs)} 未修复`); }
  else { text('ach-current-value', fmtDur(a.currentHealthyMs)); text('ach-current-sub', '本地自愈的小故障不中断计时'); }
  text('ach-longest-value', fmtDur(a.longestHealthyMs)); text('ach-longest-sub', a.longestHealthyMs && !a.broken && a.currentHealthyMs >= a.longestHealthyMs ? '正在刷新纪录 ✦' : '历史最长');
  text('ach-fixed', String(a.fixedCount)); text('ach-fixed-sub', a.avgFixMs ? `平均 ${(a.avgFixMs / 1000).toFixed(1)} 秒 · 另自行恢复 ${a.selfRecoveredCount} 次` : `另自行恢复 ${a.selfRecoveredCount} 次`);
  text('ach-unfixed', String(a.unfixedCount)); text('ach-unfixed-sub', a.unfixedCount ? `累计中断 ${fmtDur(a.totalOutageMs)}` : '用户可感知断网');
  text('ach-rate', a.successRate == null ? '—' : `${Math.round(a.successRate * 100)}%`); text('ach-rate-sub', a.successRate == null ? '暂无故障记录' : `${a.fixedCount}/${a.fixedCount + a.unfixedCount}`);
  text('ach-traffic', `${fmtGB(a.uploadGB + a.downloadGB)}`); text('ach-traffic-sub', `↑${fmtBps(a.upBps)} ↓${fmtBps(a.downBps)}`);
  const pb = (state.playbooks || []).filter(p => p.state === 'active').length; text('ach-playbooks', String(pb)); text('ach-playbooks-sub', '经真实故障验证');
  text('ach-runtime', fmtDur(a.runtimeMs)); text('ach-runtime-sub', '自部署以来');
}
function render() {
  if (!state) return;
  if (!settingsLoaded || !dirty && page === 'settings') fillSettings();
  const c = state.config; const s = state.current; const running = state.tasks.filter(t => t.status === 'running');
  renderAchievements();
  text('monitor-label', c.monitor.enabled ? '持续感知中' : '探测已暂停'); $('monitor-dot').classList.toggle('paused', !c.monitor.enabled); $('task-dot').classList.toggle('busy', running.length > 0);
  text('knowledge-count', `${state.knowledge.count.toLocaleString()} 个片段`); text('knowledge-status', state.knowledge.error ? '知识库未就绪' : `${state.knowledge.count} 个原文片段 · 已就绪`);
  text('model-tag', c.model.name ? '接口已配置' : '待配置'); text('model-title', c.model.name || '接入你的网络大脑'); text('model-description', c.model.name ? `${c.model.baseUrl} · ${c.model.mode === 'native' ? '原生工具' : 'JSON 工具'} · 连接可用性以测试结果为准` : '支持 OpenAI 兼容接口。连接本地模型后，断网时仍能分析和调用工具。');
  $('toggle-repair').replaceChildren(document.createTextNode(c.repair.enabled ? '自动修复 ' : '只诊断 '), node('span', '', '⇄')); text('mode-description', c.repair.enabled ? '在授权范围内执行并验证' : '收集证据并给出恢复建议');
  $('metric-tasks').replaceChildren(document.createTextNode(`${running.length} `), node('small', '', '运行中'));
  if (s) {
    const kind = s.health.kind; const severity = s.health.severity;
    $('health-banner').className = `health-banner ${severity}`;
    text('health-title', kind === 'healthy' ? s.stable === 'healthy' ? '网络连接正常' : '探针正常，等待连续确认' : severity === 'offline' ? '检测到网络连接异常' : '部分网络探测异常'); text('health-summary', s.health.summary); text('health-symbol', severity === 'healthy' ? '✓' : severity === 'offline' ? '!' : '◎');
    text('last-sample', `最近探测 ${time(s.at)}`); text('sample-duration', `本次采集 ${s.durationMs} ms`);
    const good = s.tcp.filter(t => t.ok); $('metric-internet').replaceChildren(document.createTextNode(good.length ? String(Math.min(...good.map(t => t.ms))) : '不可达'), node('small', '', good.length ? ' ms' : ''));
    text('internet-note', `${good.length} / ${s.tcp.length} 个 TCP 探针可达`); text('metric-dns', s.dns.some(d => d.ok) ? '解析正常' : '解析失败'); text('dns-note', s.dns.map(d => `${d.host} ${d.ok ? '✓' : '×'}`).join(' · '));
    text('metric-gateway', s.network.route?.gateway || (s.network.routeKnown ? '无默认路由' : '读取失败')); const rt = s.router; text('gateway-note', `${s.network.route?.interface || '未知接口'} · 网关 ICMP ${s.gateway.ok ? '可达' : s.gateway.skipped ? '未探测' : '无应答'}${rt?.enabled ? ` · 路由器 WAN ${!rt.reachable ? '管理接口不可达' : rt.authError ? '登录失败' : rt.wan?.connected ? `已连通 ${rt.wan.ip}` : rt.wan?.link === 0 ? '链路断开' : '未连通'}` : ''}`);
    $('probe-row').replaceChildren(...[...s.tcp.map(t => [t.host, t.ok]), ['DNS', s.dns.some(d => d.ok)], ['HTTP 204', s.http.ok], ...(s.router?.enabled ? [['路由器 WAN', Boolean(s.router.wan?.connected)]] : [])].map(([label, ok]) => { const e = node('span', 'probe-item'); e.append(node('i', `probe-dot ${ok ? 'good' : 'bad'}`), document.createTextNode(label)); return e; }));
    const list = $('interfaces'); list.replaceChildren();
    for (const i of s.network.interfaces) { const row = node('div', 'interface-row'); const info = node('div', 'interface-main'); info.append(node('b', '', i.name), node('p', '', i.addresses.map(a => a.address).join(' / '))); row.append(node('div', 'interface-icon', '⌁'), info, node('span', 'tag', i.name === s.network.route?.interface ? '默认出口' : '已分配地址')); list.append(row); }
    if (!s.network.interfaces.length) list.append(node('p', 'empty', '未发现带地址的非回环接口'));
    text('baseline-info', state.baseline ? `健康基线 · ${time(state.baseline.at)} · ${state.baseline.network.connection?.name || '已记录配置'}` : '首次连续健康后自动记录基线');
    renderRouterPanel();
  }
  $('recent-events').replaceChildren(...state.events.filter(e => !['tool', 'verification'].includes(e.type)).slice(-4).reverse().map(e => { const row = node('div', 'recent-event'); const info = node('div'); info.append(node('p', '', e.message), node('small', '', time(e.at))); row.append(node('i'), info); return row; }));
  if (page === 'overview') renderChart();
  if (page === 'assistant') renderAssistant();
  if (page === 'events') renderEvents();
  if (page === 'learning') renderLearning();
}
function renderChart() {
  const svg = $('pulse-chart'); svg.replaceChildren(); const ns = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value); svg.append(e); return e; };
  const data = state.history; const max = Math.max(50, ...data.map(p => p.ms || 0));
  for (let i = 0; i < 4; i++) { const y = 12 + i * 45; add('line', { x1: 35, y1: y, x2: 754, y2: y, stroke: '#edf1f5', 'stroke-dasharray': '3 5' }); const t = add('text', { x: 0, y: y + 3, fill: '#b3bdc8', 'font-size': 9 }); t.textContent = `${Math.round(max * (1 - i / 3))}`; }
  let points = []; const flush = () => { if (points.length > 1) add('polyline', { points: points.join(' '), fill: 'none', stroke: '#3c9e84', 'stroke-width': 2, 'stroke-linejoin': 'round' }); points = []; };
  data.forEach((p, i) => { const x = 38 + (i / Math.max(1, data.length - 1)) * 706; const y = 147 - Math.min(1, (p.ms || 0) / max) * 135; if (p.severity !== 'healthy') add('circle', { cx: x, cy: 163, r: 2, fill: '#d39476' }); if (p.ms !== null) { points.push(`${x},${y}`); if (data.length < 3) add('circle', { cx: x, cy: y, r: 2.5, fill: '#3c9e84' }); } else flush(); }); flush(); text('chart-start', data.length ? time(data[0].at) : '等待采样');
}
function renderAssistant() {
  const tasks = state.tasks.filter(t => !t.parentId); const key = JSON.stringify(tasks);
  if (key !== assistantKey) {
    assistantKey = key; const box = $('conversation'); const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    if (tasks.length) { box.replaceChildren(); for (const task of tasks) { const item = node('article', 'chat-task'); item.append(node('div', 'chat-user', task.objective), node('small', '', `${time(task.createdAt)} · ${statusNames[task.status] || task.status}${task.networkVerified ? ' · 连续探针已确认健康' : ''}`), node('div', `chat-result${task.error ? ' error' : ''}`, task.error || task.result || `${task.phase || '采集现场'}…`)); if (task.canResume) { const resume = node('button','btn resume-task','恢复原会话'); resume.onclick=()=>action(resume,()=>api.resume(task.id),'已从检查点继续；不会重放未知动作。'); item.append(resume); } box.append(item); } }
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  const active = tasks.findLast(t => t.status === 'running') || tasks.at(-1); const progress = $('task-progress'); progress.replaceChildren();
  if (!active) { progress.append(node('p', 'empty', '尚无任务')); return; }
  progress.append(node('div', 'task-objective', active.objective), node('div', 'task-phase', `${statusNames[active.status] || active.status} · 第 ${active.turns} 轮 · ${active.phase || '现场诊断'}`));
  if (active.goal?.verdict) progress.append(node('div','goal-verdict',`目标检查：${active.goal.verdict.reason}`));
  for (const step of active.plan || []) { const line = node('div', 'plan-step'); line.append(node('b', '', ({ completed: '✓', in_progress: '◉', blocked: '!', pending: '○' })[step.status]), node('span', '', step.title)); progress.append(line); }
  for (const child of state.tasks.filter(t => t.parentId === active.id)) progress.append(node('div', 'plan-step', `${child.kind === 'knowledge' ? '知识专家' : '诊断专家'} · ${statusNames[child.status]}`));
  if (active.status === 'running') { const stop = node('button', 'btn cancel-task', '停止当前任务'); stop.onclick = () => action(stop, () => api.cancel(active.id), '停止请求已发出；已开始的恢复动作会处理回滚。'); progress.append(stop); }
  $('send-task').disabled = tasks.some(t => t.status === 'running');
}
function renderEvents() {
  if (!state) return; const filter = $('event-filter').value;
  const groups = { incident: ['incident', 'state', 'baseline'], action: ['action', 'action_result', 'evidence', 'verification', 'rollback'], tool: ['task', 'tool'], error: ['error'] };
  const list = state.events.filter(e => filter === 'all' || groups[filter]?.includes(e.type)).slice().reverse();
  const key = `${filter}:${list[0]?.id}:${list.length}`; if (key === eventsKey) return; eventsKey = key;
  const openIds = new Set([...document.querySelectorAll('#event-list details[open]')].map(e => e.dataset.id));
  $('event-list').replaceChildren(...list.map(e => { const row = node('details', 'event-row'); row.dataset.id = e.id; row.open = openIds.has(e.id); const summary = node('summary'); summary.append(node('span', 'event-time', time(e.at)), node('span', 'event-type', e.type), node('span', 'event-message', e.message)); row.append(summary, node('pre', '', JSON.stringify(e.data, null, 2))); return row; }));
  if (!list.length) $('event-list').append(node('div', 'empty', '当前筛选下没有事件'));
}
setInterval(() => text('clock', new Date().toLocaleTimeString('zh-CN', { hour12: false })), 1000);
api.subscribe(data => { state = data; render(); });
api.state().then(data => { state = data; render(); }).catch(e => toast(e.message, true));

function renderIdentity() {
  const el = $('identity-info'); if (!el) return; el.replaceChildren();
  const id = state.identity; const r = state.router;
  const cur = node('p', 'footnote', `当前 WAN 身份：IP ${r?.wan?.ip || '—'} · MAC ${r?.wan?.mac || '—'}`); el.append(cur);
  const wit = node('p', 'footnote', `参照邻居（判断是否仅本机被封）：${id?.witnesses?.length ? id.witnesses.join('、') : '尚未采样'}`); el.append(wit);
  if (id?.banned?.length) {
    el.append(node('h4', '', '疑似被封记录'));
    for (const b of id.banned.slice().reverse()) { const row = node('div', 'learning-item'); row.append(node('h4', '', `IP ${b.ip || '—'} · MAC ${b.mac || '—'}`), node('small', '', `记录于 ${time(b.at)}`)); el.append(row); }
  } else el.append(node('p', 'empty', '暂无疑似被封记录'));
}
function renderRouterPanel() {
  const r = state.router; const panel = $('router-panel');
  if (!r || !r.enabled) { panel.hidden = true; return; }
  panel.hidden = false;
  const reach = !r.reachable ? '管理接口不可达' : r.authError ? '登录失败' : r.wan?.connected ? '已连通' : r.wan?.link === 0 ? '链路断开' : '未连通';
  text('router-tag', reach);
  const w = $('router-wan'); w.replaceChildren();
  const rows = [];
  if (r.wan) { rows.push(['WAN 地址', r.wan.ip || '—']); rows.push(['WAN 网关', r.wan.gateway || '—']); rows.push(['WAN MAC', r.wan.mac || '—']); if (r.wan.dns?.length) rows.push(['WAN DNS', r.wan.dns.join(' / ')]); }
  const base = state.routerBaseline?.config; if (base) rows.push(['健康基线 IP', base.ipaddr || `${base.wanType || ''}`]);
  for (const [k, v] of rows) { const row = node('div', 'interface-row'); const info = node('div', 'interface-main'); info.append(node('b', '', k), node('p', '', String(v))); row.append(node('div', 'interface-icon', '⌁'), info); w.append(row); }
  const id = state.identity;
  if (id) text('router-identity', `参照邻居 ${id.witnesses?.length || 0} 个 · 疑似被封记录 ${id.banned?.length || 0} 条 · 已知占用 ${id.occupied || 0} 个`);
  else text('router-identity', '');
}
function renderLearning() {
  const playbooks=state.playbooks||[];
  const key=JSON.stringify([state.reviews,state.scripts,state.scriptRuns,state.runbooks,state.memory,playbooks,state.identity,state.router?.wan]); if(key===learningKey)return; learningKey=key;
  text('learning-summary',`${state.reviews.length} 次复盘 · ${playbooks.filter(p=>p.state==='active').length + state.runbooks.filter(r=>r.state==='active').length} 个启用方案`);
  renderIdentity();
  const controls=(item,buttons)=>{ const row=node('div','actions'); for(const [label,fn] of buttons){const b=node('button','btn',label);b.onclick=()=>action(b,fn);row.append(b);}item.append(row); };
  const detail=(item,label,content)=>{const d=node('details');d.append(node('summary','text-button',label),node('pre','',content));item.append(d);};
  const lists=['review-list','runbook-list','script-list','memory-list']; for(const id of lists)$(id).replaceChildren();
  for(const r of state.reviews.slice().reverse()){
    const item=node('div','learning-item');item.append(node('h4','',r.result?.summary||'故障复盘'),node('small','',`${r.status} · 尝试 ${r.attempts} 次 · ${time(r.at)}`));
    if(r.result)item.append(node('p','',r.result.diagnosis));if(r.error)item.append(node('p','',r.error));
    controls(item,[['查看脱敏上传包',async()=>{const value=await api.review(r.id,'preview');detail(item,'上传内容',JSON.stringify(value,null,2));}],...(['failed','awaiting_approval'].includes(r.status)?[['确认 / 重试',()=>api.review(r.id,'approve')]]:[])]);$('review-list').append(item);
  }
  for(const p of playbooks.slice().reverse()){
    const item=node('div','learning-item');item.append(node('h4','',`${p.kind||'任意故障'}：${p.actions.join(' → ')}`),node('small','',`${{active:'已启用（真实故障验证）',candidate:'候选（待真实故障验证）',disabled:'已停用'}[p.state]||p.state} · 成功 ${p.successes} / 失败 ${p.failures} · ${time(p.at)}`),node('p','',`匹配信号：${p.signals.join('、')}\n${p.rationale}`));
    controls(item,[[p.state==='disabled'?'恢复为候选':'停用',()=>api.playbook(p.id,p.state==='disabled'?'candidate':'disabled')]]);$('runbook-list').append(item);
  }
  for(const r of state.runbooks.slice().reverse()){
    const item=node('div','learning-item');item.append(node('h4','',r.title),node('small','',`${r.state} · v${r.version} · ${r.match.platform} / ${r.match.kind}`),node('p','',r.description+'\n前置条件：'+r.preconditions));
    controls(item,[[r.state==='active'?'停用方案':'验证后启用',()=>api.runbook(r.id,r.state==='active'?'deactivate':'activate')]]);$('runbook-list').append(item);
  }
  for(const s of state.scripts.slice().reverse()){
    const item=node('div','learning-item');item.append(node('h4','',s.title),node('small','',`${s.purpose} · ${s.language} · ${s.id}`),node('small','',` SHA256 ${s.hash}`)); detail(item,'查看脚本源码',s.source);
    const run=state.scriptRuns.findLast(r=>r.scriptId===s.id);if(run)detail(item,`执行结果 · ${run.status} · ${run.verified?'探针通过':'未确认健康'}`,JSON.stringify(run,null,2));
    if(run?.outcomeUnknown && !run.orphanAcknowledged) { item.append(node('p','',`上次中断留下结果未知记录（PID ${run.pid || '未记录'}）。请先检查该进程，确认不会继续修改网络；本程序不会重放此版本。`)); controls(item,[['已检查进程，解除暂停',()=>api.script(run.id,'acknowledge-interrupted')]]); }
    controls(item,[...(state.config.scripts.approval==='per_script'&&s.approval!=='approved'?[['确认此版本',()=>api.script(s.id,'approve')]]:[]),['执行并验证',async()=>{const result=await api.script(s.id,'run');go('assistant');return result;}]]);$('script-list').append(item);
  }
  for(const m of state.memory.slice().reverse()){
    const item=node('div','learning-item');item.append(node('h4','',m.title),node('small','',`${m.verified?'有执行验证':'待核验经验'} · ${time(m.at)}`),node('p','',m.content));$('memory-list').append(item);
  }
  for(const id of lists)if(!$(id).children.length)$(id).append(node('p','empty','暂无记录'));
}
