// Build knowledge/router-chunks.jsonl from the Xiaomi BE6500 API document (main chapters only,
// appendices with raw frontend code are skipped). Usage: node scripts/import-router-knowledge.mjs <doc.md>
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const source = process.argv[2];
if (!source) { console.error('usage: import-router-knowledge.mjs <Xiaomi_BE6500_API文档.md>'); process.exit(2); }
const out = path.resolve(import.meta.dirname, '..', 'knowledge', 'router-chunks.jsonl');
const raw = fs.readFileSync(source, 'utf8');
const main = raw.split(/\n# 附录 A/)[0];
const chunks = []; let chapter = ''; let section = null;
const flush = () => {
  if (!section) return;
  const text = section.lines.join('\n').replace(/("?(?:password|pppoePwd|pwd)"?\s*[:=]\s*)"[^"]*"/gi, '$1"********"').trim();
  if (text.length < 40) return;
  for (let i = 0, n = 0; i < text.length; i += 1800, n++) chunks.push({ id: `BE6500-${chunks.length + 1}`, type: /速查|手册|判断/.test(section.title) ? 'concept' : 'reference', breadcrumb: `小米BE6500路由器 > ${chapter} > ${section.title}${n ? ` (${n + 1})` : ''}`, text: text.slice(i, i + 1800), sources: [path.basename(source)], has_warning: /推断|未实测/.test(text) });
};
let fenced = false;
for (const line of main.split('\n')) {
  if (/^```/.test(line)) fenced = !fenced;
  if (fenced || /^```/.test(line)) { if (section) section.lines.push(line); continue; }
  if (/^# /.test(line)) { flush(); section = null; chapter = line.slice(2).trim(); continue; }
  if (/^#{2,3} /.test(line)) { flush(); section = { title: line.replace(/^#+\s*/, '').trim(), lines: [] }; continue; }
  if (section) section.lines.push(line);
}
flush();
fs.writeFileSync(out, chunks.map(c => JSON.stringify(c)).join('\n') + '\n');
console.log(JSON.stringify({ out, chunks: chunks.length, sha256: createHash('sha256').update(fs.readFileSync(out)).digest('hex') }));
