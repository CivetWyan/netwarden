import { dnsQuery, gatewayProbe } from './probes.mjs';
import { wanDiff } from './router.mjs';

// Fixed vocabulary shared by triage, fast decisions, playbooks and online reviews.
export const SIGNALS = ['local.no_address', 'local.no_route', 'lan.router_unreachable', 'router.auth_failed', 'wan.link_down', 'wan.disconnected', 'wan.config_drift', 'wan.type_changed', 'wan.ip_changed', 'wan.gateway_changed', 'wan.dns_changed', 'wan.speed_changed', 'wan.dns_unreachable', 'router_dns.failed', 'dns.intercepted', 'public_dns.ok', 'public_dns.failed', 'upstream_gateway.ok', 'upstream_gateway.unreachable', 'internet.tcp_failed', 'dns.failed', 'http.portal', 'wan.segment_alive', 'wan.segment_down', 'wan.suspected_ban'];
export const ACTION_INFO = {
  router_restore_wan: { layer: 'router', cost: 1, text: '把路由器 WAN 配置（上网方式/IP/网关/DNS/WAN口速率）恢复为最近一次健康基线。只在存在配置漂移时有效；约 5 秒（速率恢复约 35 秒），不断 WiFi' },
  router_reconnect_wan: { layer: 'router', cost: 2, text: '按路由器当前 WAN 配置重新应用（重新获取地址/重拨）。适用于配置没变但 WAN 掉线；约 5–45 秒' },
  flush_dns: { layer: 'local', cost: 1, text: '清空本机 DNS 缓存。只能修复本机缓存的错误解析，不能修复上游 DNS 服务器不可达或路由器 DNS 配置错误' },
  renew_dhcp: { layer: 'local', cost: 2, text: '本机重新获取 DHCP 地址。适用于本机没有地址/路由' },
  reconnect: { layer: 'local', cost: 2, text: '本机重新连接当前网络。适用于本机网卡/WiFi 层问题' },
  router_change_identity: { layer: 'router', cost: 4, text: '更换 WAN 口 MAC 并切换到同网段一个空闲静态 IP（运营方认可的解封方式）。用于本机疑似被园区按 IP/MAC 封禁：WAN 正常、配置无漂移、同网段邻居可达但仅本机上游不通。切换约 10–30 秒，失败自动换回原值' },
  router_reboot: { layer: 'router', cost: 9, text: '重启路由器，全工作室断网约 90–120 秒。最后手段：只在其他候选都已无效后使用' }
};
const PUBLIC_DNS = '223.5.5.5';

export async function triage(app, snapshot, signal) {
  const c = app.store.config; const r = snapshot.router; const timeout = c.monitor.probeTimeoutMs;
  const query = app.sensor.probes.query || dnsQuery; const ping = app.sensor.probes.upstream || gatewayProbe;
  const signals = new Set(); const evidence = {}; let drift = [];
  if (!snapshot.network.interfaces.length) signals.add('local.no_address');
  if (snapshot.network.routeKnown && !snapshot.network.route) signals.add('local.no_route');
  if (!snapshot.tcp.some(p => p.ok)) signals.add('internet.tcp_failed');
  if (!snapshot.dns.some(p => p.ok)) signals.add('dns.failed');
  if (snapshot.http?.portal) signals.add('http.portal');
  const lanGateway = snapshot.network.route?.gateway;
  const probes = [];
  // Targeted probes: which DNS server answers, and does traffic get past the router's upstream gateway?
  probes.push(query('www.baidu.com', PUBLIC_DNS, timeout, signal).then(x => { evidence.publicDns = x; signals.add(x.ok ? 'public_dns.ok' : 'public_dns.failed'); }));
  if (lanGateway && !lanGateway.includes(':')) probes.push(query('www.baidu.com', lanGateway, timeout, signal).then(x => { evidence.routerDns = x; if (!x.ok) signals.add('router_dns.failed'); }));
  if (r?.enabled) {
    if (!r.reachable) signals.add('lan.router_unreachable');
    else if (r.authError) signals.add('router.auth_failed');
    else {
      if (r.wan?.link === 0) signals.add('wan.link_down');
      if (r.wan && !r.wan.connected) signals.add('wan.disconnected');
      const baseline = app.routerBaseline?.config;
      drift = wanDiff(baseline, r.config);
      if (drift.length) signals.add('wan.config_drift');
      for (const d of drift) {
        if (d.field === 'wanType') signals.add('wan.type_changed');
        if (d.field === 'ipaddr') signals.add('wan.ip_changed');
        if (d.field === 'gateway') signals.add('wan.gateway_changed');
        if (d.field === 'dns' || d.field === 'peerdns') signals.add('wan.dns_changed');
        if (d.field === 'speedSetting') signals.add('wan.speed_changed');
      }
      const wanDns = (r.wan?.dns || []).filter(x => /^\d+\.\d+\.\d+\.\d+$/.test(x)).slice(0, 2);
      if (wanDns.length) probes.push(Promise.all(wanDns.map(server => query('www.baidu.com', server, timeout, signal))).then(xs => { evidence.wanDns = xs; if (xs.every(x => !x.ok)) signals.add('wan.dns_unreachable'); }));
      const upstream = r.wan?.gateway;
      if (upstream && /^\d+\.\d+\.\d+\.\d+$/.test(upstream)) probes.push(ping(upstream, timeout, signal, app.platform.platform, app.platform.run).then(x => { evidence.upstreamGateway = { gateway: upstream, ok: x.ok, ms: x.ms }; signals.add(x.ok ? 'upstream_gateway.ok' : 'upstream_gateway.unreachable'); }));
    }
  }
  // Some networks (the router or an upstream campus/ISP network) answer every port-53 query
  // themselves. Ask a server that cannot exist (TEST-NET-1); if it "answers", direct-server results prove nothing.
  probes.push(query('www.baidu.com', '192.0.2.53', timeout, signal).then(x => { evidence.bogusServer = { ok: x.ok, error: x.error, ms: x.ms }; if (x.ok || x.error === 'ENOTFOUND') signals.add('dns.intercepted'); }));
  await Promise.all(probes);
  // Suspected campus ban vs whole-segment outage: if we have WAN config and link but no upstream, ask
  // whether known neighbours in the WAN subnet still answer. Only our own identity being blocked →
  // neighbours alive; the whole segment down → neighbours dead.
  const wanUp = r?.enabled && r.reachable && !r.authError && r.wan?.link !== 0 && r.wan?.connected;
  if (wanUp && !drift.length && (signals.has('upstream_gateway.unreachable') || signals.has('internet.tcp_failed')) && app.identity) {
    const alive = await app.identity.witnessAlive(signal);
    evidence.witnesses = { checked: app.identity.state.witnesses.slice(0, 3), alive };
    if (alive === true) { signals.add('wan.segment_alive'); signals.add('wan.suspected_ban'); }
    else if (alive === false) signals.add('wan.segment_down');
  }
  if (signals.has('dns.intercepted')) { for (const s of ['router_dns.failed', 'wan.dns_unreachable', 'public_dns.ok', 'public_dns.failed']) signals.delete(s); evidence.note = '本网络的 53 端口查询会被拦截代答（路由器或上级网络）：指定 DNS 服务器的查询结果不能证明该服务器可用'; }
  const has = s => signals.has(s);
  let layer; let summary;
  if (has('local.no_address') || has('local.no_route')) { layer = 'local'; summary = '本机没有地址或默认路由'; }
  else if (has('lan.router_unreachable')) { layer = 'lan'; summary = '本机到路由器的局域网链路不通'; }
  else if (has('wan.config_drift')) { layer = 'router_config'; summary = `路由器 WAN 配置与健康基线不一致：${drift.map(d => d.field).join('、')}`; }
  else if (has('wan.link_down')) { layer = 'wan_physical'; summary = 'WAN 口网线/上游设备链路断开'; }
  else if (has('wan.disconnected')) { layer = 'router_wan'; summary = '路由器 WAN 未获取地址或拨号失败'; }
  else if (has('router_dns.failed') && has('public_dns.ok')) { layer = 'router_dns'; summary = '直连公共 DNS 正常，但路由器 DNS 转发失败'; }
  else if (has('wan.dns_unreachable') && has('public_dns.ok')) { layer = 'upstream_dns'; summary = '路由器配置的上游 DNS 无应答，公共 DNS 正常'; }
  else if (has('wan.suspected_ban')) { layer = 'suspected_ban'; summary = '疑似本机 IP/MAC 被园区封禁：WAN 正常、同网段邻居可达，仅本机上游不通'; }
  else if (has('upstream_gateway.unreachable')) { layer = 'upstream'; summary = has('wan.segment_down') ? '整段上游不可达（同网段邻居也不通），疑似园区/运营商断网' : '路由器上游网关无应答（运营商/上级网络）'; }
  else if (has('dns.failed') && !has('internet.tcp_failed')) { layer = 'dns'; summary = '外网 IP 可达，DNS 解析失败'; }
  else { layer = 'upstream'; summary = snapshot.health.summary; }
  const router = r?.enabled && r.reachable && !r.authError; const rc = c.router; const rp = c.repair;
  const candidates = [];
  const add = (action, why) => { if (!candidates.some(x => x.action === action)) candidates.push({ action, why }); };
  if (layer === 'local' || layer === 'lan') {
    if (rp.allowDhcp && (snapshot.network.connection?.method === 'auto' || app.store.baseline?.network?.connection?.method === 'auto')) add('renew_dhcp', '本机地址/路由层异常');
    if (rp.allowReconnect) add('reconnect', '本机或无线链路层异常');
  }
  if (router && has('wan.config_drift') && rc.allowRestore && app.routerBaseline) add('router_restore_wan', '检测到 WAN 配置漂移');
  if (has('dns.failed') && (layer === 'dns' || layer === 'router_dns')) add('flush_dns', '可能是本机缓存的失败解析');
  if (router && rc.allowIdentityChange && layer === 'suspected_ban') add('router_change_identity', '疑似被园区按 IP/MAC 封禁，按运营方认可方式更换身份');
  if (router && rc.allowReconnect && layer !== 'local' && layer !== 'lan') add('router_reconnect_wan', '重新建立 WAN 连接');
  // A physically down WAN link is not fixed by rebooting; report it instead of a 2-minute outage.
  if (router && rc.allowReboot && !['local', 'lan', 'wan_physical'].includes(layer)) add('router_reboot', '最后手段');
  return { at: new Date().toISOString(), kind: snapshot.health.kind, layer, summary, signals: SIGNALS.filter(s => signals.has(s)), drift, evidence,
    candidates: candidates.map(x => ({ ...x, ...ACTION_INFO[x.action] })),
    router: r?.enabled ? { reachable: r.reachable, authError: r.authError, wan: r.wan } : { enabled: false } };
}
