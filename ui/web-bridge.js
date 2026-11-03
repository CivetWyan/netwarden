/* Same UI, backed by the remote daemon instead of Electron IPC. */
(() => {
  if (window.netwarden) return;
  const request = async (url, payload) => {
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(90000) });
    if (response.status === 401) { location.reload(); throw Error('登录已过期，请重新登录'); }
    const result = await response.json(); if (!response.ok || !result.ok) throw Error(result.error || '服务器请求失败'); return result.data;
  };
  const invoke = (method, ...args) => request('/api/rpc', { method, args });
  const api = {};
  for (const method of ['state','sample','saveConfig','ask','cancel','testModel','testOnline','patrol','resume','script','review','runbook','playbook','routerUnlock','baseline','retry','restore','search']) api[method] = (...args) => invoke(method, ...args);
  api.export = async () => {
    const {filename, report} = await invoke('export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:'application/json'}));
    const link = document.createElement('a'); link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); return filename;
  };
  api.subscribe = callback => {
    let busy=false; const timer=setInterval(async()=>{
      if(busy)return;busy=true;
      try { const state=await api.state(); callback(state); }
      catch { const label=document.getElementById('monitor-label'); if(label)label.textContent='服务器连接中断，正在重连'; }
      finally {busy=false;}
    },1500); return ()=>clearInterval(timer);
  };
  window.netwarden=api;
  document.addEventListener('DOMContentLoaded',()=>{
    const label=document.querySelector('.local-mark');if(label)label.textContent=`远程管理 · ${location.hostname}`;
    const out=document.createElement('button');out.className='text-button';out.textContent='退出登录';
    out.onclick=async()=>{await request('/api/logout',{});location.reload();};document.querySelector('.header-right')?.append(out);
  });
})();
