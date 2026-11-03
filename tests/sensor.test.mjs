import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

for (const kind of ['healthy', 'dns_failure', 'no_route', 'link_down', 'upstream_failure', 'captive_portal']) test(`感知器识别 ${kind}`, async t => {
  const { app } = fixture(t, { kind }); const sample = await app.sensor.sample({ fresh: true }); assert.equal(sample.health.kind, kind);
});
test('故障与恢复都需要达到连续次数，单次失败不触发稳定离线', async t => {
  const { app, ctx } = fixture(t); app.store.saveConfig({ monitor: { failureThreshold: 2, recoveryThreshold: 2 } });
  await app.sensor.sample(); assert.equal(app.sensor.stable, 'unknown'); await app.sensor.sample(); assert.equal(app.sensor.stable, 'healthy');
  ctx.kind = 'dns_failure'; await app.sensor.sample(); assert.equal(app.sensor.stable, 'healthy'); await app.sensor.sample(); assert.equal(app.sensor.stable, 'offline');
  ctx.kind = 'healthy'; await app.sensor.sample(); assert.equal(app.sensor.stable, 'offline'); await app.sensor.sample(); assert.equal(app.sensor.stable, 'healthy');
});
test('重叠探测合并，避免并行触发重复恢复', async t => {
  const { app } = fixture(t); let count = 0; app.platform.inspect = async () => { count++; return { platform: 'linux', interfaces: [], routeKnown: true, route: null }; };
  const samples = await Promise.all([app.sensor.sample({ fresh: true }), app.sensor.sample({ fresh: true }), app.sensor.sample()]);
  assert.equal(count, 1); assert.equal(samples[0].id, samples[2].id);
});
test('认证门户和单个被阻断探针不会误判为完全断网', async t => {
  const { app, ctx } = fixture(t); app.sensor.probes.tcp = async (host, port) => ({ host, port, ok: host === '1.1.1.1', ms: 1 });
  assert.equal((await app.sensor.sample()).health.kind, 'partial_failure');
  ctx.kind = 'captive_portal'; assert.equal((await app.sensor.sample()).health.kind, 'captive_portal');
});
test('HTTP单点超时保留警告，但不阻止核心连通性恢复确认', async t => {
  const { app } = fixture(t); app.sensor.probes.http = async () => ({ ok: false, error: 'timeout' });
  const sample = await app.sensor.sample(); assert.equal(sample.health.kind, 'healthy'); assert.ok(sample.health.warnings.length);
});
test('只诊断默认模式不执行任何恢复', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ model: { name: '' } }); app.active = true;
  await app.sensor.sample(); const task = app.tasks.list().at(-1); await app.tasks.promises.get(task.id);
  assert.equal(task.status, 'needs_attention'); assert.equal(ctx.actions.length, 0);
});
test('只读 diagnose 不开启自动恢复调度', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true } });
  await app.sensor.sample(); assert.equal(app.tasks.list().length, 0); assert.equal(ctx.actions.length, 0);
});
test('同一持续故障只触发一个自动任务', async t => {
  const { app } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ model: { name: '' } }); app.active = true;
  await app.sensor.sample(); const first = app.tasks.list().at(-1); await app.tasks.promises.get(first.id);
  await app.sensor.sample(); await app.sensor.sample(); assert.equal(app.tasks.list().length, 1);
});
