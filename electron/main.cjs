const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, safeStorage, powerMonitor, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const project = path.resolve(__dirname, '..');
const portableHome = app.isPackaged ? path.join(app.getPath('home'), '网络修复大师', 'runtime') : path.join(project, 'runtime');
const dataHome = path.resolve(process.env.NETWORK_REPAIR_HOME || portableHome);
fs.mkdirSync(path.join(dataHome, 'electron'), { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(dataHome, 'electron'));
app.setPath('sessionData', path.join(dataHome, 'electron', 'session'));
app.setAppLogsPath(path.join(dataHome, 'electron', 'logs'));
app.setPath('crashDumps', path.join(dataHome, 'electron', 'crashes'));
app.setName('网络修复大师');
let web; let window; let tray; let engine; let unlock; let quitting = false; let shutDown = false;
const uiUrl = pathToFileURL(path.join(project, 'ui', 'index.html')).href;

function show() { if (!window) createWindow(); window.show(); window.focus(); }
function createWindow() {
  window = new BrowserWindow({ width: 1380, height: 920, minWidth: 1060, minHeight: 720, backgroundColor: '#f5f7fa', title: '网络修复大师', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) window.show(); });
  window.loadURL(uiUrl);
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiUrl) throw Error('拒绝非主窗口请求');
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: engine?.store.redact({ message: e.message }).message || e.message }; }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    const [{ Engine }, { Platform }, { acquireLock }, { startWeb }] = await Promise.all([import('../src/engine.mjs'), import('../src/platform.mjs'), import('../src/lock.mjs'), import('../src/web.mjs')]);
    unlock = acquireLock(dataHome);
    const codec = {
      available: () => process.env.NETWORK_REPAIR_SHARED_RUNTIME !== '1' && safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'),
      encrypt: text => safeStorage.encryptString(text).toString('base64'),
      decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
    };
    engine = new Engine({ dir: dataHome, codec, platform: new Platform({ allowPrompts: true }), knowledgeDir: app.isPackaged ? path.join(process.resourcesPath, 'knowledge') : path.join(project, 'knowledge') });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    handle('net:state', () => engine.state());
    handle('net:sample', () => engine.sensor.sample({ fresh: true }));
    handle('net:config', patch => {
      if (patch.startAtLogin !== undefined && process.platform === 'linux' && patch.startAtLogin) throw Error('Linux 开机运行请使用项目内的 systemd 服务模板');
      const previousLogin = engine.store.config.startAtLogin;
      const config = engine.saveConfig(patch);
      if (config.startAtLogin !== previousLogin && process.platform !== 'linux') {
        app.setLoginItemSettings({ openAtLogin: config.startAtLogin, args: ['--hidden'] });
        if (app.getLoginItemSettings().openAtLogin !== config.startAtLogin) { engine.saveConfig({ startAtLogin: previousLogin }); throw Error('系统未接受登录启动设置，请检查系统登录项权限'); }
      }
      return config;
    });
    handle('net:ask', text => engine.ask(text));
    handle('net:cancel', id => engine.tasks.cancel(id));
    handle('net:test', () => engine.testModel());
    handle('net:test-online', () => engine.testOnline());
    handle('net:patrol', () => engine.patrolNow());
    handle('net:resume', id => engine.resumeTask(id));
    handle('net:script', (id, action) => {
      if (action === 'acknowledge-interrupted') return engine.scripts.acknowledgeRun(id);
      if (action === 'approve') return engine.scripts.approve(id);
      if (action === 'run') return engine.runScript(id);
      throw Error('未知脚本动作');
    });
    handle('net:review', (id, action) => {
      if (action === 'preview') return engine.reviews.preview(id);
      if (action === 'retry' || action === 'approve') return engine.reviews.approve(id);
      throw Error('未知复盘动作');
    });
    handle('net:playbook', (id, action) => { if (!['active', 'candidate', 'disabled'].includes(action)) throw Error('未知方案动作'); return engine.playbooks.setState(id, action); });
    handle('net:runbook', (id, action) => {
      if (action === 'activate') return engine.runbooks.activate(id);
      if (action === 'deactivate') return engine.runbooks.deactivate(id);
      throw Error('未知方案动作');
    });
    handle('net:baseline', () => engine.captureBaseline());
    handle('net:retry', () => engine.retry());
    handle('net:restore', () => engine.repair.busy ? Promise.reject(Error('等待当前恢复动作结束后再回滚')) : engine.repair.restore());
    handle('net:search', query => { if (typeof query !== 'string' || query.length > 2000) throw Error('检索词过长'); return engine.knowledge.search(query, 6, 12000); });
    handle('net:export', () => {
      const dir = path.join(dataHome, 'exports'); fs.mkdirSync(dir, { recursive: true });
      const filename = path.join(dir, `network-report-${Date.now()}.json`);
      fs.writeFileSync(filename, JSON.stringify(engine.state(), null, 2), { mode: 0o600 }); return filename;
    });
    createWindow();
    const icon = nativeImage.createFromPath(path.join(project, 'ui', 'tray.png')).resize({ width: 20, height: 20 });
    tray = new Tray(icon); tray.setToolTip('网络修复大师 · 持续感知');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开运行中心', click: show }, { label: '立即探测', click: () => engine.sensor.sample({ fresh: true }).catch(() => {}) }, { type: 'separator' }, { label: '退出网络管理员', click: () => app.quit() }]));
    tray.on('click', show);
    let timer;
    const push = () => { clearTimeout(timer); timer = setTimeout(() => { if (window && !window.isDestroyed()) window.webContents.send('net:update', engine.state()); }, 100); };
    engine.on('change', push); engine.on('event', push);
    powerMonitor.on('resume', () => { engine.sensor.invalidate(); engine.sensor.sample({ fresh: true }).catch(() => {}); });
    if (process.env.NETWORK_WEB_HOST) web = await startWeb(engine, { host: process.env.NETWORK_WEB_HOST, port: Number(process.env.NETWORK_WEB_PORT || 8088) });
    await engine.start();
  }).catch(error => { dialog.showErrorBox('网络管理员无法启动', error.message); quitting = true; unlock?.(); app.exit(1); });
  app.on('activate', () => { if (engine) show(); });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  app.on('before-quit', event => {
    if (shutDown) return;
    event.preventDefault(); if (quitting) return; quitting = true;
    Promise.resolve(web?.close()).then(() => engine?.close()).finally(() => { unlock?.(); tray?.destroy(); shutDown = true; app.quit(); });
  });
}
