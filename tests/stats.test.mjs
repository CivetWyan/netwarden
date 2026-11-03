import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Stats } from '../src/stats.mjs';

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  return { dir, data: {}, read(f, d) { return this.data[f] ?? d; }, write(f, v) { this.data[f] = JSON.parse(JSON.stringify(v)); } };
}
const H = { stable: 'healthy', health: { kind: 'healthy' } };
const D = { stable: 'offline', health: { kind: 'dns_failure' } };

test('连续健康随时间累计，取最长', () => {
  const st = store(); const s = new Stats(st); const t0 = 1_000_000_000_000;
  s.sample(H, t0); s.sample(H, t0 + 60_000); s.sample(H, t0 + 300_000);
  const snap = s.snapshot(t0 + 300_000);
  assert.equal(snap.currentHealthyMs, 300_000); assert.equal(snap.longestHealthyMs, 300_000); assert.equal(snap.broken, false);
});

test('本地自愈的小故障不打断连续健康计时', () => {
  const st = store(); const s = new Stats(st); const t0 = 1e12;
  s.sample(H, t0); s.sample(H, t0 + 100_000);
  // a blip occurs and the model fixes it: recordIncident outcome 'fixed' must NOT reset healthySince
  s.recordIncident({ createdAt: new Date(t0 + 110_000).toISOString(), kind: 'dns_failure', outcome: 'fixed', recoveryMs: 9000 }, t0 + 120_000);
  s.sample(H, t0 + 200_000);
  const snap = s.snapshot(t0 + 200_000);
  assert.equal(snap.broken, false); assert.equal(snap.currentHealthyMs, 200_000); assert.equal(snap.fixedCount, 1); assert.equal(snap.avgFixMs, 9000);
});

test('未修复的可感知断网：回溯到故障开始清零连续健康，标记已损坏', () => {
  const st = store(); const s = new Stats(st); const t0 = 1e12;
  s.sample(H, t0); s.sample(H, t0 + 500_000); // 500s streak so far
  s.recordIncident({ createdAt: new Date(t0 + 500_000).toISOString(), kind: 'upstream_failure', outcome: 'unfixed' }, t0 + 560_000);
  const snap = s.snapshot(t0 + 600_000);
  assert.equal(snap.broken, true); assert.equal(snap.unfixedCount, 1);
  assert.equal(snap.longestHealthyMs, 500_000); // the pre-outage streak is preserved as the record
  assert.ok(snap.brokenMs >= 100_000); // broken since t0+500000
  assert.equal(snap.currentHealthyMs, 0);
});

test('损坏后恢复健康：开始新的连续健康计时，累计中断时长', () => {
  const st = store(); const s = new Stats(st); const t0 = 1e12;
  s.sample(H, t0); s.recordIncident({ createdAt: new Date(t0 + 10_000).toISOString(), kind: 'dns_failure', outcome: 'unfixed' }, t0 + 20_000);
  s.sample(D, t0 + 30_000); s.sample(H, t0 + 90_000); // recovered at +90s; outage ran from +10s
  const snap = s.snapshot(t0 + 100_000);
  assert.equal(snap.broken, false); assert.equal(snap.currentHealthyMs, 10_000);
  assert.ok(snap.totalOutageMs >= 80_000 && snap.totalOutageMs <= 81_000);
});

test('短时重启保留连续健康；长时间停机清零', () => {
  const st = store(); const s1 = new Stats(st); const t0 = 1e12;
  s1.sample(H, t0); s1.sample(H, t0 + 200_000); s1.persist(true);
  // restart within grace (2 min later): streak continues from original start
  const s2 = new Stats(st); s2.sample(H, t0 + 320_000);
  assert.equal(s2.snapshot(t0 + 320_000).currentHealthyMs, 320_000);
  s2.persist(true);
  // restart after a long gap (20 min): streak resets
  const s3 = new Stats(st); s3.sample(H, t0 + 320_000 + 1_200_000);
  assert.equal(s3.snapshot(t0 + 320_000 + 1_200_000).currentHealthyMs, 0);
});

test('WAN 流量累计，计数器重置后按新值续计', () => {
  const st = store(); const s = new Stats(st);
  s.recordTraffic({ up: 1000, down: 5000 }); s.recordTraffic({ up: 3000, down: 9000 }); // +2000/+4000
  let snap = s.snapshot(); assert.ok(Math.abs(snap.uploadGB - 3000 / 1024 ** 3) < 1e-9); assert.ok(Math.abs(snap.downloadGB - 9000 / 1024 ** 3) < 1e-9);
  s.recordTraffic({ up: 500, down: 1000 }); // router rebooted: counter dropped → add new value
  snap = s.snapshot(); assert.ok(Math.abs(snap.uploadGB - 3500 / 1024 ** 3) < 1e-9);
});

test('成功率与平均修复耗时', () => {
  const st = store(); const s = new Stats(st); const base = new Date(1e12).toISOString();
  s.recordIncident({ createdAt: base, outcome: 'fixed', recoveryMs: 10_000 });
  s.recordIncident({ createdAt: base, outcome: 'fixed', recoveryMs: 20_000 });
  s.recordIncident({ createdAt: base, outcome: 'unfixed' });
  const snap = s.snapshot();
  assert.equal(snap.fixedCount, 2); assert.equal(snap.unfixedCount, 1);
  assert.ok(Math.abs(snap.successRate - 2 / 3) < 1e-9); assert.equal(snap.avgFixMs, 15_000);
});
