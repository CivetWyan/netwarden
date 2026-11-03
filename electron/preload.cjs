const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => { const result = await ipcRenderer.invoke(channel, ...args); if (!result.ok) throw Error(result.error); return result.data; };
contextBridge.exposeInMainWorld('netwarden', {
  state: () => invoke('net:state'), sample: () => invoke('net:sample'), saveConfig: patch => invoke('net:config', patch),
  ask: text => invoke('net:ask', text), cancel: id => invoke('net:cancel', id), testModel: () => invoke('net:test'),
  testOnline: () => invoke('net:test-online'), patrol: () => invoke('net:patrol'), resume: id => invoke('net:resume', id),
  script: (id, action) => invoke('net:script', id, action), review: (id, action) => invoke('net:review', id, action), runbook: (id, action) => invoke('net:runbook', id, action), playbook: (id, action) => invoke('net:playbook', id, action),
  baseline: () => invoke('net:baseline'), retry: () => invoke('net:retry'), restore: () => invoke('net:restore'),
  search: query => invoke('net:search', query), export: () => invoke('net:export'),
  subscribe: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('net:update', listener); return () => ipcRenderer.removeListener('net:update', listener); }
});
