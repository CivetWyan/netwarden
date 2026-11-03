import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeRouter, response } from './helpers.mjs';
import { RouterClient, setWanParams, wanDiff } from '../src/router.mjs';
import { classify } from '../src/probes.mjs';

const GOOD_DNS = ['203.0.113.53', '8.8.8.8'];
// Model mock: answers fast-decision prompts from a queue, everything else with a plain reply.
function modelQueue(decisions, calls = []) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push(body);
    if (body.messages[0].content.includes('快速决策器')) { const next = decisions.length > 1 ? decisions.shift() : decisions[0]; if (next instanceof Error) throw next; return response(JSON.stringify(next)); }
    if (body.messages[0].content.includes('复盘专家')) return response(JSON.stringify(calls.review || { summary: 's', diagnosis: 'd', lessons: [], playbook: null }));
    return response('分析完成');
  };
}
// Router config decides probe results: DNS works only with the good DNS servers and right gateway, speed must be auto.
function couple(ctx, router) {
  router.state.onChange = st => { ctx.kind = JSON.stringify(st.details.dns) === JSON.stringify(GOOD_DNS) && st.details.gateway === '198.51.100.254' && st.speed === 0 ? 'healthy' : st.details.gateway !== '198.51.100.254' ? 'upstream_failure' : 'dns_failure'; if (st.speed !== 0) st.link = 0; else st.link = 1; if (st.link === 0) ctx.kind = 'upstream_failure'; };
}
async function setup(t, { decisions = [{ action: 'router_restore_wan', reason: 'wan.dns_changed' }], calls = [], config = {} } = {}) {
  const router = fakeRouter(); const fx = fixture(t, { fetcher: modelQueue(decisions, calls), routerFetcher: router.fetcher });
  couple(fx.ctx, router);
  fx.app.store.saveConfig({ repair: { enabled: true, votes: 1, ...config.repair }, router: { enabled: true, host: 'http://192.0.2.1', password: router.password, baselineSettleMs: 0, rebootWaitMs: 60000, ...config.router } });
  fx.app.active = true;
  await fx.app.sensor.sample({ fresh: true }); // healthy → router baseline
  return { ...fx, router, calls };
}
async function incident(app) {
  await app.sensor.sample({ fresh: true });
  let task; for (let i = 0; i < 40 && !(task = app.tasks.list().findLast(t => t.kind === 'incident' && t.status === 'running') || app.tasks.list().findLast(t => t.kind === 'incident' && Date.now() - Date.parse(t.createdAt) < 3000)); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(task, '应当创建故障任务');
  await app.tasks.promises.get(task.id); return app.tasks.get(task.id);
}

test('路由器登录算法、状态读取、速率设置进入配置', async t => {
  const router = fakeRouter(); const { app } = fixture(t, { routerFetcher: router.fetcher });
  app.store.saveConfig({ router: { enabled: true, host: 'http://192.0.2.1', password: router.password } });
  const s = await app.router.status();
  assert.equal(s.reachable, true); assert.equal(s.wan.connected, true); assert.equal(s.config.speedSetting, '0'); assert.deepEqual(s.config.dns, GOOD_DNS);
});
test('路由器密码错误只尝试一次登录并暂停，避免锁定账号', async t => {
  const router = fakeRouter(); const { app } = fixture(t, { routerFetcher: router.fetcher });
  app.store.saveConfig({ router: { enabled: true, host: 'http://192.0.2.1', password: 'wrong-password' } });
  const a = await app.router.status(); const b = await app.router.status();
  assert.equal(router.state.failedLogins, 1); assert.ok(a.authError && b.authError);
  app.saveConfig({ router: { password: router.password } }); app.router.lastStatus = null;
  assert.equal((await app.router.status()).wan.connected, true);
});
test('客户端拒绝不在白名单的路由器接口（恢复出厂、改密码、改网段）', async () => {
  const store = { config: { router: { enabled: true, password: 'x', host: 'http://192.0.2.1', timeoutMs: 1000 } }, log() {} };
  const client = new RouterClient(store, async () => { throw Error('不应发出请求'); });
  for (const api of ['xqsystem/reset', 'xqsystem/set_name_password', 'xqnetwork/set_lan_ip', 'xqnetwork/set_wifi_ax']) await assert.rejects(client.call(api), /不在网管允许范围/);
});
test('WAN 基线映射为 set_wan 参数，拒绝残缺静态配置', () => {
  assert.deepEqual(setWanParams({ wanType: 'static', ipaddr: '1.2.3.4', netmask: '255.255.255.0', gateway: '1.2.3.1', dns: ['9.9.9.9'] }), { wanType: 'static', staticIp: '1.2.3.4', staticMask: '255.255.255.0', staticGateway: '1.2.3.1', dns1: '9.9.9.9' });
  assert.deepEqual(setWanParams({ wanType: 'dhcp', peerdns: '1' }), { wanType: 'dhcp', autoset: '1' });
  assert.throws(() => setWanParams({ wanType: 'static', ipaddr: '1.2.3.4' }), /不完整/);
  assert.deepEqual(wanDiff({ dns: ['a'] }, { dns: ['b'] }).map(d => d.field), ['dns']);
});
test('分类：路由器可达但 WAN 链路断开 / 本机到路由器不通', () => {
  const base = { network: { interfaces: [{ name: 'wlan0', addresses: [{}] }], routeKnown: true, route: { gateway: '192.0.2.1' } }, tcp: [{ ok: false }], dns: [{ ok: false }], http: { ok: false } };
  assert.equal(classify({ ...base, gateway: { ok: true }, router: { enabled: true, reachable: true, wan: { link: 0, connected: false } } }).kind, 'wan_link_down');
  assert.equal(classify({ ...base, gateway: { ok: false }, router: { enabled: true, reachable: false } }).kind, 'lan_failure');
});
test('WAN DNS 被改坏：分诊发现漂移，本地模型选择恢复基线，连续探针确认', async t => {
  const { app, router, ctx } = await setup(t);
  assert.deepEqual(app.routerBaseline.config.dns, GOOD_DNS);
  router.state.details.dns = ['10.255.255.1']; ctx.kind = 'dns_failure';
  const task = await incident(app);
  assert.equal(task.status, 'completed'); assert.equal(task.networkVerified, true);
  assert.deepEqual(router.state.details.dns, GOOD_DNS);
  assert.equal(task.steps[0].action, 'router_restore_wan'); assert.equal(task.steps[0].source, 'qwen');
  assert.ok(task.triage.signals.includes('wan.dns_changed'));
});
test('本地模型选了不在候选里的动作：判为无效票，按规则执行', async t => {
  const { app, router, ctx } = await setup(t, { decisions: [{ action: 'flush_dns', reason: '不适用' }] });
  router.state.details.dns = ['10.255.255.1']; ctx.kind = 'dns_failure';
  const task = await incident(app);
  assert.equal(task.steps[0].source, 'rule'); assert.equal(task.status, 'completed');
  assert.ok(app.store.events.some(e => e.type === 'decision' && e.data.votes?.[0]?.raw === 'flush_dns'));
});
test('本地模型先选了有效但错误的动作，根据失败反馈改选恢复基线', async t => {
  const { app, router, ctx } = await setup(t, { decisions: [{ action: 'router_reconnect_wan', reason: '先重连' }, { action: 'router_restore_wan', reason: '配置漂移' }] });
  router.state.details.dns = ['10.255.255.1']; ctx.kind = 'dns_failure';
  const task = await incident(app);
  assert.equal(task.status, 'completed'); assert.deepEqual(task.steps.map(s => [s.action, s.source, s.verified]), [['router_reconnect_wan', 'qwen', false], ['router_restore_wan', 'qwen', true]]);
});
test('模型选择重启路由器时，若仍有低代价候选，规则护栏改选', async t => {
  const { app, router, ctx } = await setup(t, { decisions: [{ action: 'router_reboot', reason: '直接重启' }] });
  router.state.details.gateway = '198.51.100.253'; ctx.kind = 'upstream_failure';
  const task = await incident(app);
  assert.equal(router.state.reboots, 0); assert.equal(task.steps[0].source, 'rule_guard'); assert.equal(task.steps[0].overridden, 'router_reboot'); assert.equal(task.status, 'completed');
});
test('本地模型不可用时按规则兜底，仍能恢复', async t => {
  const { app, router, ctx } = await setup(t, { decisions: [Error('model down')] });
  router.state.details.dns = ['10.255.255.1']; ctx.kind = 'dns_failure';
  const task = await incident(app);
  assert.equal(task.status, 'completed'); assert.equal(task.steps[0].source, 'rule'); assert.equal(task.steps[0].action, 'router_restore_wan');
});
test('WAN 速率被强制导致链路断开：恢复基线写回 speed=0', async t => {
  const { app, router, ctx } = await setup(t);
  router.state.speed = 100; router.state.link = 0; ctx.kind = 'upstream_failure';
  const task = await incident(app);
  assert.equal(task.status, 'completed'); assert.equal(router.state.speed, 0); assert.ok(router.state.writes.some(w => w.api === 'xqnetwork/set_wan_speed' && w.params.speed === '0'));
  assert.ok(!router.state.writes.some(w => w.api === 'xqnetwork/set_wan'), '只改有漂移的部分');
});
test('恢复后仍未通过验证：写回动作前配置，不留下未验证的改动', async t => {
  const { app, router, ctx } = await setup(t, { config: { repair: { enabled: true, votes: 1, maxActions: 1 } } });
  router.state.details.dns = ['10.255.255.1']; ctx.kind = 'dns_failure';
  router.state.onChange = () => {}; // fault is elsewhere: restoring DNS does not help
  const task = await incident(app);
  assert.equal(task.status, 'needs_attention'); assert.deepEqual(router.state.details.dns, ['10.255.255.1']);
  assert.ok(app.store.events.some(e => e.type === 'rollback' && /写回动作前配置/.test(e.message)));
});
test('健康时的新配置需稳定期满才成为基线，刚改坏的配置不会覆盖基线', async t => {
  const { app, router } = await setup(t, { config: { router: { baselineSettleMs: 3600000 } } });
  router.state.details.dns = ['223.5.5.5']; app.router.lastStatus = null; await app.sensor.sample({ fresh: true });
  assert.deepEqual(app.routerBaseline.config.dns, GOOD_DNS); assert.ok(app.routerPending);
});
test('复盘生成候选方案；下一次同类故障先用方案、成功后转为已启用，并跳过模型', async t => {
  const calls = []; const { app, router, ctx } = await setup(t, { calls });
  calls.review = { summary: 'DNS 被改', diagnosis: 'WAN DNS 漂移', qwenAssessment: '选对', lessons: ['wan.dns_changed 时先 router_restore_wan'], playbook: { kind: 'dns_failure', signals: ['wan.dns_changed'], actions: ['router_restore_wan', 'router_reconnect_wan'], rationale: 'DNS 配置漂移' } };
  app.store.saveConfig({ review: { enabled: true, upload: 'auto' }, onlineModel: { apiKey: 'test-key' } });
  router.state.details.dns = ['10.255.255.1']; ctx.kind = 'dns_failure';
  await incident(app); await app.background();
  const pb = app.playbooks.items[0]; assert.ok(pb, '应生成方案'); assert.equal(pb.state, 'candidate');
  assert.ok(app.memory.items.some(m => m.tags.includes('online-review') && m.content.includes('router_restore_wan')));
  // second occurrence: candidate is offered to the model and validated by the outcome
  router.state.details.dns = ['10.255.255.2']; ctx.kind = 'dns_failure';
  await incident(app);
  assert.equal(app.playbooks.items[0].state, 'active');
  // third occurrence: active playbook is executed directly without a model decision
  const before = calls.filter(c => c.messages[0].content.includes('快速决策器')).length;
  router.state.details.dns = ['10.255.255.3']; ctx.kind = 'dns_failure';
  const third = await incident(app);
  assert.equal(third.steps[0].source, 'playbook'); assert.equal(calls.filter(c => c.messages[0].content.includes('快速决策器')).length, before);
});
test('在线方案只接受固定词表信号与白名单动作，重启只能放最后', async t => {
  const { app } = fixture(t);
  assert.throws(() => app.playbooks.create({ signals: ['made.up'], actions: ['router_restore_wan'] }), /固定词表/);
  assert.throws(() => app.playbooks.create({ signals: ['wan.dns_changed'], actions: ['rm -rf'] }), /白名单/);
  assert.throws(() => app.playbooks.create({ signals: ['wan.dns_changed'], actions: ['router_reboot', 'router_restore_wan'] }), /最后/);
});

test('断网时中止进行中的例行巡检并立即处理故障', async t => {
  const { app, router, ctx } = await setup(t);
  let release; const blocked = new Promise(r => { release = r; });
  app.tasks.start('patrol', '模拟长巡检', async (_task, signal) => { await new Promise((r, j) => { signal.addEventListener('abort', () => j(Error('cancelled')), { once: true }); blocked.then(r); }); return { result: 'x' }; });
  router.state.details.dns = ['10.255.255.1']; ctx.kind = 'dns_failure';
  const task = await incident(app); release();
  assert.equal(task.status, 'completed'); assert.equal(app.tasks.list().find(x => x.kind === 'patrol').status, 'cancelled');
});

test('方案的匹配信号必须在源故障中实际出现过', async t => {
  const { app } = fixture(t);
  assert.throws(() => app.playbooks.create({ signals: ['wan.link_down', 'wan.config_drift'], actions: ['router_reconnect_wan'] }, { observed: ['wan.link_down'] }), /未出现的信号/);
  assert.ok(app.playbooks.create({ signals: ['wan.link_down'], actions: ['router_reconnect_wan'] }, { observed: ['wan.link_down', 'internet.tcp_failed'] }));
});
test('网络拦截所有 53 端口查询时，分诊丢弃定向 DNS 信号', async t => {
  const { app, router, ctx } = await setup(t);
  ctx.dnsServers = () => true; // even 192.0.2.53 "answers"
  router.state.details.dns = ['10.255.255.1']; ctx.kind = 'dns_failure';
  const task = await incident(app);
  assert.ok(task.triage.signals.includes('dns.intercepted')); assert.ok(!task.triage.signals.includes('public_dns.ok'));
  assert.equal(task.status, 'completed');
});

import { randomMac, subnetRange, pickCandidates, isMac } from '../src/identity.mjs';

test('身份工具：随机本地管理 MAC、子网范围、候选 IP 顺序', () => {
  const m = randomMac(); assert.ok(isMac(m)); assert.equal(parseInt(m.slice(0, 2), 16) & 0x03, 0x02);
  assert.ok(randomMac(['AA:BB:CC:DD:EE:FF']) !== undefined);
  const r = subnetRange('198.51.100.113', '255.255.255.0'); assert.ok(r.contains('198.51.100.231')); assert.ok(!r.contains('203.0.113.1'));
  const c = pickCandidates({ wanType: 'static', ipaddr: '198.51.100.113', netmask: '255.255.255.0', gateway: '198.51.100.254' }, { preferred: ['198.51.100.114', '198.51.100.231'], skip: ['198.51.100.231'], count: 3 });
  assert.equal(c[0], '198.51.100.114'); assert.ok(!c.includes('198.51.100.231')); assert.ok(!c.includes('198.51.100.113')); assert.ok(!c.includes('198.51.100.254'));
});

// Router helper that simulates a campus ban: the current (ip,mac) tuple is blocked; any other free
// identity restores connectivity. Occupancy/ban are expressed through ctx so probes and sensor agree.
async function setupBan(t, { decisions = [{ action: 'router_change_identity', reason: 'wan.suspected_ban' }], busyIps = ['198.51.100.50'], preferred = ['198.51.100.231'] } = {}) {
  const router = fakeRouter(); const calls = [];
  const fx = fixture(t, { fetcher: modelQueue(decisions, calls), routerFetcher: router.fetcher });
  const banned = { ip: router.state.details.ipaddr, mac: router.state.mac.toUpperCase() };
  const recompute = () => { const blocked = router.state.details.ipaddr === banned.ip && router.state.mac.toUpperCase() === banned.mac; fx.ctx.kind = blocked ? 'upstream_failure' : 'healthy'; fx.ctx.upstreamOk = !blocked; };
  router.state.onChange = recompute; recompute();
  // Neighbours: witnesses answer (segment alive); busyIps answer (occupied); banned/candidate do not.
  fx.ctx.upstreamHosts = ip => busyIps.includes(ip) || fx.ctx.witnessSet?.has(ip);
  fx.app.store.saveConfig({ repair: { enabled: true, votes: 1 }, router: { enabled: true, host: 'http://192.0.2.1', password: router.password, baselineSettleMs: 0, allowIdentityChange: true, identityIps: preferred } });
  fx.app.active = true;
  fx.app.identity.state.witnesses = ['198.51.100.9']; fx.ctx.witnessSet = new Set(['198.51.100.9']);
  await fx.app.sensor.sample({ fresh: true });
  return { ...fx, router, banned, calls };
}

test('疑似封禁分诊：WAN 正常无漂移、同网段邻居可达但上游不通 → suspected_ban', async t => {
  const { app, router } = await setupBan(t);
  const card = await (await import('../src/triage.mjs')).triage(app, await app.sensor.sample({ fresh: true }));
  assert.equal(card.layer, 'suspected_ban'); assert.ok(card.signals.includes('wan.suspected_ban')); assert.ok(card.signals.includes('wan.segment_alive'));
  assert.equal(card.candidates[0].action, 'router_change_identity');
});

test('邻居全不可达时归为整段上游断网，不更换身份', async t => {
  const { app, ctx } = await setupBan(t);
  ctx.witnessSet = new Set(); // no neighbour answers now
  const card = await (await import('../src/triage.mjs')).triage(app, await app.sensor.sample({ fresh: true }));
  assert.ok(!card.signals.includes('wan.suspected_ban')); assert.ok(card.signals.includes('wan.segment_down'));
  assert.ok(!card.candidates.some(c => c.action === 'router_change_identity'));
});

test('疑似封禁：更换 MAC 与空闲 IP 后恢复，旧身份记入封禁名单', async t => {
  const { app, router, banned } = await setupBan(t);
  const task = await incident(app);
  assert.equal(task.status, 'completed'); assert.equal(task.steps[0].action, 'router_change_identity');
  assert.equal(router.state.details.ipaddr, '198.51.100.231'); // preferred free IP taken
  assert.ok(router.state.mac.toUpperCase() !== banned.mac); // MAC changed
  assert.ok(app.identity.state.banned.some(b => b.ip === banned.ip && b.mac === banned.mac));
  assert.ok(router.state.writes.some(w => w.api === 'xqnetwork/mac_clone'));
});

test('换上的 IP 仍不通时，自动换回原 MAC 与原 IP', async t => {
  const { app, router, banned } = await setupBan(t);
  // The outage is not escapable: every identity stays blocked, so verification never passes.
  router.state.onChange = () => { app.sensor; }; // leave ctx at upstream_failure regardless of identity
  router.state.onChange(); // ctx already upstream_failure from setup; keep it
  const card0 = app.sensor.current;
  // Make ctx permanently failed by overriding the probe view used by the sensor fixture:
  const prev = app.sensor.probes.tcp; app.sensor.probes.tcp = async (h, port) => ({ host: h, port, ok: false, ms: 3 });
  app.sensor.probes.upstream = async host => ({ ok: host === '198.51.100.9', gateway: host, ms: 1 }); // witness alive, upstream gw dead, candidates free
  app.store.saveConfig({ repair: { maxActions: 1 }, router: { allowReboot: false, allowReconnect: false } }); // isolate the identity attempt
  const task = await incident(app);
  assert.equal(task.status, 'needs_attention');
  assert.equal(router.state.details.ipaddr, banned.ip);
  assert.equal(router.state.mac.toUpperCase(), banned.mac);
  app.sensor.probes.tcp = prev;
});
test('更换身份未授权时不出现在候选中', async t => {
  const { app } = await setupBan(t);
  app.store.saveConfig({ router: { allowIdentityChange: false } });
  const card = await (await import('../src/triage.mjs')).triage(app, await app.sensor.sample({ fresh: true }));
  assert.ok(!card.candidates.some(c => c.action === 'router_change_identity'));
});
