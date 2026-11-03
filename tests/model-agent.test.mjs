import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, response, call } from './helpers.mjs';
import { Model, completionUrl } from '../src/model.mjs';
import { compact } from '../src/agent.mjs';

test('兼容 Base URL 与完整 completions 端点', () => {
  assert.equal(completionUrl('http://localhost:1234/v1/'), 'http://localhost:1234/v1/chat/completions'); assert.equal(completionUrl('https://api.example.com'), 'https://api.example.com/v1/chat/completions'); assert.equal(completionUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
});
test('原生工具回传完整ID和结果，错误参数反馈给模型而不执行', async t => {
  const requests = []; let i = 0;
  const { app, ctx, dir } = fixture(t, { fetcher: async (_url, request) => { const body = JSON.parse(request.body); requests.push(body); i++; if (i === 1) return response('', [call('run_diagnostic', { topic: 'resolver', shell: 'bad' }, 'bad')]); if (i === 2) return response('', [call('inspect_network', {}, 'inspect')]); return response('已读取实际网络，当前正常。'); } });
  await app.sensor.sample(); const task = app.ask('分析当前网络'); await app.tasks.promises.get(task.id);
  assert.equal(task.status, 'completed'); assert.match(requests[1].messages.find(m => m.tool_call_id === 'bad').content, /未知参数/); assert.ok(requests[2].messages.some(m => m.tool_call_id === 'inspect')); assert.equal(ctx.actions.length, 0); assert.ok(fs.existsSync(path.join(dir, 'transcripts', `${task.id}.jsonl`)));
});
test('JSON模式支持无原生Function Calling的小模型', async t => {
  let i = 0; const requests = [];
  const { app } = fixture(t, { fetcher: async (_u, request) => { const b = JSON.parse(request.body); requests.push(b); return ++i === 1 ? response('{"tool":"inspect_network","arguments":{}}') : response('{"final":"基于现场的诊断完成"}'); } }); app.store.saveConfig({ model: { mode: 'json' } });
  const task = app.ask('诊断'); await app.tasks.promises.get(task.id); assert.equal(task.status, 'completed'); assert.match(task.result, /基于现场/); assert.equal(requests[0].tools, undefined); assert.ok(requests[1].messages.some(m => m.content?.startsWith('工具反馈')));
});
test('模型HTTP错误不会取消感知器或泄漏Key到日志', async t => {
  const key = 'secret-key-for-test'; const { app, dir } = fixture(t, { fetcher: async () => new Response(`denied ${key}`, { status: 401 }) }); app.store.saveConfig({ model: { apiKey: key } });
  const task = app.ask('诊断'); await app.tasks.promises.get(task.id); assert.equal(task.status, 'failed'); assert.match(task.error, /REDACTED/); assert.equal((await app.sensor.sample()).health.kind, 'healthy'); assert.ok(!fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes(key));
});
test('决策轮数限制阻止无尽工具循环', async t => {
  let requests = 0; const { app } = fixture(t, { fetcher: async () => { requests++; return response('', [call('inspect_network')]); } }); app.store.saveConfig({ model: { maxTurns: 2 } });
  const task = app.ask('一直检查'); await app.tasks.promises.get(task.id); assert.equal(requests, 2); assert.match(task.result, /轮数上限/);
});
test('只读专家无法调用修复工具', async t => {
  const { app, ctx } = fixture(t); const task = app.tasks.start('knowledge', '专家', async (task, signal) => {
    await assert.rejects(app.tools.call('repair_network', { action: 'flush_dns', reason: 'test' }, { task, signal, readOnly: true }), /未授权/); return { result: 'read-only' };
  }); await app.tasks.promises.get(task.id); assert.equal(ctx.actions.length, 0);
});
test('后台专家有独立消息和受限工具，并把结果送回主循环', async t => {
  let rootCount = 0; let expertCount = 0; const sent = [];
  const { app } = fixture(t, { fetcher: async (_u, request) => {
    const body = JSON.parse(request.body); sent.push(body);
    if (body.messages[0].content.includes('你是HCIA知识专家')) { expertCount++; assert.ok(!body.tools.some(t => t.function.name === 'repair_network')); return response('专家结果：核对DNS缓存和递归解析。'); }
    rootCount++; if (rootCount === 1) return response('', [call('delegate_analysis', { role: 'knowledge', objective: '解释DNS' })]); return response('综合专家和现场完成分析。');
  } });
  const task = app.ask('请专家解释DNS并综合分析'); await app.tasks.promises.get(task.id);
  assert.equal(task.status, 'completed'); assert.equal(expertCount, 1); assert.equal(app.tasks.list().find(t => t.parentId === task.id).status, 'completed'); assert.ok(rootCount >= 2);
});
test('取消任务传播至进行中的模型请求', async t => {
  const { app } = fixture(t, { fetcher: async (_u, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })) });
  const task = app.ask('长时间任务'); await new Promise(resolve => setImmediate(resolve)); app.tasks.cancel(task.id); await app.tasks.promises.get(task.id); assert.equal(task.status, 'cancelled');
});
test('工具往返测试验证真实消息协议，两次调用均成功才通过', async t => {
  let i = 0; const { app } = fixture(t, { fetcher: async (_u, options) => { const body = JSON.parse(options.body); if (++i === 1) return response('', [call('echo_test', { value: 'network-ok' }, 'echo')]); assert.ok(body.messages.some(m => m.tool_call_id === 'echo')); return response('工具往返通过'); } });
  const task = app.testModel(); await app.tasks.promises.get(task.id); assert.equal(task.status, 'completed'); assert.match(task.result, /往返通过/);
});
test('上下文裁剪不留下孤立的tool消息', () => {
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'goal' }];
  for (let i = 0; i < 10; i++) messages.push({ role: 'assistant', tool_calls: [call('inspect_network', {}, `${i}`)] }, { role: 'tool', tool_call_id: `${i}`, content: 'a'.repeat(1000) });
  const output = compact(messages, 2800); assert.ok(JSON.stringify(output).length < 4000);
  for (let i = 0; i < output.length; i++) if (output[i].role === 'tool') assert.ok(output[i - 1].tool_calls.some(t => t.id === output[i].tool_call_id));
});

test('推理模式按模型轨道独立传输，默认不添加提供商参数', async t => {
  const bodies = []; const { app } = fixture(t, { fetcher: async (_u, req) => { bodies.push(JSON.parse(req.body)); return response('ok'); } });
  const model = new Model(app.store, async (_u, req) => { bodies.push(JSON.parse(req.body)); return response('ok'); });
  await model.complete([{role:'user',content:'test'}], []);
  app.store.saveConfig({model:{reasoningEffort:'none'}});
  await model.complete([{role:'user',content:'test'}], []);
  await model.complete([{role:'user',content:'test'}], [], undefined, {track:'online'});
  assert.equal(bodies[0].reasoning_effort, undefined); assert.equal(bodies[1].reasoning_effort, 'none'); assert.equal(bodies[2].reasoning_effort, undefined);
  assert.throws(() => app.store.saveConfig({model:{reasoningEffort:'unsupported'}}), /推理强度/);
});
