import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.mjs';

const expansions = { wan: 'WAN 上网方式 pppoe_status wan_info set_wan', router: '路由器 BE6500 小米', drift: 'WAN 配置 快照 set_wan 恢复', wan_down: 'WAN 拨号 DHCP 静态 pppoe_status', wan_link_down: 'wan_link 链路 网线 set_wan_speed', lan_failure: '无线 WiFi 网关 局域网', dns_failure: 'DNS 域名解析 递归 缓存 UDP 53', no_route: '默认路由 缺省路由 网关', link_down: '物理层 链路 接口 DHCP IP地址', upstream_failure: '网关 路由 ARP ICMP NAT 连通性', captive_portal: '认证 HTTP HTTPS WLAN', dhcp: 'DHCP 地址池 租约 自动分配', dns: 'DNS 域名解析', gateway: '网关 默认路由', arp: 'ARP 地址解析' };
export function tokenize(text) {
  const t = String(text).toLowerCase(); const words = t.match(/[a-z0-9_.-]+/g) || [];
  for (const run of t.match(/[\p{Script=Han}]+/gu) || []) { if (run.length === 1) words.push(run); else for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2)); }
  return words;
}
export class Knowledge {
  constructor(dir = path.join(ROOT, 'knowledge')) { this.load(dir); }
  load(dir) {
    this.dir = dir; this.docs = []; this.index = new Map();
    const file = path.join(dir, 'chunks.jsonl');
    if (!fs.existsSync(file)) { this.error = `未找到 ${file}，请导入 HCIA 知识库`; return; }
    this.error = null;
    // HCIA chunks plus optional device knowledge (router API manual) in the same directory.
    const extra = path.join(dir, 'router-chunks.jsonl');
    this.docs = [file, ...(fs.existsSync(extra) ? [extra] : [])].flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    let total = 0;
    this.docs.forEach((d, id) => {
      const tokens = tokenize(`${d.breadcrumb} ${d.text}`); d.length = tokens.length; total += d.length;
      const counts = new Map(); for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      for (const [term, tf] of counts) { if (!this.index.has(term)) this.index.set(term, []); this.index.get(term).push([id, tf]); }
    }); this.average = total / (this.docs.length || 1);
  }
  search(query, k = 4, budget = 6500) {
    if (typeof query !== 'string' || !query.trim()) return [];
    let expanded = query; for (const [key, value] of Object.entries(expansions)) if (query.toLowerCase().includes(key)) expanded += ` ${value}`;
    const scores = new Map(); const N = this.docs.length;
    for (const term of new Set(tokenize(expanded))) {
      const entries = this.index.get(term) || []; const idf = Math.log(1 + (N - entries.length + 0.5) / (entries.length + 0.5));
      for (const [id, tf] of entries) { const norm = tf + 1.2 * (0.25 + 0.75 * this.docs[id].length / this.average); scores.set(id, (scores.get(id) || 0) + idf * (tf * 2.2) / norm); }
    }
    // Prefer the actual concept section over broad labs containing many unrelated keywords.
    const anchors = [...new Set(expanded.toLowerCase().match(/[\p{Script=Han}]{2,8}|[a-z][a-z0-9.-]{1,15}/gu) || [])];
    for (const [id, score] of scores) {
      const d = this.docs[id]; const title = d.breadcrumb.toLowerCase();
      const boost = anchors.reduce((sum, term) => sum + (title.includes(term) ? 8 : 0), 0);
      scores.set(id, score + boost + (d.type === 'concept' ? 1 : 0));
    }
    const out = []; let remaining = budget;
    for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.min(8, Math.max(1, k)))) {
      if (remaining < 100) break; const d = this.docs[id]; const text = d.text.slice(0, Math.min(2200, remaining)); remaining -= text.length;
      out.push({ id: d.id, breadcrumb: d.breadcrumb, score: Math.round(score * 100) / 100, text, sources: d.sources, warning: Boolean(d.has_warning), truncated: text.length < d.text.length });
    }
    return out;
  }
  status() { return { count: this.docs.length, path: this.dir, error: this.error, engine: 'CPU BM25 / 中文双字索引 / 无显存占用' }; }
}
