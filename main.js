'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, session, safeStorage, Tray, nativeImage, globalShortcut } = require('electron');
const path = require('node:path');
const settings = require('./src/settings');
const tts = require('./src/tts');
const feeds = require('./src/feeds');
const ai = require('./src/ai');
const secrets = require('./src/secrets');
const log = require('./src/log');
const google = require('./src/google');
const spotify = require('./src/spotify');
const reminders = require('./src/reminders');
const usage = require('./src/usage');
const background = require('./src/background');
const updater = require('./src/updater');
const memory = require('./src/memory');
const apps = require('./src/apps');
const windows = require('./src/windows');
const { createTools } = require('./src/tools');
const { applyMicCompat } = require('./src/compat');

const PREWARM_PHRASES = [
  'Pois não?', 'De nada!', 'Não entendi, pode repetir?', 'Só mais um instante.', 'Ainda estou procurando, só mais um pouquinho.',
  'Estou sem conexão com a internet.', 'Atingi o limite gratuito por agora. Tenta de novo daqui a pouco.',
  'Demorei demais para responder. Pode repetir?', 'Não consegui responder agora. Tenta de novo.',
  'Tem um problema com a chave do Groq. Dá uma olhada nos Ajustes.',
];
const AUTOSTART_FLAG = '--autostart';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;
let tools = null;
let bg = null;

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
  app.on('before-quit', () => { bg?.markQuitting(); bg?.stop(); if (spotify.status().connected) spotify.unduck().catch(() => {}); });
}

/** Manda um evento ao renderer; se a janela ainda não existe, guarda e entrega quando ela carregar. */
const queued = [];
function sendToWindow(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send(channel, payload);
  else queued.push([channel, payload]);
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
  usage.init(app.getPath('userData'));
  log.init(app.getPath('userData'));
  log.write('app', `Jarvis ${app.getVersion()} iniciado${app.isPackaged ? '' : ' (modo desenvolvimento)'}`);
  secrets.init(app.getPath('userData'), safeStorage);
  google.init({ secrets, openBrowser: (url) => shell.openExternal(url) });
  spotify.init({ secrets, openBrowser: (url) => shell.openExternal(url) });
  if (spotify.status().connected) spotify.restoreAfterCrash().catch(() => {});
  memory.init(app.getPath('userData'));
  reminders.init(app.getPath('userData'), { onFire: (r) => { log.write('app', `lembrete: ${r.text}`); sendToWindow('reminder:fire', r); } });
  tools = createTools({
    reminders, memory, apps, windows,
    weather: feeds.getForecast,
    openers: { openPath: (p) => shell.openPath(p), openExternal: (u) => shell.openExternal(u) },
    google,
    web: (q, ctx) => ai.webSearch(q, { settings: settings.get(), signal: ctx?.signal, log: (k, t) => log.write(k, t), onSetting: (k, v) => settings.update({ [k]: v }) }),
    isGoogleConnected: () => google.status().connected,
    log: (kind, text) => log.write(kind, text),
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
  bg = background.create({
    Tray, Menu, nativeImage, globalShortcut,
    iconPath: path.join(__dirname, 'build', 'tray.png'),
    getWin: () => win,
    send: (channel, payload) => sendToWindow(channel, payload),
    quit: () => app.quit(),
    settings: () => settings.get(),
    log: (kind, text) => log.write(kind, text),
  });
  bg.start();
  updater.create({ isPackaged: app.isPackaged, settings: () => settings.get(), log: (k, t) => log.write(k, t) }).start();
  // Frases curtas que ele repete muito ficam prontas no cache de voz (com calma, longe do boot).
  setTimeout(() => {
    const s = settings.get();
    tts.prewarm(PREWARM_PHRASES, { voice: s.voice, rate: s.rate, pitch: s.pitch }).then((n) => { if (n) log.write('app', `cache de voz: ${n} frase(s) preparada(s)`); });
  }, 45000).unref();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: 'Jarvis',
    icon: path.join(__dirname, 'build', 'icon.png'),
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
      // Escondido na bandeja, o Jarvis continua ouvindo e os lembretes continuam disparando.
      backgroundThrottling: false,
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
  win.on('close', (e) => { bg?.onClose(e); });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => { while (queued.length) win.webContents.send(...queued.shift()); });
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
  ipcMain.handle('ai:ask', (e, req) => {
    const id = req && req.id;
    return ai.ask(req || {}, {
      settings: settings.get(),
      tools,
      onSentence: (text) => { if (!e.sender.isDestroyed()) e.sender.send('ai:sentence', { id, text }); },
    }).then((reply) => {
      if (reply.error) log.write('ia', `erro: ${reply.error}`);
      if (reply.provider === 'Gemini') log.write('ia', 'respondido pelo Gemini (reserva)');
      // Se o modelo configurado foi trocado por outro que funcionou, guarda o novo.
      if (reply.model && reply.model !== settings.get().aiModel) settings.update({ aiModel: reply.model });
      if (reply.geminiModel) settings.update({ fallbackModel: reply.geminiModel });
      return reply;
    });
  });
  ipcMain.handle('win:wake', () => bg?.show({ byWake: true }));
  ipcMain.handle('win:conversation-ended', () => bg?.conversationEnded());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('usage:summary', () => usage.summary());
  ipcMain.handle('memory:list', () => memory.list());
  ipcMain.handle('memory:remove', (_e, id) => { memory.remove(String(id ?? '')); return memory.list(); });
  ipcMain.handle('memory:clear', () => { memory.clear(); return []; });
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
    const allowed = ['pause', 'resume', 'next', 'previous', 'volume', 'louder', 'quieter', 'now', 'duck', 'unduck'];
    if (!req || !allowed.includes(req.action)) return { ok: false, error: 'Comando de música desconhecido.' };
    try {
      return { ok: true, message: await spotify.control(req.action, req.value) };
    } catch (err) {
      if (req.action === 'duck' || req.action === 'unduck') { log.write('app', `música (${req.action}): ${err.message}`); return { ok: true, message: '' }; }   // nunca falar por causa do ducking
      return { ok: false, error: err.message };
    }
  });
  // o renderer registra o que ouviu e por que ignorou, para o Diagnóstico nos Ajustes
  ipcMain.handle('log:write', (_e, kind, text) => {
    if (['ouvi', 'mic', 'app'].includes(kind) && typeof text === 'string') log.write(kind, text.slice(0, 500));
  });
  ipcMain.handle('log:tail', () => log.tail(40));
  ipcMain.handle('log:clear', () => { log.clear(); return true; });
  ipcMain.handle('log:folder', () => { shell.showItemInFolder(log.location()); });
  ipcMain.handle('stt:transcribe', async (_e, req) => {
    const bytes = req?.audio?.byteLength ?? req?.audio?.length ?? 0;
    const reply = await ai.transcribe(req || {}, { settings: settings.get() });
    if (bytes && reply.error !== 'limite local' && !/^Falta a chave|^O formato|longa demais/.test(reply.error ?? '')) usage.recordStt(bytes);
    const warn = usage.warning();
    if (warn) reply.usageWarning = warn;
    if (reply.error && !/^Não entendi/.test(reply.error)) log.write('voz', `transcrição falhou: ${reply.error}`);
    if (reply.model && reply.model !== settings.get().sttModel) settings.update({ sttModel: reply.model });
    return reply;
  });
  ipcMain.handle('ai:cancel', () => ai.cancel());
  ipcMain.handle('ai:key-status', () => ({ hasKey: ai.hasKey(), hasFallbackKey: ai.hasKey('gemini') }));
  ipcMain.handle('ai:key-set', (_e, key, provider) => {
    const which = provider === 'gemini' ? 'gemini' : 'groq';
    try { ai.setKey(key, which); return { ok: true, hasKey: ai.hasKey(), hasFallbackKey: ai.hasKey('gemini') }; } catch (err) { return { ok: false, error: err.message }; }
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
