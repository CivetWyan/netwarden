import { EventEmitter } from 'node:events';

export class Tasks extends EventEmitter {
  constructor(store) {
    super(); this.store = store; this.controllers = new Map(); this.promises = new Map();
    this.items = store.read('tasks.json', []).slice(-40);
    for (const item of this.items) if (['running', 'queued'].includes(item.status)) { item.status = 'interrupted'; item.error = '程序退出中断了此任务；需重新采集网络现场'; }
    this.persist();
  }
  persist() { this.store.write('tasks.json', this.items.slice(-40)); this.emit('change'); }
  list() { return this.items.slice(-40); }
  get(id) { return this.items.find(t => t.id === id); }
  update(id, patch) {
    const task = this.get(id); if (!task) throw Error('任务不存在'); Object.assign(task, this.store.redact(patch), { updatedAt: new Date().toISOString() }); this.persist(); return task;
  }
  start(kind, objective, work, { parentId = null, signal: parentSignal, resumeId = null } = {}) {
    if (this.items.filter(t => t.status === 'running').length >= 4) throw Error('后台任务已达到上限（4）');
    let task = resumeId ? this.get(resumeId) : null;
    if (resumeId && (!task || task.status === 'running')) throw Error('该任务不可恢复');
    if (task) Object.assign(task, { status: 'running', result: '', error: null, resumes: (task.resumes || 0) + 1, goal: { ...task.goal, checks: 0 } });
    else task = { id: crypto.randomUUID(), kind, parentId, objective: this.store.redact({ value: String(objective).slice(0, 3000) }).value, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), plan: [], result: '', turns: 0, totalTurns: 0, goal: { condition: String(objective).slice(0, 3000), requiresNetwork: kind === 'incident', checks: 0 } };
    const controller = new AbortController(); const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true }); if (parentSignal?.aborted) controller.abort();
    if (!resumeId) this.items.push(task); this.items = this.items.slice(-40); this.controllers.set(task.id, controller); this.persist();
    this.store.log('task', '任务开始', { taskId: task.id, kind, objective: task.objective, parentId });
    const promise = Promise.resolve().then(() => work(task, controller.signal)).then(result => {
      const status = controller.signal.aborted ? 'cancelled' : result?.status || 'completed';
      this.update(task.id, { ...result, status });
      this.store.log('task', '任务结束', { taskId: task.id, status }); return this.get(task.id);
    }).catch(e => {
      this.update(task.id, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: e.message });
      this.store.log('error', '任务失败', { taskId: task.id, error: e.message }); return this.get(task.id);
    }).finally(() => { controller.abort(); parentSignal?.removeEventListener('abort', abort); this.controllers.delete(task.id); this.promises.delete(task.id); });
    this.promises.set(task.id, promise); return task;
  }
  cancel(id) { const controller = this.controllers.get(id); if (!controller) return false; controller.abort(); for (const t of this.items) if (t.parentId === id) this.cancel(t.id); return true; }
  async close() { for (const id of this.controllers.keys()) this.cancel(id); await Promise.allSettled([...this.promises.values()]); }
}
