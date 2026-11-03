import fs from 'node:fs';
import path from 'node:path';
import { Store, ROOT } from '../src/store.mjs';
import { Model } from '../src/model.mjs';
const store = new Store(); const model = new Model(store);
const report = { at: new Date().toISOString(), syntheticOnly: true, model: store.config.onlineModel.name };
try {
  const c = store.config.onlineModel;
  const response = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
  report.modelsHttp = response.status;
  if (!response.ok) throw Error(`模型列表 HTTP ${response.status}`);
  const body = await response.json(); report.modelAvailable = body.data?.some(m => m.id === c.name) || false;
  const start = Date.now();
  report.review = await model.json('你是网络故障复盘专家。这是完全合成的接口验收，不能声称检测过真实主机。JSON格式:{"summary":"总结","diagnosis":"诊断及不确定性","lessons":["经验"],"runbooks":[]}。不输出脚本或额外文字。', { synthetic: true, fault: 'DNS查询失败但TCP可达', action: '模拟刷新DNS缓存', exitCode: 0, verified: '模拟两次DNS/TCP探针均恢复', constraint: '没有真实网络数据；仅验证结构化API响应' }, AbortSignal.timeout(120000), { track: 'online' });
  report.durationMs = Date.now() - start;
  report.passed = typeof report.review.summary === 'string' && typeof report.review.diagnosis === 'string' && Array.isArray(report.review.runbooks);
  console.log(JSON.stringify({ passed: report.passed, model: report.model, modelAvailable: report.modelAvailable, durationMs: report.durationMs, syntheticOnly: true }));
} catch (e) { report.passed = false; report.error = store.redact({ message: e.message }).message; console.error(report.error); process.exitCode = 1; }
fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'test-results', 'live-online.json'), JSON.stringify(store.redact(report), null, 2), { mode: 0o600 });
