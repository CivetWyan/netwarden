import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/store.mjs';
if (process.platform !== 'linux' && !process.argv.includes('--example')) throw Error('请在 Ubuntu 目标机器上运行此命令生成绝对路径；本机预览用 --example');
const root = process.argv.includes('--example') ? '/opt/网络修复大师' : ROOT;
const runtime = path.join(root, 'runtime-service');
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const unit = `[Unit]
Description=Network Repair Master local network administrator
After=NetworkManager.service network.target

[Service]
Type=simple
User=root
WorkingDirectory=${quote(root)}
ExecStart=${quote(process.platform === 'linux' ? process.execPath : '/usr/bin/node')} ${quote(path.join(root, 'src', 'daemon.mjs'))}
Environment=${quote(`NETWORK_REPAIR_HOME=${runtime}`)}
EnvironmentFile=-${quote(path.join(root, 'deploy', 'model.env'))}
Restart=always
RestartSec=3
TimeoutStopSec=90
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
fs.mkdirSync(path.join(ROOT, 'deploy'), { recursive: true });
const file = path.join(ROOT, 'deploy', 'network-repair-master.service'); fs.writeFileSync(file, unit);
console.log(`服务模板已生成：${file}\n尚未安装或启动系统服务。请按 README 在 Ubuntu 上检查后安装。`);
