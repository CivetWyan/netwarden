import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, network } from './helpers.mjs';
import { Repair } from '../src/repair.mjs';

test('只诊断模式阻止模型发出的修复动作', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); const result = await app.repair.execute('flush_dns', '模型建议'); assert.equal(result.blocked, true); assert.equal(ctx.actions.length, 0);
});
test('网络健康时拒绝变更网络，即使启用了自动恢复', async t => {
  const { app, ctx } = fixture(t); app.store.saveConfig({ repair: { enabled: true } }); const result = await app.repair.execute('reconnect', '测试'); assert.equal(result.blocked, true); assert.equal(ctx.actions.length, 0);
});
test('静态地址不能执行 DHCP 续租', async t => {
  const { app, ctx } = fixture(t, { kind: 'no_route' }); ctx.network = network('no_route'); ctx.network.connection.method = 'manual'; app.store.saveConfig({ repair: { enabled: true } });
  assert.equal((await app.repair.execute('renew_dhcp', '测试')).blocked, true); assert.equal(ctx.actions.length, 0);
});
test('命令完成后必须由连续健康探针确认恢复', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true }, monitor: { recoveryThreshold: 2 } });
  app.platform.repair = async action => { ctx.actions.push(action); ctx.kind = 'healthy'; return { ok: true, code: 0 }; };
  const result = await app.repair.execute('flush_dns', '测试', { incidentId: 'x' }); assert.equal(result.verified, true); assert.equal(result.samples.length, 2); assert.ok(app.store.events.some(e => e.type === 'verification'));
});
test('修复失败先保存执行反馈，同一故障不重复动作，重启后仍保留记录', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true } }); app.platform.repair = async action => { ctx.actions.push(action); return { ok: false, code: 1, stderr: 'permission denied' }; };
  const first = await app.repair.execute('flush_dns', '测试', { incidentId: 'same' }); assert.equal(first.ok, false);
  app.repair = new Repair(app.store, app.platform, app.sensor);
  const second = await app.repair.execute('flush_dns', '再试', { incidentId: 'same' }); assert.equal(second.blocked, true); assert.equal(ctx.actions.length, 1);
  assert.ok(app.store.events.some(e => e.type === 'action_result' && e.data.result.stderr === 'permission denied'));
});
test('取消 DNS 替换时按持久化事务恢复原配置', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true, allowDnsChange: true } });
  const controller = new AbortController();
  app.platform.repair = async (action, connection, servers) => { ctx.actions.push({ action, connection, servers }); if (action === 'set_dns') { assert.ok(app.store.read('rollback.json', null)); controller.abort(); } return { ok: true }; };
  const result = await app.repair.execute('set_dns', '测试', { signal: controller.signal }); assert.equal(result.cancelled, true); assert.deepEqual(ctx.actions.map(a => a.action), ['set_dns', 'restore_dns']); assert.equal(app.store.read('rollback.json', 1), null);
});
test('程序启动优先回滚未完成事务，失败时保留供重试', async t => {
  const { app } = fixture(t, { kind: 'dns_failure' }); const journal = { connection: network().connection, servers: ['192.168.8.1'] }; app.store.write('rollback.json', journal);
  app.repair = new Repair(app.store, app.platform, app.sensor); app.platform.repair = async () => ({ ok: false, stderr: 'permission' }); await app.repair.recoverPending(); assert.ok(app.store.read('rollback.json', null));
  app.platform.repair = async () => ({ ok: true }); await app.repair.recoverPending(); assert.equal(app.store.read('rollback.json', 1), null);
});
test('DNS 变更需要额外授权，且必须匹配 DNS 故障', async t => {
  const { app, ctx } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true } }); assert.equal((await app.repair.execute('set_dns', '测试')).blocked, true);
  app.store.saveConfig({ repair: { allowDnsChange: true } }); ctx.kind = 'upstream_failure'; assert.equal((await app.repair.execute('set_dns', '测试')).blocked, true); assert.equal(ctx.actions.length, 0);
});
test('并行恢复互斥，防止模型与后台任务同时修改网卡', async t => {
  const { app } = fixture(t, { kind: 'dns_failure' }); app.store.saveConfig({ repair: { enabled: true } }); let release;
  app.platform.repair = () => new Promise(resolve => { release = resolve; }); const pending = app.repair.execute('flush_dns', '测试');
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await app.repair.execute('reconnect', '并行')).blocked, true); release({ ok: false }); await pending;
});
test('未知动作不能进入系统执行器', async t => {
  const { app, ctx } = fixture(t); await assert.rejects(app.repair.execute('rm -rf', 'bad'), /白名单/); assert.equal(ctx.actions.length, 0);
});
