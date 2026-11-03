import { tcpProbe, dnsQuery, dnsProbe } from './probes.mjs';
import { wanDiff } from './router.mjs';
import { triage } from './triage.mjs';
import { validHost } from './store.mjs';

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = description => ({ type: 'string', description, maxLength: 2000 });
const definitions = [
  ['inspect_network', '重新采集本机网卡、路由、DNS和连通性，返回现场证据', object()],
  ['search_knowledge', '离线检索HCIA原理，返回片段ID和来源。VRP命令不能直接用于本机', object({ query: str('具体的网络概念或故障关键词') }, ['query'])],
  ['read_events', '读取最近的执行反馈、退出码和诊断日志，修复失败后必须先读', object()],
  ['run_diagnostic', '运行固定的只读系统网络诊断', object({ topic: { type: 'string', enum: ['routes', 'neighbors', 'resolver', 'links'] } }, ['topic'])],
  ['probe_host', '检查到指定主机端口的TCP连接能否建立。端口可连通只说明端口开放，不等于网页能打开或已登录', object({ host: str('域名或IP'), port: { type: 'integer', minimum: 1, maximum: 65535 } }, ['host'])],
  ['dns_query', '解析域名。不填server时用系统解析器；填server（IP）时直接向该DNS服务器查询，结果能证明该服务器是否应答', object({ name: str('要解析的域名，如 www.baidu.com'), server: str('可选：DNS服务器IP') }, ['name'])],
  ['router_status', '读取路由器（小米BE6500）WAN状态、当前WAN配置与健康基线的差异，并做分层分诊（本机/局域网/路由器配置/WAN/上游DNS/运营商）', object()],
  ['router_action', '对路由器执行授权动作：restore_wan=恢复WAN到健康基线（仅配置漂移时有效）；reconnect_wan=按当前配置重连WAN；change_identity=更换WAN口MAC并切到同网段空闲静态IP（用于疑似被园区按IP/MAC封禁，运营方认可的解封方式）；reboot=重启路由器（全网断开约2分钟，最后手段）。动作前后自动快照、读回与连续探针验证，失败自动回滚', object({ action: { type: 'string', enum: ['restore_wan', 'reconnect_wan', 'change_identity', 'reboot'] }, reason: str('依据哪些现场证据') }, ['action', 'reason'])],
  ['http_check', '对局域网或外网URL发一次HTTP GET（不跟随跳转、不带凭据），返回状态码、跳转地址和页面标题。用于确认“网页能打开”，不代表已登录', object({ url: str('http(s)://...') }, ['url'])],
  ['verify_network', '连续探测直到达到恢复确认次数，依据现场判断目标是否完成', object()],
  ['update_plan', '更新任务步骤；completed只表示步骤结束，网络目标仍由独立探针确认', object({ steps: { type: 'array', minItems: 1, maxItems: 5, items: object({ title: str('步骤内容'), status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] } }, ['title', 'status']) } }, ['steps'])],
  ['repair_network', '按授权恢复网络，动作前采集证据，动作后独立验证。失败不要重复', object({ action: { type: 'string', enum: ['flush_dns', 'renew_dhcp', 'reconnect', 'set_dns'] }, reason: str('基于哪些现场证据决定执行') }, ['action', 'reason'])],
  ['delegate_analysis', '创建只读专家后台任务，不阻塞传感器。不会嵌套委派', object({ role: { type: 'string', enum: ['knowledge', 'diagnostic'] }, objective: str('明确的子问题') }, ['role', 'objective'])],
  ['get_task', '读取本任务的专家后台结果；running时继续收集其他证据', object({ id: str('delegate_analysis返回的任务ID') }, ['id'])]
];
definitions.push(
  ['create_script', '编写并保存临时工具或脚本，返回不可变脚本ID。执行由独立开关控制', object({ title: str('脚本作用'), language: { type: 'string', enum: ['node', 'python', 'shell', 'powershell'] }, source: { type: 'string', maxLength: 24000 }, purpose: { type: 'string', enum: ['diagnostic', 'repair', 'verify', 'rollback'] }, rollbackId: str('可选的已保存回滚脚本ID') }, ['title', 'language', 'source', 'purpose'])],
  ['run_script', '执行已保存的脚本并收集退出码、输出和独立探针验证。失败先查日志；不重放同版本', object({ id: str('脚本ID'), background: { type: 'boolean' } }, ['id'])],
  ['read_script_runs', '读取临时脚本执行账本，检查中断、不确定结果和失败原因', object()],
  ['search_memory', '查询跨会话长期经验；未验证的复盘结论只作为假设', object({ query: str('经验关键词') }, ['query'])],
  ['remember', '保存有来源的经验草稿，不会自动授权执行', object({ title: str('记忆标题'), content: str('事实、假设和适用前提') }, ['title', 'content'])],
  ['read_session_history', '读取本会话被压缩的历史消息和工具结果', object({ offset: { type: 'integer', minimum: 0, maximum: 25 } })],
  ['set_goal', '细化本任务成功条件。故障恢复任务始终保留独立网络验证条件', object({ condition: str('可核验的成功条件') }, ['condition'])],
  ['list_runbooks', '读取已验证或待验证的长期方案及脚本ID；不能把候选当成已验证', object()],
  ['read_sensor_history', '读取最近120次探测与延迟统计，并与上次巡检比较；不等于带宽测速', object()]
);
export function validate(schema, value) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('参数必须是对象');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw Error(`缺少参数 ${key}`);
    for (const [key, v] of Object.entries(value)) { if (!Object.hasOwn(schema.properties, key)) throw Error(`未知参数 ${key}`); validate(schema.properties[key], v); }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) throw Error('列表长度无效');
    for (const item of value) validate(schema.items, item);
  } else if (schema.type === 'string' && (typeof value !== 'string' || value.length > (schema.maxLength || 2000))) throw Error('字符串参数无效');
  else if (schema.type === 'boolean' && typeof value !== 'boolean') throw Error('布尔参数无效');
  else if (schema.type === 'integer' && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) throw Error('整数参数超出范围');
  if (schema.enum && !schema.enum.includes(value)) throw Error('参数值不在允许范围');
}
export class Tools {
  constructor(app) { this.app = app; }
  catalog(readOnly = false) { return definitions.filter(([name]) => !readOnly || !['repair_network', 'router_action', 'delegate_analysis', 'get_task', 'update_plan', 'create_script', 'run_script', 'remember', 'set_goal'].includes(name)).map(([name, description, parameters]) => ({ type: 'function', function: { name, description, parameters } })); }
  async call(name, args, context) {
    const catalog = this.catalog(context.readOnly); const definition = catalog.find(d => d.function.name === name);
    if (!definition) throw Error(`未知或未授权工具: ${name}`);
    validate(definition.function.parameters, args); context.signal?.throwIfAborted();
    const a = this.app;
    switch (name) {
      case 'inspect_network': { const s = await a.sensor.sample({ fresh: true }); return { health: s.health, at: s.at, tcp: s.tcp, dns: s.dns, http: s.http, gateway: s.gateway, network: s.network }; }
      case 'search_knowledge': return a.knowledge.search(args.query);
      case 'read_events': return a.store.events.slice(-20);
      case 'run_diagnostic': return a.platform.diagnose(args.topic, context.signal);
      case 'probe_host':
        if (!validHost(args.host)) throw Error('主机格式无效');
        return { ...await tcpProbe(args.host, args.port || 443, a.store.config.monitor.probeTimeoutMs, context.signal), meaning: 'TCP 握手结果；不代表应用层可用' };
      case 'dns_query': {
        if (!validHost(args.name)) throw Error('域名格式无效');
        if (args.server && !/^\d{1,3}(\.\d{1,3}){3}$/.test(args.server)) throw Error('server 必须是 IPv4 地址');
        if (!args.server) return { ...await dnsProbe(args.name, a.store.config.monitor.probeTimeoutMs, context.signal), server: 'system' };
        const [r, bogus] = await Promise.all([dnsQuery(args.name, args.server, a.store.config.monitor.probeTimeoutMs, context.signal), dnsQuery('www.baidu.com', '192.0.2.53', a.store.config.monitor.probeTimeoutMs, context.signal)]);
        const intercepted = bogus.ok || bogus.error === 'ENOTFOUND';
        return { ...r, intercepted, meaning: intercepted ? '注意：本网络会拦截并代答所有 53 端口查询（连不存在的 192.0.2.53 都有应答），此结果不能证明指定服务器可用' : '直接向该服务器查询的结果' };
      }
      case 'router_status': {
        if (!a.router.enabled) return { enabled: false, note: '未启用路由器管理' };
        a.router.lastStatus = null; const snap = await a.sensor.sample({ fresh: true });
        const card = await triage(a, snap, context.signal);
        return { router: snap.router, baseline: a.routerBaseline ? { at: a.routerBaseline.at, config: a.routerBaseline.config } : null, drift: a.routerBaseline && snap.router?.config ? wanDiff(a.routerBaseline.config, snap.router.config) : [], triage: { layer: card.layer, summary: card.summary, signals: card.signals, candidates: card.candidates.map(x => x.action), evidence: card.evidence }, health: snap.health };
      }
      case 'router_action': return a.repair.execute(`router_${args.action}`, args.reason, { signal: context.signal, incidentId: context.incidentId || context.task.id });
      case 'http_check': {
        let u; try { u = new URL(args.url); } catch { throw Error('URL 无效'); }
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('只允许不含凭据的 http(s) URL');
        const started = Date.now();
        try {
          const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)].filter(Boolean)) });
          const text = (await res.text()).slice(0, 20000);
          return { ok: res.status < 400, status: res.status, location: res.headers.get('location')?.slice(0, 300), title: text.match(/<title[^>]*>([^<]{0,200})/i)?.[1]?.trim() || null, bytes: text.length, ms: Date.now() - started, meaning: '收到HTTP响应=网页可访问；未登录、未读取后台数据' };
        } catch (e) { return { ok: false, error: e.cause?.code || e.message, ms: Date.now() - started }; }
      }
      case 'verify_network': return a.verify(context.signal);
      case 'update_plan': return a.tasks.update(context.task.id, { plan: args.steps }).plan;
      case 'repair_network': return a.repair.execute(args.action, args.reason, { signal: context.signal, incidentId: context.incidentId || context.task.id });
      case 'delegate_analysis': {
        const siblings = a.tasks.list().filter(t => t.parentId === context.task.id && ['knowledge', 'diagnostic'].includes(t.kind));
        if (siblings.some(t => t.kind === args.role) || siblings.length >= 2) throw Error('每个任务每种专家只允许创建一次，最多两个');
        return a.tasks.start(args.role, args.objective, (task, signal) => a.agent.run(task, signal, { role: args.role, readOnly: true }), { parentId: context.task.id, signal: context.signal });
      }
      case 'get_task': {
        const task = a.tasks.get(args.id); if (!task || task.parentId !== context.task.id) throw Error('只能读取本任务创建的专家任务'); return task;
      }
      case 'create_script': return a.scripts.create({ ...args, platforms: [a.platform.platform] }, { taskId: context.task.id, incidentId: context.incidentId });
      case 'run_script': {
        if (!args.background) return a.scripts.run(args.id, { taskId: context.task.id, incidentId: context.incidentId, signal: context.signal });
        return a.tasks.start('script', `后台脚本：${a.scripts.get(args.id).title}`, async (_task, signal) => {
          const result = await a.scripts.run(args.id, { taskId: context.task.id, incidentId: context.incidentId, signal }); return { result: JSON.stringify(result), status: result.ok ? 'completed' : 'needs_attention' };
        }, { parentId: context.task.id, signal: context.signal });
      }
      case 'read_script_runs': return a.scripts.runs.filter(r => r.taskId === context.task.id || r.incidentId && r.incidentId === context.incidentId).slice(-10);
      case 'search_memory': return a.memory.search(args.query);
      case 'remember': return a.memory.add({ ...args, source: { taskId: context.task.id }, verified: false, tags: ['local-agent'] });
      case 'read_session_history': return a.sessions.history(context.task.id, args.offset || 0);
      case 'set_goal': return a.tasks.update(context.task.id, { goal: { ...context.task.goal, condition: args.condition, checks: 0 } }).goal;
      case 'list_runbooks': return { playbooks: a.playbooks.items.slice(-20), scriptRunbooks: a.runbooks.items.slice(-20) };
      case 'read_sensor_history': return { statistics: a.sensor.statistics(), previousPatrol: a.lastPatrolMetrics, history: a.sensor.history };
    }
  }
}
