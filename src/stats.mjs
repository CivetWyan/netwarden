// Lifetime achievement counters, persisted to stats.json. The healthy streak is NOT broken by a blip
// the local model heals itself (per product rule); it only resets on a user-visible unresolved outage.
const RESTART_GRACE_MS = 5 * 60 * 1000; // a brief service/host restart does not count as an interruption
const GB = 1024 ** 3;
// An outage users clearly feel. Shorter blips that end on their own are "self-recovered", not "unfixed".
export const PERCEIVABLE_MS = 60 * 1000;
export class Stats {
  constructor(store) {
    this.store = store;
    const s = store.read('stats.json', null);
    const now = Date.now();
    this.s = {
      deployedAt: now, healthySince: null, longestHealthyMs: 0, outageSince: null,
      totalOutageMs: 0, fixedCount: 0, unfixedCount: 0, selfRecoveredCount: 0, sumFixMs: 0,
      uploadBytes: 0, downloadBytes: 0, lastWanUp: null, lastWanDown: null, lastSampleAt: null,
      lastFix: null, lastOutage: null, upMsHealthy: 0, ...(s || {})
    };
    this.live = { upBps: 0, downBps: 0 };
    this.firstSample = true; this.lastPersist = 0;
  }
  persist(force = false) { const now = Date.now(); if (!force && now - this.lastPersist < 15000) return; this.lastPersist = now; this.store.write('stats.json', this.s); }
  sample(snapshot, now = Date.now()) {
    const s = this.s; const healthy = snapshot.stable === 'healthy' && snapshot.health.kind === 'healthy';
    if (this.firstSample) {
      this.firstSample = false;
      const gap = s.lastSampleAt ? now - s.lastSampleAt : Infinity;
      if (gap > RESTART_GRACE_MS) { // long downtime or first ever run: cannot claim continuity
        s.outageSince = null; s.healthySince = healthy ? now : null;
      } // else: short restart — keep stored healthySince/outageSince as-is
    }
    if (s.outageSince != null) {
      if (healthy) { s.totalOutageMs += now - s.outageSince; s.outageSince = null; s.healthySince = now; }
    } else if (healthy) {
      if (s.healthySince == null) s.healthySince = now;
      const streak = now - s.healthySince; if (streak > s.longestHealthyMs) s.longestHealthyMs = streak;
      if (s.lastSampleAt) s.upMsHealthy += Math.min(now - s.lastSampleAt, RESTART_GRACE_MS);
    }
    s.lastSampleAt = now; this.persist();
  }
  // outcome: 'fixed' (a verified action restored it), 'self' (recovered on its own), 'unfixed'.
  recordIncident({ createdAt, kind, outcome, recoveryMs, recoveredAt } = {}, now = Date.now()) {
    const s = this.s; const cAt = Date.parse(createdAt) || now;
    if (outcome === 'fixed') { s.fixedCount++; if (recoveryMs > 0) s.sumFixMs += recoveryMs; s.lastFix = { at: new Date(now).toISOString(), kind, recoveryMs: recoveryMs || null }; }
    else if (outcome === 'self') { s.selfRecoveredCount++; }
    else { // user-visible outage: retroactively end the streak at the incident's start
      s.unfixedCount++; s.lastOutage = { at: new Date(cAt).toISOString(), kind };
      if (s.healthySince != null && s.healthySince < cAt) { const streak = cAt - s.healthySince; if (streak > s.longestHealthyMs) s.longestHealthyMs = streak; }
      const rAt = Date.parse(recoveredAt);
      if (Number.isFinite(rAt) && s.outageSince == null) { s.totalOutageMs += Math.max(0, rAt - cAt); s.healthySince = rAt; } // already over
      else { s.healthySince = null; if (s.outageSince == null) s.outageSince = cAt; }
    }
    this.persist(true);
  }
  // WAN byte counters are since-boot; a decrease means the router rebooted — count the new value as delta.
  recordTraffic({ up, down, upBps, downBps } = {}) {
    const s = this.s;
    if (Number.isFinite(up)) { s.uploadBytes += s.lastWanUp != null && up >= s.lastWanUp ? up - s.lastWanUp : up; s.lastWanUp = up; }
    if (Number.isFinite(down)) { s.downloadBytes += s.lastWanDown != null && down >= s.lastWanDown ? down - s.lastWanDown : down; s.lastWanDown = down; }
    if (Number.isFinite(upBps)) this.live.upBps = upBps;
    if (Number.isFinite(downBps)) this.live.downBps = downBps;
    this.persist();
  }
  // ongoingSince: start of the incident in progress, if any; it shows as broken once users clearly feel it.
  snapshot(now = Date.now(), { ongoingSince = null } = {}) {
    const s = this.s; const ongoing = ongoingSince != null && now - ongoingSince >= PERCEIVABLE_MS;
    const broken = s.outageSince != null || ongoing; const brokenFrom = s.outageSince ?? ongoingSince;
    const currentHealthyMs = !broken && s.healthySince != null ? now - s.healthySince : 0;
    const streakBeforeOutage = ongoing && s.healthySince != null && s.healthySince < ongoingSince ? ongoingSince - s.healthySince : 0;
    const total = s.fixedCount + s.unfixedCount;
    return {
      deployedAt: s.deployedAt, runtimeMs: now - s.deployedAt,
      broken, brokenMs: broken ? now - brokenFrom : 0,
      currentHealthyMs, longestHealthyMs: Math.max(s.longestHealthyMs, currentHealthyMs, streakBeforeOutage),
      fixedCount: s.fixedCount, unfixedCount: s.unfixedCount, selfRecoveredCount: s.selfRecoveredCount,
      successRate: total ? s.fixedCount / total : null, avgFixMs: s.fixedCount ? Math.round(s.sumFixMs / s.fixedCount) : null,
      uploadGB: s.uploadBytes / GB, downloadGB: s.downloadBytes / GB, upBps: this.live.upBps, downBps: this.live.downBps,
      totalOutageMs: s.totalOutageMs + (broken ? now - brokenFrom : 0), upMsHealthy: s.upMsHealthy,
      lastFix: s.lastFix, lastOutage: s.lastOutage
    };
  }
}
