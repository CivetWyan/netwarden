import { tokenize } from './knowledge.mjs';

export class Memory {
  constructor(store) { this.store = store; this.items = store.read('memory.json', []); }
  add({ title, content, source, verified = false, tags = [], incidentId = null }) {
    if (typeof title !== 'string' || typeof content !== 'string' || title.length > 200 || content.length > 6000) throw Error('记忆长度无效');
    const item = this.store.redact({ id: crypto.randomUUID(), title, content, source, verified, tags, incidentId, at: new Date().toISOString() });
    this.items.push(item); this.items = this.items.slice(-500); this.store.write('memory.json', this.items); return item;
  }
  search(query, limit = 5) {
    const terms = new Set(tokenize(query));
    return this.items.map(item => ({ ...item, score: tokenize(`${item.title} ${item.content} ${item.tags.join(' ')}`).reduce((s, term) => s + Number(terms.has(term)), 0) })).filter(i => i.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
