'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, session, safeStorage } = require('electron');
const path = require('node:path');
const settings = require('./src/settings');
const tts = require('./src/tts');
const feeds = require('./src/feeds');
const ai = require('./src/ai');
const secrets = require('./src/secrets');
const google = require('./src/google');
const spotify = require('./src/spotify');
const { createTools } = require('./src/tools');
const { applyMicCompat } = require('./src/compat');

const AUTOSTART_FLAG = '--autostart';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;
let tools = null;

app.setAppUserModelId('com.axl.jarvis');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Precisa ser antes de o app ficar pronto: lê as configurações já na partida.
  settings.init(app.getPath('userData'));
  applyMicCompat(app, settings.get().micCompat);
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

/** O app só precisa do microfone, e só para a nossa própria página local. */
function allowMicrophoneOnly() {
  const ours = (url) => typeof url === 'string' && url.startsWith('file://');
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const audioOnly = !details.mediaTypes || details.mediaTypes.every((t) => t === 'audio');
    callback(permission === 'media' && audioOnly && ours(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && ours(origin));
}

async function boot() {
  Menu.setApplicationMenu(null);
  settings.init(app.getPath('userData'));
  tts.init(path.join(app.getPath('userData'), 'tts-cache'));
  ai.init(app.getPath('userData'));
  secrets.init(app.getPath('userData'), safeStorage);
  google.init({ secrets, openBrowser: (url) => shell.openExternal(url) });
  spotify.init({ secrets, openBrowser: (url) => shell.openExternal(url) });
  tools = createTools({
    google,
    web: (q, ctx) => ai.webSearch(q, { settings: settings.get(), signal: ctx?.signal, onSetting: (k, v) => settings.update({ [k]: v }) }),
    isGoogleConnected: () => google.status().connected,
    spotify: { definitions: spotify.definitions, handlers: spotify.handlers },
    isSpotifyConnected: () => spotify.status().connected,
    settings: () => settings.get(),
  });
  applyAutostart(settings.get());
  allowMicrophoneOnly();
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
      tools,
      onSentence: (text) => { if (!e.sender.isDestroyed()) e.sender.send('ai:sentence', { id, text }); },
    }).then((reply) => {
      // Se o modelo configurado foi trocado por outro que funcionou, guarda o novo.
      if (reply.model && reply.model !== settings.get().aiModel) settings.update({ aiModel: reply.model });
      return reply;
    });
  });
  ipcMain.handle('google:status', () => google.status());
  ipcMain.handle('google:connect', async (_e, creds) => {
    try { return { ok: true, ...(await google.connect(creds || {})) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('google:disconnect', async () => ({ ok: true, ...(await google.disconnect()) }));
  ipcMain.handle('agenda:today', () => google.today());
  ipcMain.handle('spotify:status', () => spotify.status());
  ipcMain.handle('spotify:connect', async (_e, creds) => {
    try { return { ok: true, ...(await spotify.connect(creds || {})) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('spotify:disconnect', async () => ({ ok: true, ...(await spotify.disconnect()) }));
  ipcMain.handle('media:control', async (_e, req) => {
    const allowed = ['pause', 'resume', 'next', 'previous', 'volume', 'louder', 'quieter', 'now'];
    if (!req || !allowed.includes(req.action)) return { ok: false, error: 'Comando de música desconhecido.' };
    try { return { ok: true, message: await spotify.control(req.action, req.value) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('stt:transcribe', async (_e, req) => {
    const reply = await ai.transcribe(req || {}, { settings: settings.get() });
    if (reply.model && reply.model !== settings.get().sttModel) settings.update({ sttModel: reply.model });
    return reply;
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
  ipcMain.handle('app:relaunch', () => {
    // sem --autostart, para não esperar de novo o atraso de boot
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== AUTOSTART_FLAG) });
    app.exit(0);
  });
}
