import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { Store, ROOT } from '../src/store.mjs';

const saved = new Store(); const parent = path.join(ROOT, 'test-results', 'live-agent'); fs.mkdirSync(parent, { recursive: true }); const dir = fs.mkdtempSync(path.join(parent, 'runtime-'));
const n = { platform: process.platform, interfaces: [{ name: 'synthetic0', addresses: [{ address: '192.0.2.20', family: 'IPv4' }] }], routeKnown: true, route: { gateway: '192.0.2.1', interface: 'synthetic0' }, dns: ['192.0.2.53'], connection: { name: 'SYNTHETIC-NETWORK', device: 'synthetic0', method: 'auto', dns: ['192.0.2.53'] }, errors: [] };
const platform = { platform: process.platform, inspect: async () => structuredClone(n), diagnose: async topic => ({ ok: true, topic, stdout: 'SYNTHETIC diagnostics only; no system command executed' }), repair: async () => ({ ok: false, stderr: 'live acceptance does not modify real network' }) };
const probes = { tcp: async (host, port) => ({ host, port, ok: true, ms: 1 }), dns: async host => ({ host, ok: true, answers: ['192.0.2.100'], ms: 1 }), http: async () => ({ ok: true, status: 204 }), gateway: async () => ({ ok: true, ms: 1 }) };
const app = new Engine({ dir, platform, probes });
// Use the user's approved online provider as a temporary local-track transport in memory only.
app.store.config.model = { ...saved.config.onlineModel, maxTurns: 6, maxTokens: 1500, contextChars: 24000, mode: 'native' };
app.store.config.onlineModel = { ...saved.config.onlineModel };
Object.assign(app.store.config, { agent: { ...app.store.config.agent, autoResume: false, maxStopChecks: 2 }, review: { ...app.store.config.review, enabled: true, upload: 'auto' } });
app.store.config.repair.enabled = true; app.store.config.repair.verifyDelayMs = 100; app.store.config.monitor.recoveryThreshold = 1; app.store.config.monitor.intervalMs = 500; app.store.config.scripts.enabled = true;
const execute = app.scripts.execute.bind(app.scripts);
app.scripts.execute = (item, run, signal) => {
  if (item.language !== 'node' || !/^\s*console\.log\((['"])live-agent-tool-ok\1\);?\s*$/.test(item.source)) throw Error('合成验收仅允许console.log一行标记，不执行任何其他模型生成代码');
  return execute(item, run, signal);
};
const result = { at: new Date().toISOString(), syntheticOnly: true, localTrackProviderForTest: saved.config.onlineModel.name, usesRealLocalSmallModel: false };
try {
  await app.sensor.sample({ fresh: true });
  const incident = { id: 'synthetic-review-only', createdAt: new Date().toISOString(), kind: 'dns_failure', summary: '完全合成的DNS故障演练；没有真实故障' };
  app.incident = incident;
  app.store.log('incident', 'SYNTHETIC ONLY: simulated DNS scenario; network observations are fixtures', { synthetic: true, incidentId: incident.id });
  const task = app.ask('合成环境接口验收：使用create_script保存一个Node检测工具，源码必须原样为 console.log("live-agent-tool-ok")，purpose=diagnostic；调用run_script前台执行它；根据真实工具反馈报告退出码和输出。不得访问网络、文件、凭据，不要调用网络修复。成功条件是脚本输出该标记且退出码0。');
  await app.tasks.promises.get(task.id); result.taskStatus = task.status; result.goalVerdict = task.goal?.verdict;
  result.scriptExecuted = app.scripts.runs.some(r => r.ok && r.stdout.trim() === 'live-agent-tool-ok');
  result.tools = app.store.events.filter(e => e.type === 'tool').map(e => e.message);
  if (task.status !== 'completed' || !result.scriptExecuted) throw Error('真实模型的临时工具链路尚未达到验收目标，检查保留的transcript');
  const createdAt = new Date().toISOString();
  app.store.log('incident', 'SYNTHETIC ONLY: simulated DNS incident already recovered', { synthetic: true, fault: 'DNS query failure', command: 'simulation only', verified: true });
  const review = app.reviews.enqueue(incident);
  const upload = app.reviews.preview(review.id); result.uploadedScripts = upload.scripts.length; result.uploadedExecutions = upload.executions.length;
  if (!upload.scripts.length || !upload.executions.length) throw Error('合成复盘包缺少已执行的脚本证据');
  await app.reviews.drain(); result.reviewStatus = review.status; result.reviewSummary = review.result?.summary; result.candidates = review.runbookIds?.length || 0; result.passed = review.status === 'completed';
  if (!result.passed) throw Error(review.error || '在线复盘未完成');
  console.log(JSON.stringify({ passed: true, syntheticOnly: true, taskStatus: result.taskStatus, scriptExecuted: result.scriptExecuted, reviewStatus: result.reviewStatus, candidates: result.candidates }));
} catch (e) { result.passed = false; result.error = app.store.redact({ value: e.message }).value; console.error(result.error); process.exitCode = 1; }
finally { await app.close(); fs.writeFileSync(path.join(parent, 'report.json'), JSON.stringify(app.store.redact(result), null, 2), { mode: 0o600 }); }
