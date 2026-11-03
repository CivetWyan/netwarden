import fs from 'node:fs';
import path from 'node:path';
export function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'engine.lock');
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch {} }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8')); let alive = true;
      try { if (!pid) alive = false; else process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw Error(`同一数据目录已被进程 ${pid} 使用；请先停止另一窗口或后台服务`);
      fs.unlinkSync(file);
    }
  }
  throw Error('无法取得运行锁');
}
