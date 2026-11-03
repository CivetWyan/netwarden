import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { ROOT, defaults } from '../src/store.mjs';

const packaged = process.argv.includes('--packaged');
const output = path.join(ROOT, 'test-results', packaged ? 'packaged-ui' : 'ui'); fs.mkdirSync(output, { recursive: true });
process.env.ELECTRON_CACHE = path.join(ROOT, '.cache', 'electron');
process.env.electron_config_cache = process.env.ELECTRON_CACHE;
const dir = fs.mkdtempSync(path.join(output, 'runtime-'));
const config = structuredClone(defaults); config.monitor.enabled = false; fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
let requests = 0; let resumeFailureSent = false;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', data => { raw += data; }); req.on('end', () => {
    try {
      const body = JSON.parse(raw); requests++;
      const system = body.messages[0]?.content || '';
      const send = content => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }] })); };
      if (system.includes('独立目标判断器')) { const input = JSON.parse(body.messages[1].content); send({ satisfied: true, blocked: false, reason: '已有工具证据', evidence: input.evidenceIds.slice(-1) }); return; }
      if (system.includes('压缩网络管理员')) { send({ summary: 'UI测试历史摘要', facts: [], failedActions: [], artifacts: [], pending: [] }); return; }
      if (system.includes('合成接口验收')) { send({ ok: true, summary: '在线接口合成测试通过' }); return; }
      if (body.messages.some(m => m.content?.includes('UI_RESUME_TEST')) && !resumeFailureSent) { resumeFailureSent = true; res.writeHead(503); res.end('synthetic interruption for resume test'); return; }
      if (!body.messages.some(m => m.role === 'tool') && body.messages.some(m => m.content?.includes('UI_SCRIPT_DRAFT'))) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'ui-create-script', type: 'function', function: { name: 'create_script', arguments: JSON.stringify({ title: 'UI 临时工具', language: 'node', source: 'console.log("ui-script-executed")', purpose: 'diagnostic' }) } }] }, finish_reason: 'tool_calls' }] })); return;
      }
      if (!body.messages.some(m => m.role === 'tool') && body.messages[0].content.includes('测试工具协议')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'ui-echo', type: 'function', function: { name: 'echo_test', arguments: '{"value":"network-ok"}' } }] }, finish_reason: 'tool_calls' }] }));
      } else if (!body.messages.some(m => m.role === 'tool')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'ui-inspect', type: 'function', function: { name: 'inspect_network', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '工具往返通过。已读取真实网络探针并完成测试分析。' }, finish_reason: 'stop' }] })); }
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, NETWORK_REPAIR_HOME: dir, ELECTRON_ENABLE_SECURITY_WARNINGS: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let desktop; const errors = []; const stderr = [];
try {
  desktop = await electron.launch({ ...(packaged ? { executablePath: path.join(ROOT, 'release', 'mac-arm64', '网络修复大师.app', 'Contents', 'MacOS', '网络修复大师'), args: [] } : { args: [ROOT] }), env, timeout: 30000 });
  desktop.process().stderr.on('data', data => stderr.push(data.toString()));
  const page = await desktop.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  const waitState = async (predicate, label) => {
    const deadline = Date.now() + 35000; let snapshot;
    while (Date.now() < deadline) {
      snapshot = await page.evaluate(() => window.netwarden.state());
      if (predicate(snapshot)) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fs.writeFileSync(path.join(output, 'failure-state.json'), JSON.stringify(snapshot, null, 2));
    throw Error('等待状态超时：' + label);
  };
  await page.waitForSelector('#health-title');
  await page.waitForFunction(() => document.querySelector('#knowledge-count').textContent.includes('1,226'));
  assert.equal((await page.locator('#toggle-repair').textContent()).replace(/\s+/g, ' ').trim(), '只诊断 ⇄');
  await page.locator('#sample').click(); await page.waitForFunction(() => !document.querySelector('#last-sample').textContent.includes('等待'));
  await page.locator('#sample').click();
  await page.screenshot({ path: path.join(output, 'overview.png'), fullPage: true });
  await page.locator('[data-page="knowledge"]').click(); await page.locator('#search-text').fill('DHCP 地址分配'); await page.locator('#search-form button').click(); await page.waitForSelector('.knowledge-result');
  assert.match(await page.locator('#search-results').innerText(), /DHCP/); await page.screenshot({ path: path.join(output, 'knowledge.png'), fullPage: true });
  await page.locator('[data-page="settings"]').click();
  await page.locator('#cfg-url').fill(`http://127.0.0.1:${server.address().port}/v1`); await page.locator('#cfg-model').fill('local-mock');
  await page.locator('#test-model').click();
  await page.waitForFunction(() => document.querySelector('#conversation').textContent.includes('工具往返通过'), { timeout: 25000 });
  await page.locator('#ask-text').fill('检查当前网络并解释证据'); await page.locator('#send-task').click();
  await page.waitForFunction(() => document.querySelectorAll('.chat-result').length >= 2 && [...document.querySelectorAll('.chat-result')].at(-1).textContent.includes('工具往返通过'), { timeout: 25000 });
  await page.screenshot({ path: path.join(output, 'assistant.png'), fullPage: true });
  await waitState(s => !s.tasks.some(t => t.status === 'running'), '主任务结束');
  await page.locator('#ask-text').fill('UI_SCRIPT_DRAFT 只保存一个临时检测脚本，不执行。'); await page.locator('#send-task').click();
  await waitState(s => s.scripts.length === 1 && !s.tasks.some(t=>t.status==='running'), '脚本草稿任务结束');
  await page.locator('[data-page="learning"]').click(); await page.waitForSelector('#script-list .learning-item');
  assert.match(await page.locator('#script-list').innerText(), /UI 临时工具/);
  await page.evaluate(() => window.netwarden.saveConfig({ scripts: { enabled: true }, repair: { enabled: true } }));
  await page.locator('#script-list button').filter({ hasText: '执行并验证' }).click();
  await waitState(s => s.scriptRuns.some(r=>r.stdout?.includes('ui-script-executed')) && !s.tasks.some(t=>t.status==='running'), '脚本执行完成');
  await page.evaluate(() => window.netwarden.saveConfig({ scripts: { enabled: false }, repair: { enabled: false } }));
  await page.locator('[data-page="learning"]').click(); await page.screenshot({ path: path.join(output, 'learning.png'), fullPage: true });
  await page.locator('[data-page="settings"]').click(); await page.waitForFunction(() => !document.querySelector('#cfg-repair').checked && !document.querySelector('#cfg-scripts').checked); await page.locator('#cfg-online-url').fill(`http://127.0.0.1:${server.address().port}/v1`); await page.locator('#cfg-online-model').fill('online-mock');
  await page.locator('#test-online').click(); await page.waitForFunction(() => document.querySelector('#conversation').textContent.includes('在线接口合成测试通过'));
  await waitState(s => !s.tasks.some(t => t.status === 'running'), '主任务结束');
  await page.locator('#ask-text').fill('UI_RESUME_TEST 检查网络'); await page.locator('#send-task').click();
  await page.waitForSelector('.resume-task'); await page.locator('.resume-task').last().click();
  await waitState(s => s.tasks.some(t=>t.resumes===1 && t.status==='completed'), '原会话续跑完成');
  await page.locator('[data-page="events"]').click(); await page.waitForSelector('.event-row'); await page.locator('.event-row').first().click(); await page.screenshot({ path: path.join(output, 'events.png'), fullPage: true });
  await page.locator('[data-page="overview"]').click(); await page.locator('#export').click(); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('network-report'));
  const exported = fs.readdirSync(path.join(dir, 'exports')); assert.equal(exported.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'exports', exported[0]))); assert.equal(report.config.repair.enabled, false); assert.ok(report.tasks.length >= 2); assert.ok(requests >= 4);
  assert.deepEqual(errors, []); assert.ok(!stderr.join('').includes('Electron Security Warning'));
  assert.ok(report.scriptRuns.some(r=>r.ok && r.stdout.includes('ui-script-executed'))); assert.ok(report.tasks.some(t=>t.resumes===1 && t.status==='completed'));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, requests, rendererErrors: errors, tasks: report.tasks.map(t => ({ kind: t.kind, status: t.status, resumes: t.resumes })), health: report.current?.health, scriptExecuted: true, sessionResumed: true, screenshots: ['overview.png', 'knowledge.png', 'assistant.png', 'learning.png', 'events.png'], stderr }, null, 2));
  console.log(`Electron UI 冒烟测试通过：真实窗口、知识检索、配置、模型工具往返、任务反馈、日志、导出；${requests} 次本地 mock API 请求。`);
} finally {
  if (desktop) await desktop.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // Keep diagnostics inside the project for reproducing a failed smoke test.
  fs.writeFileSync(path.join(output, 'stderr.log'), stderr.join(''));
}
