import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, response } from './helpers.mjs';

test('快速恢复在模型未配置时也能修复并独立确认', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true }, model: { name: '' } }); app.active = true;
  app.platform.repair = async action => { ctx.actions.push(action); ctx.kind = 'healthy'; return { ok: true }; };
  await app.sensor.sample(); const task = app.tasks.list().at(-1); await app.tasks.promises.get(task.id);
  assert.equal(task.status, 'completed'); assert.equal(task.networkVerified, true); assert.deepEqual(ctx.actions, ['flush_dns']);
});
test('模型文字宣布成功不能覆盖失败的现场探针', async t => {
  let requests = 0; const { app } = fixture(t, { kind: 'dns_failure', fetcher: async () => { requests++; return response('网络已经修复。'); } }); app.active = true;
  await app.sensor.sample(); const task = app.tasks.list().at(-1); await app.tasks.promises.get(task.id);
  assert.equal(task.status, 'needs_attention'); assert.equal(task.networkVerified, false); assert.equal(app.sensor.current.health.kind, 'dns_failure'); assert.ok(requests >= 2);
});
test('现场采集期间撤销授权会阻止尚未执行的动作', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true } });
  const evidence = await app.sensor.sample(); let release; app.sensor.sample = () => new Promise(resolve => { release = () => resolve(evidence); });
  const pending = app.repair.execute('flush_dns', '测试'); app.store.saveConfig({ repair: { enabled: false } }); release();
  assert.equal((await pending).blocked, true); assert.equal(ctx.actions.length, 0);
});
test('DNS替换未达核心健康时会恢复原DNS，不把命令成功当成恢复', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true, allowDnsChange: true } });
  app.platform.repair = async (action, connection, servers) => { ctx.actions.push({ action, connection, servers }); if (action === 'set_dns') ctx.kind = 'captive_portal'; return { ok: true }; };
  const result = await app.repair.execute('set_dns', '测试'); assert.equal(result.verified, false); assert.equal(result.commandOk, true); assert.deepEqual(ctx.actions.map(a => a.action), ['set_dns', 'restore_dns']); assert.equal(app.repair.rollback, null);
});
test('模型超时结束任务，感知器仍可继续采样', async t => {
  const { app } = fixture(t, { fetcher: async (_u, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('model timeout')), { once: true })) });
  app.store.saveConfig({ model: { timeoutMs: 1000 } }); const task = app.ask('检查'); const work = app.tasks.promises.get(task.id);
  // A real running sensor keeps the event loop alive while AbortSignal.timeout expires.
  const timer = setInterval(() => {}, 100); try { await work; } finally { clearInterval(timer); }
  assert.equal(task.status, 'failed'); assert.equal((await app.sensor.sample()).health.kind, 'healthy');
});
test('健康网络切换后自动更新基线，避免断网时重连旧网络', async t => {
  const { app, ctx } = fixture(t); app.active = true; await app.sensor.sample(); assert.equal(app.store.baseline.network.connection.name, 'Wired');
  ctx.network = structuredClone(app.sensor.current.network); ctx.network.connection.name = 'Office'; ctx.network.connection.uuid = 'aabbccdd-1111-2222-3333-999999999999';
  await app.sensor.sample({ fresh: true }); assert.equal(app.store.baseline.network.connection.name, 'Office');
});
