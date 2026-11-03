import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Platform, parseDarwinRoute, parseResolverDns } from '../src/platform.mjs';
import { Knowledge } from '../src/knowledge.mjs';
import { defaults, validateConfig } from '../src/store.mjs';

test('macOS 默认路由优先识别 IPv4，正确提取接口', () => {
  const r = parseDarwinRoute('default fe80::1%en0 UGcg en0\ndefault 192.168.1.1 UGScg en0\n'); assert.equal(r.gateway, '192.168.1.1'); assert.equal(r.interface, 'en0');
});
for (const platform of ['linux', 'darwin', 'win32']) test(`${platform} 恢复器使用固定可执行文件与参数，不执行模型shell`, async () => {
  const commands = []; const p = new Platform({ platform, run: async (file, args) => { commands.push({ file, args }); return { ok: true }; } });
  await p.repair('reconnect', { name: "Wi-Fi; $(bad)", device: platform === 'win32' ? '4' : 'en0', uuid: 'aabbccdd-1111-2222-3333-123456789abc' }, []);
  assert.equal(commands.length, 1); assert.ok(!['sh', 'bash', 'zsh', 'cmd.exe'].includes(commands[0].file));
});
test('Windows接口注入与Linux错误UUID被拒绝', async () => {
  const p = new Platform({ platform: 'win32', run: async () => { throw Error('must not run'); } }); await assert.rejects(p.repair('reconnect', { name: 'x', device: '4;bad' }, []), /索引/);
  const linux = new Platform({ platform: 'linux', run: async () => { throw Error('must not run'); } }); await assert.rejects(linux.repair('reconnect', { name: 'x', device: 'eth0', uuid: 'bad' }, []), /UUID/);
});
test('Windows回滚自动DNS使用Reset而非固定原来的DHCP DNS地址', async () => {
  let args; const p = new Platform({ platform: 'win32', run: async (_f, a) => { args = a; return { ok: true }; } }); await p.repair('restore_dns', { name: 'Ethernet', device: '4', autoDns: true }, ['192.168.1.1']); assert.match(args.at(-1), /-ResetServerAddresses/); assert.doesNotMatch(args.at(-1), /-ServerAddresses/);
});
test('Ubuntu首次启动即缺失默认路由时，仍从NetworkManager读取已连接profile供续租', async () => {
  const seen = []; const p = new Platform({ platform: 'linux', run: async (file, args) => {
    seen.push([file, args]); const joined = args.join(' ');
    if (file === 'ip') return { ok: true, stdout: '[]' };
    if (joined.includes('GENERAL.DEVICE')) return { ok: true, stdout: 'GENERAL.DEVICE:enp1s0\nGENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:Wired\n' };
    if (joined.includes('GENERAL.CONNECTION')) return { ok: true, stdout: 'Wired\n' };
    if (joined.includes('connection.uuid')) return { ok: true, stdout: 'aabbccdd-1111-2222-3333-123456789abc\nauto\n\nno\n' };
    return { ok: true, stdout: '' };
  } });
  const n = await p.inspect(); assert.equal(n.route, null); assert.equal(n.connection.device, 'enp1s0'); assert.equal(n.connection.method, 'auto');
});
// The public repository does not ship the HCIA course notes; this test runs only where they were imported.
const KB = path.join(import.meta.dirname, '..', 'knowledge', 'chunks.jsonl');
test('离线CPU检索：合成知识库，含可选的设备知识文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const doc = (id, breadcrumb, text, type = 'concept') => JSON.stringify({ id, breadcrumb, text, type, sources: ['synthetic'] });
  fs.writeFileSync(path.join(dir, 'chunks.jsonl'), [doc('n-1', '网络 > DNS 域名解析', 'DNS 把域名解析为 IP 地址，递归查询与缓存。'), doc('n-2', '网络 > 默认路由', '默认路由（缺省路由）把未知目的地址的报文交给网关。'), doc('n-3', '网络 > ARP', 'ARP 地址解析把 IP 映射到 MAC。')].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'router-chunks.jsonl'), doc('r-1', '路由器 > WAN', 'WAN 配置 set_wan 恢复快照，pppoe_status 查看拨号状态。', 'reference') + '\n');
  const kb = new Knowledge(dir);
  assert.equal(kb.docs.length, 4); assert.equal(kb.search('DNS 域名解析')[0].id, 'n-1');
  assert.match(kb.search('no_route', 1)[0].breadcrumb, /默认路由/); assert.equal(kb.search('WAN 配置被改坏')[0].id, 'r-1');
  assert.ok(kb.search('DNS', 4, 30).reduce((n, h) => n + h.text.length, 0) <= 30);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('HCIA离线CPU检索返回真实片段与来源，无需向量模型', { skip: !fs.existsSync(KB) && '未导入 HCIA 知识库（公开仓库不附带，见 knowledge/README.md）' }, () => {
  const kb = new Knowledge(); assert.ok(kb.docs.length > 0);
  for (const query of ['DNS 域名解析', 'DHCP 租约 地址分配', '默认路由 网关', 'ARP 地址解析']) { const hits = kb.search(query); assert.ok(hits.length > 0); assert.ok(hits.some(h => new RegExp(query.split(' ')[0], 'i').test(h.text + h.breadcrumb))); assert.ok(hits.every(h => h.id && h.text)); }
  assert.ok(kb.search('dns_failure').length); assert.ok(kb.search('DNS', 4, 1500).reduce((n, h) => n + h.text.length, 0) <= 1500);
  assert.match(kb.search('no_route', 1)[0].breadcrumb, /缺省路由|默认路由/);
});
test('模型和探针配置严格校验，拒绝危险URL和越界参数', () => {
  for (const mutate of [c => c.model.baseUrl = 'file:///tmp/x', c => c.model.baseUrl = 'http://user:pass@localhost', c => c.model.maxTurns = 10000, c => c.monitor.intervalMs = 0, c => c.repair.fallbackDns = ['300.1.1.1'], c => c.monitor.enabled = 'true', c => c.model = null]) { const c = structuredClone(defaults); mutate(c); assert.throws(() => validateConfig(c)); }
  assert.doesNotThrow(() => validateConfig(structuredClone(defaults)));
});

test('实际resolvectl与scutil输出提取DNS地址，忽略标签和其他接口', () => {
  const linux='Global: 1.1.1.1#cloudflare-dns.com\nLink 2 (enp4s0):\nLink 3 (wlp3s0): 192.0.2.1 2001:db8::53\nLink 5 (lxdci0): 192.0.2.10\n';
  assert.deepEqual(parseResolverDns(linux,'wlp3s0'),['1.1.1.1','192.0.2.1','2001:db8::53']);
  assert.deepEqual(parseResolverDns('  nameserver[0] : 192.168.1.1\n  nameserver[1] : fe80::1%en0\n  nameserver[0] : 192.168.1.1\n'),['192.168.1.1','fe80::1%en0']);
});
