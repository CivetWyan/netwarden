import os from 'node:os';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';

export function command(file, args = [], { timeout = 6000, signal } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, signal, windowsHide: true, maxBuffer: 256 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (error, stdout, stderr) => {
      resolve({ ok: !error, file, args, code: error?.code ?? 0, stdout: String(stdout || '').slice(0, 16000), stderr: String(stderr || error?.message || '').slice(0, 4000) });
    });
  });
}
export function interfaces() {
  return Object.entries(os.networkInterfaces()).map(([name, addresses]) => ({ name, addresses: (addresses || []).filter(a => !a.internal).map(a => ({ address: a.address, family: a.family, netmask: a.netmask, cidr: a.cidr, mac: a.mac })) })).filter(i => i.addresses.length);
}
export function parseDarwinRoute(text) {
  const rows = text.split('\n').filter(l => /^default\s/.test(l));
  const row = rows.find(l => !l.includes(':')) || rows[0];
  if (!row) return null;
  const parts = row.trim().split(/\s+/);
  return { gateway: parts[1], interface: parts.find((p, i) => i > 2 && /^(en\d+|utun\d+|bridge\d+|ppp\d+)$/.test(p)) || parts[3], family: parts[1].includes(':') ? 'IPv6' : 'IPv4' };
}
export function parsePorts(text) {
  return text.split(/\n\s*\n/).flatMap(block => { const name = block.match(/Hardware Port: (.+)/)?.[1]; const device = block.match(/Device: (.+)/)?.[1]; return name && device ? [{ name: name.trim(), device: device.trim() }] : []; });
}
export function parseResolverDns(text, device) {
  const lines = text.split('\n').flatMap(line => {
    const link = line.match(/^Link \d+ \(([^)]+)\):\s*(.*)$/);
    if (link) return !device || link[1] === device ? [link[2]] : [];
    if (line.startsWith('Global:')) return [line.slice(7)];
    const mac = line.match(/nameserver\[\d+\]\s*:\s*(.*)$/);
    return mac ? [mac[1]] : [];
  });
  return [...new Set(lines.flatMap(line => line.trim().split(/\s+/)).map(s => s.split('#')[0]).filter(s => isIP(s.split('%')[0])))];
}
export const isVirtualDevice = name => /^(lo|lxd|docker|br-|virbr|veth|tap|tun|vnet|wg|zt|tailscale|cni|flannel|podman|vmnet|vboxnet)/i.test(String(name || ''));
export class Platform {
  constructor({ platform = process.platform, run = command, allowPrompts = false } = {}) { this.platform = platform; this.run = run; this.allowPrompts = allowPrompts; }
  async inspect(signal) {
    const run = (file, args) => this.run(file, args, { signal });
    const base = { platform: this.platform, interfaces: interfaces(), route: null, routeKnown: false, dns: [], connection: null, errors: [] };
    if (this.platform === 'linux') {
      const [r4, r6, nm, dns] = await Promise.all([run('ip', ['-j', 'route', 'show', 'default']), run('ip', ['-j', '-6', 'route', 'show', 'default']), run('nmcli', ['--escape', 'no', '-t', '-f', 'GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.CONNECTION,IP4.DNS', 'device', 'show']), run('resolvectl', ['dns'])]);
      base.routeKnown = r4.ok && r6.ok;
      try { const r = [...JSON.parse(r4.stdout || '[]'), ...JSON.parse(r6.stdout || '[]')].sort((a,b) => (a.metric || 0) - (b.metric || 0))[0]; if (r) base.route = { gateway: r.gateway, interface: r.dev, family: r.gateway?.includes(':') ? 'IPv6' : 'IPv4' }; } catch { base.routeKnown = false; }
      // Without a default route, fall back to a connected *uplink* NIC only. Bridges and virtual devices
      // (LXD/Docker/libvirt bridges, tap/veth) are often "connected" too, and reconnecting them is useless.
      const connectedDevice = nm.stdout.split(/(?=GENERAL\.DEVICE:)/).find(block => /GENERAL\.STATE:100/.test(block) && /GENERAL\.TYPE:(wifi|ethernet)\b/.test(block) && !isVirtualDevice(block.match(/GENERAL\.DEVICE:([^\n]+)/)?.[1]?.trim()))?.match(/GENERAL\.DEVICE:([^\n]+)/)?.[1]?.trim();
      const device = base.route?.interface || connectedDevice;
      if (device) {
        const detail = await run('nmcli', ['--escape', 'no', '-g', 'GENERAL.CONNECTION', 'device', 'show', device]);
        const name = detail.ok ? detail.stdout.trim() : '';
        if (name && name !== '--') {
          const config = await run('nmcli', ['-g', 'connection.uuid,ipv4.method,ipv4.dns,ipv4.ignore-auto-dns', 'connection', 'show', name]);
          if (config.ok) { const [uuid, method, servers, ignoreAutoDns] = config.stdout.trimEnd().split('\n'); base.connection = { name, uuid, device, method, dns: servers ? servers.split(',').filter(Boolean) : [], ignoreAutoDns }; }
        }
      }
      base.dns = dns.ok ? parseResolverDns(dns.stdout, device) : [];
      base.errors = [r4, r6, nm].filter(r => !r.ok).map(r => ({ tool: r.file, error: r.stderr }));
    } else if (this.platform === 'darwin') {
      const [route, ports, dns] = await Promise.all([run('/usr/sbin/netstat', ['-rn']), run('/usr/sbin/networksetup', ['-listnetworkserviceorder']), run('/usr/sbin/scutil', ['--dns'])]);
      base.routeKnown = route.ok; base.route = parseDarwinRoute(route.stdout);
      const blocks = ports.stdout.split(/\n(?=\(\d+\))/);
      const physical = blocks.map(block => block.match(/Device: ([^)]+)/)?.[1]).find(device => base.interfaces.some(i => i.name === device && i.addresses.some(a => a.family === 'IPv4')));
      const device = base.route?.interface || physical;
      if (device) {
        const block = blocks.find(b => b.includes(`Device: ${device})`));
        const service = block?.match(/^\(\d+\) (.+)/)?.[1]?.trim();
        if (service) {
          const [info, servers] = await Promise.all([run('/usr/sbin/networksetup', ['-getinfo', service]), run('/usr/sbin/networksetup', ['-getdnsservers', service])]);
          base.connection = { name: service, device, method: /DHCP Configuration/i.test(info.stdout) ? 'auto' : /Manual|BOOTP/i.test(info.stdout) ? 'manual' : 'unknown', dns: servers.ok ? servers.stdout.split('\n').filter(s => /^[\da-fA-F:.]+$/.test(s.trim())) : null };
        }
      }
      base.dns = parseResolverDns(dns.stdout);
      base.errors = [route, ports].filter(r => !r.ok).map(r => ({ tool: r.file, error: r.stderr }));
    } else if (this.platform === 'win32') {
      const script = "$ErrorActionPreference='Stop'; $r=Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1; $c=$null; if($r){$a=Get-NetIPInterface -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4; $d=Get-DnsClientServerAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4; $adapter=Get-NetAdapter | Where-Object {$_.ifIndex -eq $r.InterfaceIndex} | Select-Object -First 1; $guid='{'+([string]$adapter.InterfaceGuid).Trim('{}')+'}'; $reg=Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\'+$guid) -ErrorAction Stop; $c=@{name=$r.InterfaceAlias;device=[string]$r.InterfaceIndex;method=if($a.Dhcp -eq 'Enabled'){'auto'}else{'manual'};dns=@($d.ServerAddresses);autoDns=[string]::IsNullOrWhiteSpace($reg.NameServer)}}; @{route=if($r){@{gateway=$r.NextHop;interface=[string]$r.InterfaceIndex;family=[string]$r.AddressFamily}}else{$null};connection=$c;dns=@(Get-DnsClientServerAddress | Where-Object {$_.ServerAddresses} | ForEach-Object {$_.ServerAddresses})} | ConvertTo-Json -Depth 6 -Compress";
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      try { if (result.ok) { Object.assign(base, JSON.parse(result.stdout)); base.routeKnown = true; } else base.errors.push({ tool: 'powershell', error: result.stderr }); } catch { base.errors.push({ tool: 'powershell', error: '无法解析网络配置' }); }
    } else base.errors.push({ tool: 'platform', error: '不支持此操作系统' });
    return base;
  }
  async privileged(file, args, signal) {
    if (this.platform === 'win32' || (process.getuid && process.getuid() === 0)) return this.run(file, args, { signal, timeout: 15000 });
    if (this.platform === 'darwin' && this.allowPrompts) {
      const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
      const shell = [file, ...args].map(quote).join(' ');
      return this.run('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(shell)} with administrator privileges`], { signal, timeout: 60000 });
    }
    return this.run('sudo', ['-n', file, ...args], { signal, timeout: 15000 });
  }
  async diagnose(topic, signal) {
    const catalog = {
      linux: { routes: ['ip', ['-j', 'route', 'show', 'table', 'all']], neighbors: ['ip', ['-j', 'neigh', 'show']], resolver: ['resolvectl', ['status']], links: ['ip', ['-j', 'address', 'show']] },
      darwin: { routes: ['/usr/sbin/netstat', ['-rn']], neighbors: ['/usr/sbin/arp', ['-an']], resolver: ['/usr/sbin/scutil', ['--dns']], links: ['/sbin/ifconfig', ['-a']] },
      win32: { routes: ['route.exe', ['print']], neighbors: ['arp.exe', ['-a']], resolver: ['ipconfig.exe', ['/all']], links: ['ipconfig.exe', ['/all']] }
    };
    const spec = catalog[this.platform]?.[topic]; if (!spec) throw Error('不支持的诊断项目');
    return this.run(spec[0], spec[1], { signal });
  }
  async repair(action, connection, servers, signal) {
    const p = (f, a) => this.privileged(f, a, signal);
    const c = connection;
    if (action !== 'flush_dns' && (!c?.device || !c?.name)) throw Error('缺少已识别的网络连接；不猜测接口执行修复');
    if (this.platform === 'linux') {
      if (action === 'flush_dns') return p('/usr/bin/resolvectl', ['flush-caches']);
      if (action === 'reconnect' || action === 'renew_dhcp') {
        if (!c.uuid || !/^[a-f0-9-]{36}$/i.test(c.uuid)) throw Error('缺少有效的 NetworkManager 连接 UUID');
        return this.run('nmcli', ['--wait', '12', 'connection', 'up', 'uuid', c.uuid, 'ifname', c.device], { signal, timeout: 15000 });
      }
      if (action === 'set_dns' || action === 'restore_dns') return this.run('nmcli', ['--wait', '10', 'device', 'modify', c.device, 'ipv4.dns', servers.join(','), 'ipv4.ignore-auto-dns', action === 'restore_dns' ? c.ignoreAutoDns || 'no' : 'yes'], { signal, timeout: 12000 });
    }
    if (this.platform === 'darwin') {
      if (action === 'flush_dns') {
        const a = await p('/usr/bin/dscacheutil', ['-flushcache']);
        return a.ok ? p('/usr/bin/killall', ['-HUP', 'mDNSResponder']) : a;
      }
      if (action === 'renew_dhcp') return p('/usr/sbin/ipconfig', ['set', c.device, 'DHCP']);
      // Re-enables the service without powering a working interface down.
      if (action === 'reconnect') return p('/usr/sbin/networksetup', ['-setnetworkserviceenabled', c.name, 'on']);
      if (action === 'set_dns' || action === 'restore_dns') return p('/usr/sbin/networksetup', ['-setdnsservers', c.name, ...(servers.length ? servers : ['Empty'])]);
    }
    if (this.platform === 'win32') {
      if (action === 'flush_dns') return p('ipconfig.exe', ['/flushdns']);
      if (action === 'renew_dhcp') return p('ipconfig.exe', ['/renew', c.name]);
      if (!/^\d+$/.test(c.device)) throw Error('Windows 接口索引无效');
      if (action === 'reconnect') return p('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Get-NetAdapter | Where-Object {$_.ifIndex -eq ${c.device}} | Enable-NetAdapter -Confirm:$false`]);
      if (action === 'set_dns' || action === 'restore_dns') {
        if (servers.some(s => !/^[\da-fA-F:.]+$/.test(s))) throw Error('DNS 地址无效');
        const restoreAuto = action === 'restore_dns' && c.autoDns;
        return p('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Set-DnsClientServerAddress -InterfaceIndex ${c.device} ${servers.length && !restoreAuto ? '-ServerAddresses @(' + servers.map(s => `'${s}'`).join(',') + ')' : '-ResetServerAddresses'}`]);
      }
    }
    throw Error(`平台 ${this.platform} 不支持 ${action}`);
  }
}
