'use strict';
// Captura a esfera em cada estado, com WebGL por software (SwiftShader), sem rede.
// Uso: xvfb-run -a npx electron --no-sandbox scripts/shot-orb.js 
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const OUT = process.env.OUT || path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = {
  userName: 'Axl', userNameSpoken: '', voice: 'pt-BR-AntonioNeural', rate: 0, pitch: 0,
  city: { name: 'Natal', admin: 'RN', lat: -5.79, lon: -35.2 }, autostart: false, startDelaySec: 0, speakOnStart: false,
  fullscreen: false, listenOnStart: false, bargeIn: true, webSearch: true, aiModel: 'm', sttModel: 'w', webModel: 'c', micLabel: '', micCompat: false,
};

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, p) => Object.assign(settings, p));
  ipcMain.handle('weather:get', () => ({
    current: { temperature_2m: 28, apparent_temperature: 29, relative_humidity_2m: 63, weather_code: 3, wind_speed_10m: 21 },
    daily: { temperature_2m_max: [29], temperature_2m_min: [25], precipitation_probability_max: [45] },
  }));
  ipcMain.handle('agenda:today', () => ({
    connected: true,
    events: [{ id: 'e1', title: 'Reunião com o time', start: new Date(new Date().setHours(23, 30, 0, 0)).toISOString(), end: new Date(new Date().setHours(23, 59, 0, 0)).toISOString(), allDay: false }, { id: 'e2', title: 'Aniversário da Ana', start: '2026-10-05', end: '2026-10-06', allDay: true }],
    tasks: [{ id: 't1', title: 'Comprar pão' }, { id: 't2', title: 'Pagar a luz' }],
  }));
  ipcMain.handle('google:status', () => ({ hasCredentials: true, connected: true, needsReconnect: false }));
  ipcMain.handle('spotify:status', () => ({ hasCredentials: false, connected: false, needsReconnect: false, redirectUri: 'http://127.0.0.1:8898/callback' }));
  for (const c of ['tts:voices', 'ai:key-status', 'ai:cancel']) ipcMain.handle(c, () => (c === 'ai:key-status' ? { hasKey: true } : []));
  const w = Number(process.env.W || 1366), h = Number(process.env.H || 768);
  const win = new BrowserWindow({ width: w, height: h, show: true, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true } });
  const logs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) logs.push(msg); });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await sleep(5500);   // a esfera leva ~2,6 s para montar
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const wanted = (process.env.STATES || 'idle,listening,thinking,speaking').split(',');
  for (const st of wanted) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-preview="${st}"]').click()`);
    await sleep(1800);
    await shot(`orb-${st}`);
    const c = await win.webContents.capturePage({ x: Math.round(w / 2 - 230), y: Math.round(h * 0.43 - 230), width: 460, height: 460 });
    fs.writeFileSync(path.join(OUT, `crop-${st}.png`), c.resize({ width: 920, height: 920, quality: 'best' }).toPNG());
  }
  console.log(logs.some((l) => /WebGL/i.test(l)) ? `SEM WEBGL: ${logs.filter((l) => /WebGL/i.test(l))[0].slice(0, 200)}` : 'WEBGL OK');
  if (logs.length) console.log(logs.filter((l) => !/WebGL/i.test(l)).slice(0, 5).join('\n'));
  app.exit(0);
});
