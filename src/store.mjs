import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const defaults = {
  model: { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', name: '', mode: 'native', reasoningEffort: '', timeoutMs: 45000, maxTokens: 1200, contextChars: 24000, maxTurns: 10 },
  onlineModel: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', name: 'deepseek-flash', mode: 'native', reasoningEffort: '', timeoutMs: 90000, maxTokens: 4000, contextChars: 48000, maxTurns: 1 },
  review: { enabled: false, upload: 'confirm', privacy: 'network', maxPayloadChars: 36000, retryMs: 300000 },
  patrol: { enabled: true, intervalMs: 900000 },
  agent: { autoResume: true, semanticCompact: true, goalChecks: true, maxStopChecks: 4, maxTotalTurns: 120 },
  scripts: { enabled: false, approval: 'automatic', timeoutMs: 30000, maxOutputChars: 12000, maxPerTask: 6 },
  monitor: { enabled: true, intervalMs: 1500, probeTimeoutMs: 1600, failureThreshold: 2, recoveryThreshold: 2, cooldownMs: 60000,
    tcpTargets: [{ host: '1.1.1.1', port: 443 }, { host: '223.5.5.5', port: 443 }],
    dnsHosts: ['www.baidu.com', 'example.com'], dnsCanary: 'baidu.com', httpUrl: 'http://connectivitycheck.gstatic.com/generate_204' },
  repair: { enabled: false, allowReconnect: true, allowDhcp: true, allowDnsChange: false, fallbackDns: ['223.5.5.5', '1.1.1.1'], verifyDelayMs: 2500, rollbackMs: 20000, maxActions: 4, fastDecision: true, votes: 3, observeMs: 20000 },
  // Router actions are limited to: restore WAN to the last healthy baseline, re-apply current WAN, reboot.
  router: { enabled: false, host: '', password: '', timeoutMs: 4000, pollMs: 5000, allowRestore: true, allowReconnect: true, allowReboot: true, allowIdentityChange: false, identityIps: [], identityProbeCount: 6, identityLearnMs: 1800000, baselineSettleMs: 600000, rebootWaitMs: 180000, rebootMinOutageMs: 60000, rebootCooldownMs: 21600000 },
  knowledgePath: '', startAtLogin: false
};
function merge(a, b) {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b || {})) if (Object.hasOwn(out, k)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? merge(out[k], v) : v;
  return out;
}
const int = (x, low, high, label) => { if (!Number.isInteger(x) || x < low || x > high) throw Error(`${label} 应在 ${low}–${high} 之间`); };
export function validateConfig(c) {
  if (!c.model || !c.monitor || !c.repair) throw Error('配置分组不可为空');
  const url = new URL(c.model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('模型 URL 仅接受不含凭据、查询参数的 HTTP(S) 地址');
  if (typeof c.model.apiKey !== 'string' || c.model.apiKey.length > 4096 || typeof c.model.name !== 'string' || c.model.name.length > 200) throw Error('模型名称或 Key 无效');
  for (const profile of [c.model, c.onlineModel]) if (profile.reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high'].includes(profile.reasoningEffort)) throw Error('推理强度无效');
  if (!['native', 'json'].includes(c.model.mode)) throw Error('工具模式无效');
  for (const profile of [c.onlineModel]) {
    if (!profile || typeof profile.apiKey !== 'string' || typeof profile.name !== 'string' || profile.apiKey.length > 4096 || profile.name.length > 200) throw Error('在线模型配置无效');
    const u = new URL(profile.baseUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('在线模型 URL 无效');
    int(profile.timeoutMs, 1000, 300000, '在线模型超时'); int(profile.maxTokens, 128, 16000, '在线输出 token'); int(profile.contextChars, 12000, 120000, '在线上下文');
  }
  if (!['auto', 'confirm'].includes(c.review.upload) || !['network', 'minimal'].includes(c.review.privacy) || !['automatic', 'per_script'].includes(c.scripts.approval)) throw Error('复盘或脚本策略无效');
  int(c.review.maxPayloadChars, 4000, 90000, '复盘资料上限'); int(c.review.retryMs, 1000, 86400000, '复盘重试');
  int(c.patrol.intervalMs, 10000, 86400000, '巡检周期'); int(c.agent.maxStopChecks, 1, 10, '停止检查次数'); int(c.agent.maxTotalTurns, 10, 1000, '会话总轮数');
  int(c.scripts.timeoutMs, 500, 300000, '脚本超时'); int(c.scripts.maxOutputChars, 1000, 64000, '脚本输出上限'); int(c.scripts.maxPerTask, 1, 30, '脚本预算');
  for (const flag of [c.review.enabled, c.patrol.enabled, c.agent.autoResume, c.agent.semanticCompact, c.agent.goalChecks, c.scripts.enabled]) if (typeof flag !== 'boolean') throw Error('新功能开关必须为布尔值');
  int(c.model.timeoutMs, 1000, 300000, '模型超时'); int(c.model.maxTurns, 1, 30, '决策轮数');
  int(c.model.maxTokens, 128, 8192, '输出 token'); int(c.model.contextChars, 12000, 120000, '上下文字符');
  int(c.monitor.intervalMs, 500, 60000, '感知间隔'); int(c.monitor.probeTimeoutMs, 200, 10000, '探测超时');
  int(c.monitor.failureThreshold, 1, 10, '故障确认次数'); int(c.monitor.recoveryThreshold, 1, 10, '恢复确认次数');
  int(c.monitor.cooldownMs, 10000, 3600000, '修复冷却时间'); int(c.repair.maxActions, 1, 6, '修复动作数');
  int(c.repair.verifyDelayMs, 100, 30000, '验证等待'); int(c.repair.rollbackMs, 5000, 120000, '回滚等待');
  for (const v of [c.monitor.enabled, c.repair.enabled, c.repair.allowReconnect, c.repair.allowDhcp, c.repair.allowDnsChange, c.startAtLogin]) if (typeof v !== 'boolean') throw Error('开关必须是布尔值');
  if (!Array.isArray(c.monitor.tcpTargets) || c.monitor.tcpTargets.length < 1 || c.monitor.tcpTargets.length > 6) throw Error('需要 1–6 个外网 TCP 探针');
  for (const t of c.monitor.tcpTargets) { if (!validHost(t.host)) throw Error('探针主机无效'); int(t.port, 1, 65535, '探针端口'); }
  if (!Array.isArray(c.monitor.dnsHosts) || c.monitor.dnsHosts.length < 1 || c.monitor.dnsHosts.length > 4 || c.monitor.dnsHosts.some(h => !validHost(h))) throw Error('DNS 探针域名无效');
  if (!Array.isArray(c.repair.fallbackDns) || c.repair.fallbackDns.length < 1 || c.repair.fallbackDns.length > 3 || c.repair.fallbackDns.some(h => !/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.split('.').some(n => +n > 255))) throw Error('备用 DNS 必须是 IPv4 地址');
  if (typeof c.monitor.httpUrl !== 'string' || c.monitor.httpUrl && !['http:', 'https:'].includes(new URL(c.monitor.httpUrl).protocol)) throw Error('HTTP 探测 URL 无效');
  if (typeof c.knowledgePath !== 'string') throw Error('知识库路径无效');
  if (typeof c.monitor.dnsCanary !== 'string' || c.monitor.dnsCanary && !validHost(c.monitor.dnsCanary)) throw Error('DNS 穿透探针域名无效');
  const r = c.router;
  if (typeof r.host !== 'string') throw Error('路由器地址无效');
  if (r.host || r.enabled) {
    let ru; try { ru = new URL(r.host); } catch { throw Error('启用路由器管理前请填写路由器管理地址，如 http://路由器IP'); }
    if (ru.protocol !== 'http:' && ru.protocol !== 'https:' || ru.pathname !== '/' || ru.search || ru.username) throw Error('路由器地址应为 http://IP');
  }
  if (typeof r.password !== 'string' || r.password.length > 128) throw Error('路由器密码无效');
  for (const v of [r.enabled, r.allowRestore, r.allowReconnect, r.allowReboot, r.allowIdentityChange, c.repair.fastDecision]) if (typeof v !== 'boolean') throw Error('路由器开关必须是布尔值');
  if (!Array.isArray(r.identityIps) || r.identityIps.length > 16 || r.identityIps.some(ip => !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split('.').some(n => +n > 255))) throw Error('备用静态 IP 名单无效');
  int(r.identityProbeCount, 1, 30, '空闲 IP 探测数'); int(r.identityLearnMs, 60000, 86400000, '邻居采样间隔');
  int(r.rebootMinOutageMs, 0, 3600000, '重启前最短故障时长'); int(r.rebootCooldownMs, 0, 604800000, '重启冷却时间'); int(c.repair.observeMs, 0, 300000, '观察等待时长');
  int(r.timeoutMs, 500, 30000, '路由器请求超时'); int(r.pollMs, 1000, 600000, '路由器轮询间隔'); int(r.baselineSettleMs, 0, 86400000, '路由器基线稳定时间'); int(r.rebootWaitMs, 60000, 600000, '路由器重启等待'); int(c.repair.votes, 1, 5, '快速决策投票次数');
  return c;
}
export function validHost(s) { return typeof s === 'string' && s.length <= 253 && /^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(s); }
export class Store extends EventEmitter {
  constructor(dir = path.join(ROOT, 'runtime'), codec = null) {
    super(); this.dir = dir; this.codec = codec; fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.config = merge(defaults, this.read('config.json', {}));
    const secret = this.read('secret.json', null);
    if (secret) { try { this.config.model.apiKey = secret.encrypted ? codec?.decrypt(secret.value) || '' : secret.value; } catch { this.config.model.apiKey = ''; } }
    if (process.env.NETWORK_MODEL_API_KEY) this.config.model.apiKey = process.env.NETWORK_MODEL_API_KEY;
    const onlineSecret = this.read('online-secret.json', null);
    if (onlineSecret) { try { this.config.onlineModel.apiKey = onlineSecret.encrypted ? codec?.decrypt(onlineSecret.value) || '' : onlineSecret.value; } catch { this.config.onlineModel.apiKey = ''; } }
    if (process.env.NETWORK_ONLINE_API_KEY) this.config.onlineModel.apiKey = process.env.NETWORK_ONLINE_API_KEY;
    const routerSecret = this.read('router-secret.json', null);
    if (routerSecret) { try { this.config.router.password = routerSecret.encrypted ? codec?.decrypt(routerSecret.value) || '' : routerSecret.value; } catch { this.config.router.password = ''; } }
    if (process.env.NETWORK_ROUTER_PASSWORD) this.config.router.password = process.env.NETWORK_ROUTER_PASSWORD;
    validateConfig(this.config);
    this.events = this.readEvents(); this.baseline = this.read('baseline.json', null);
  }
  read(file, fallback) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw Error(`${file} 无法读取: ${e.message}`); } }
  write(file, value) { const p = path.join(this.dir, file); fs.writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(`${p}.tmp`, p); }
  publicConfig() { const c = structuredClone(this.config); for (const profile of [c.model, c.onlineModel]) { profile.hasApiKey = Boolean(profile.apiKey); profile.apiKey = ''; } c.router.hasPassword = Boolean(c.router.password); c.router.password = ''; return c; }
  saveConfig(patch) {
    const c = merge(this.config, patch); validateConfig(c);
    const publicPart = structuredClone(c);
    for (const [name, filename] of [['model', 'secret.json'], ['onlineModel', 'online-secret.json']]) {
      const key = c[name].apiKey; publicPart[name].apiKey = '';
      this.write(filename, key && this.codec?.available() ? { encrypted: true, value: this.codec.encrypt(key) } : { encrypted: false, value: key });
    }
    const routerKey = c.router.password; publicPart.router.password = '';
    this.write('router-secret.json', routerKey && this.codec?.available() ? { encrypted: true, value: this.codec.encrypt(routerKey) } : { encrypted: false, value: routerKey });
    this.write('config.json', publicPart); this.config = c; this.emit('config', this.publicConfig()); return this.publicConfig();
  }
  readEvents() { try { return fs.readFileSync(path.join(this.dir, 'events.jsonl'), 'utf8').trim().split('\n').slice(-300).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } }
  redact(value) { let s = JSON.stringify(value); if (s === undefined) return null; for (const key of [this.config.model.apiKey, this.config.onlineModel.apiKey, this.config.router?.password]) if (key && key.length >= 4) s = s.split(JSON.stringify(key).slice(1, -1)).join('[REDACTED]');
    // Router read APIs return PPPoE/WiFi passwords in clear text.
    s = s.replace(/("(?:password|pppoePwd|pwd)"\s*:\s*)"(?:\\.|[^"\\])*"/g, '$1"[REDACTED]"'); s = s.replace(/sk-[a-zA-Z0-9_-]{16,}/g, '[REDACTED]'); return JSON.parse(s); }
  log(type, message, data = {}) {
    const event = this.redact({ id: crypto.randomUUID(), at: new Date().toISOString(), type, message, data });
    const p = path.join(this.dir, 'events.jsonl');
    if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) fs.renameSync(p, `${p}.1`);
    fs.appendFileSync(p, `${JSON.stringify(event)}\n`, { mode: 0o600 }); this.events.push(event); this.events = this.events.slice(-300); this.emit('event', event); return event;
  }
}
