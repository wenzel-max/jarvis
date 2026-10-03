'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const settings = require('./src/settings');
const tts = require('./src/tts');
const feeds = require('./src/feeds');
const ai = require('./src/ai');

const AUTOSTART_FLAG = '--autostart';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;

app.setAppUserModelId('com.axl.jarvis');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());
}

function applyAutostart(s) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!s.autostart,
      path: process.execPath,
      // Em desenvolvimento o executável é o próprio Electron e precisa do caminho do app.
      args: app.isPackaged ? [AUTOSTART_FLAG] : [app.getAppPath(), AUTOSTART_FLAG],
    });
  } catch (e) {
    console.error('[autostart]', e.message);
  }
}

async function boot() {
  Menu.setApplicationMenu(null);
  settings.init(app.getPath('userData'));
  tts.init(path.join(app.getPath('userData'), 'tts-cache'));
  ai.init(app.getPath('userData'));
  applyAutostart(settings.get());
  registerIpc();

  // Aberto pelo Windows no login: espera um pouco para o boot terminar.
  const atLogin = process.argv.includes(AUTOSTART_FLAG) || app.getLoginItemSettings().wasOpenedAtLogin;
  if (atLogin) await sleep(settings.get().startDelaySec * 1000);
  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: 'Jarvis',
    backgroundColor: '#090604',
    show: false,
    autoHideMenuBar: true,
    fullscreen: settings.get().fullscreen,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A voz precisa tocar sozinha na abertura, sem clique do usuário.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = settings.update(patch);
    if (patch && 'autostart' in patch) applyAutostart(next);
    return next;
  });
  ipcMain.handle('tts:voices', () => tts.listPtBrVoices());
  ipcMain.handle('tts:synthesize', (_e, opts) => tts.synthesize(opts));
  ipcMain.handle('weather:get', (_e, lat, lon) => feeds.getWeather(lat, lon));
  ipcMain.handle('geo:search', (_e, q) => feeds.searchCity(q));
  ipcMain.handle('news:get', (_e, list) => feeds.getNews(list));
  ipcMain.handle('ai:ask', (e, req) => {
    const id = req && req.id;
    return ai.ask(req || {}, {
      settings: settings.get(),
      onSentence: (text) => { if (!e.sender.isDestroyed()) e.sender.send('ai:sentence', { id, text }); },
    }).then((reply) => {
      // Se o modelo configurado foi trocado por outro que funcionou, guarda o novo.
      if (reply.model && reply.model !== settings.get().aiModel) settings.update({ aiModel: reply.model });
      return reply;
    });
  });
  ipcMain.handle('ai:cancel', () => ai.cancel());
  ipcMain.handle('ai:key-status', () => ({ hasKey: ai.hasKey() }));
  ipcMain.handle('ai:key-set', (_e, key) => {
    try { ai.setKey(key); return { ok: true, hasKey: ai.hasKey() }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('win:fullscreen', (_e, on) => {
    if (!win) return false;
    win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on);
    return win.isFullScreen();
  });
  ipcMain.handle('app:quit', () => app.quit());
}
