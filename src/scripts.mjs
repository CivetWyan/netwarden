import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const extensions = { node: 'mjs', python: 'py', shell: 'sh', powershell: 'ps1' };
export class Scripts {
  constructor(app) {
    this.app = app; this.dir = path.join(app.store.dir, 'scripts'); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.items = app.store.read('scripts.json', []); this.runs = app.store.read('script-runs.json', []); this.active = new Set();
    for (const run of this.runs) if (run.status === 'running') { run.status = 'interrupted'; run.outcomeUnknown = true; }
    this.persist();
  }
  persist() { this.app.store.write('scripts.json', this.items); this.app.store.write('script-runs.json', this.runs.slice(-1000)); }
  get(id) { const item = this.items.find(s => s.id === id); if (!item) throw Error('脚本不存在'); return item; }
  create({ title, language, source, purpose = 'diagnostic', platforms = [process.platform], rollbackId = null }, provenance = {}) {
    if (!Object.hasOwn(extensions, language) || typeof source !== 'string' || !source.trim() || source.length > 24000 || typeof title !== 'string' || title.length > 200 || !['diagnostic', 'repair', 'verify', 'rollback'].includes(purpose)) throw Error('脚本格式或长度无效');
    if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !['darwin', 'linux', 'win32'].includes(p))) throw Error('脚本平台无效');
    if (rollbackId && this.get(rollbackId).purpose !== 'rollback') throw Error('回滚脚本用途不符');
    source = this.app.store.redact({ source }).source;
    const id = crypto.randomUUID(); const hash = crypto.createHash('sha256').update(source).digest('hex'); const dir = path.join(this.dir, id); fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, `source.${extensions[language]}`), source, { mode: 0o600 });
    const item = { id, title, language, source, purpose, platforms, hash, rollbackId, provenance, createdAt: new Date().toISOString(), approval: 'pending' };
    this.items.push(item); this.persist(); this.app.store.log('script', '已保存临时脚本', { id, title, hash, purpose, provenance }); return item;
  }
  approve(id) { const item = this.get(id); item.approval = 'approved'; this.persist(); return item; }
  liveOrphans() {
    return this.runs.filter(r => r.outcomeUnknown && r.pid && !r.orphanAcknowledged).filter(r => {
      try { process.kill(r.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
    });
  }
  acknowledgeRun(id) { const run = this.runs.find(r => r.id === id && r.outcomeUnknown); if (!run) throw Error('没有待确认的中断执行'); run.orphanAcknowledged = true; this.persist(); this.app.store.log('script', '用户确认已检查中断脚本进程，保留结果未知记录且不重放', { runId: id, pid: run.pid }); return run; }
  async run(id, { taskId, incidentId, signal, rollback = false } = {}) {
    const a = this.app; const c = a.store.config.scripts; const item = this.get(id); signal?.throwIfAborted();
    if (!rollback && (!c.enabled || !a.store.config.repair.enabled)) return { ok: false, blocked: true, error: '执行任意脚本需要同时开启“自动修复”和“临时脚本执行”' };
    if (!rollback && c.approval === 'per_script' && item.approval !== 'approved') return { ok: false, blocked: true, error: '此脚本等待界面确认', scriptId: id };
    if (!item.platforms.includes(a.platform.platform)) return { ok: false, blocked: true, error: '脚本未声明支持当前平台' };
    if (!rollback && this.liveOrphans().length) return { ok: false, blocked: true, error: '检测到上次退出遗留的进程，先检查PID并确认结束，避免并发修改网络' };
    if (a.repair.busy && !rollback) return { ok: false, blocked: true, error: '另一个网络变更正在执行' };
    const scope = incidentId || taskId || 'manual';
    if (this.runs.some(r => r.scope === scope && r.hash === item.hash)) return { ok: false, blocked: true, error: '本故障/任务已执行过同版本脚本；先查日志，不盲目重放' };
    if (this.runs.filter(r => r.taskId === taskId).length >= c.maxPerTask && !rollback) return { ok: false, blocked: true, error: '脚本执行预算已耗尽' };
    const owner = !a.repair.busy; if (owner) a.repair.busy = true;
    let run;
    try {
      const before = await a.sensor.sample({ fresh: true }); signal?.throwIfAborted();
      if (!rollback && (!a.store.config.scripts.enabled || !a.store.config.repair.enabled)) return { ok: false, blocked: true, error: '现场采集期间脚本授权已撤销' };
      run = { id: crypto.randomUUID(), scriptId: id, hash: item.hash, scope, taskId, incidentId, platform: a.platform.platform, status: 'running', at: new Date().toISOString(), before: before.health, verified: false };
      this.runs.push(run); this.persist();
      a.store.log('script', '开始执行临时脚本', { runId: run.id, scriptId: id, hash: item.hash, taskId, incidentId, before });
      const result = await this.execute(item, run, signal);
      Object.assign(run, result, { status: result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed', endedAt: new Date().toISOString() }); this.persist();
      a.sensor.invalidate();
      if (!signal?.aborted) {
        if (item.purpose === 'repair') await sleep(a.store.config.repair.verifyDelayMs, undefined, { signal });
        const check = await a.verify(signal); run.verified = check.verified; run.restoredNetwork = before.health.severity === 'offline' && check.verified; run.after = check.samples;
      }
      if ((!run.ok || !run.verified) && item.purpose === 'repair' && item.rollbackId) {
        run.rollbackStarted = true;
        a.store.log('rollback', '临时修复未通过验证，执行关联回滚脚本', { runId: run.id, rollbackId: item.rollbackId });
        run.rollback = await this.run(item.rollbackId, { taskId, incidentId: `${scope}:rollback:${run.id}`, rollback: true });
      }
      this.persist(); a.store.log('script_result', '临时脚本执行与验证结果', run); return run;
    } catch (e) {
      if (run?.pid && item.purpose === 'repair' && item.rollbackId && !run.rollbackStarted) {
        run.rollbackStarted = true;
        try { run.rollback = await this.run(item.rollbackId, { taskId, incidentId: `${scope}:rollback:${run.id}`, rollback: true }); } catch (rollbackError) { run.rollbackError = rollbackError.message; }
      }
      if (run) { Object.assign(run, { ok: false, status: signal?.aborted ? 'cancelled' : 'failed', error: this.app.store.redact({ value: e.message }).value, endedAt: new Date().toISOString() }); this.persist(); a.store.log('script_result', '脚本执行或验证中断', run); }
      throw e;
    } finally { if (owner) a.repair.busy = false; }
  }
  execute(item, run, signal) {
    const a = this.app; const c = a.store.config.scripts; const work = path.join(this.dir, item.id); const file = path.join(work, `source.${extensions[item.language]}`);
    // Restore immutable content before execution and verify its hash; never execute an altered on-disk script.
    if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== item.hash) throw Error('磁盘脚本与审阅版本哈希不一致');
    const windows = process.platform === 'win32';
    const executors = { node: [process.execPath, [file]], python: [windows ? 'python' : 'python3', [file]], shell: ['/bin/sh', [file]], powershell: [windows ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', file]] };
    if (windows && item.language === 'shell') return Promise.resolve({ ok: false, error: 'Windows请使用PowerShell、Node或Python' });
    const [executable, args] = executors[item.language];
    const temp = path.join(work, 'tmp'); fs.mkdirSync(temp, { recursive: true });
    const env = { PATH: process.env.PATH || '', LANG: 'C', LC_ALL: 'C', TMPDIR: temp, TMP: temp, TEMP: temp, ...(windows ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC } : {}), ...(process.versions.electron && item.language === 'node' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    return new Promise(resolve => {
      let stdout = ''; let stderr = ''; let timedOut = false; let outputLimited = false; let done = false; let killTimer; let timer;
      const child = spawn(executable, args, { cwd: work, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); this.active.add(child);
      const stop = () => {
        if (!child.pid) return;
        if (windows) spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500); }
      };
      const finish = result => {
        if (done) return; done = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); this.active.delete(child);
        // Kill descendants even if a script exits after backgrounding a subprocess.
        if (!windows && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        resolve(a.store.redact({ ...result, stdout, stderr, timedOut, outputLimited, cancelled: Boolean(signal?.aborted), ok: result.code === 0 && !timedOut && !outputLimited && !signal?.aborted }));
      };
      const collect = (stream, data) => {
        const text = data.toString(); if (stream === 'stdout') stdout = (stdout + text).slice(0, c.maxOutputChars); else stderr = (stderr + text).slice(0, c.maxOutputChars);
        if (stdout.length + stderr.length >= c.maxOutputChars) { outputLimited = true; stop(); }
      };
      child.stdout.on('data', data => collect('stdout', data)); child.stderr.on('data', data => collect('stderr', data));
      child.once('error', e => finish({ code: null, error: e.message })); child.once('close', (code, terminationSignal) => finish({ code, signal: terminationSignal }));
      signal?.addEventListener('abort', stop, { once: true }); timer = setTimeout(() => { timedOut = true; stop(); }, c.timeoutMs); if (signal?.aborted) stop();
      run.pid = child.pid; this.persist();
    });
  }
}
