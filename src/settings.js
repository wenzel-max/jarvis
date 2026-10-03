'use strict';
const { isValidTarget } = require('./apps');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  userName: 'Axl',
  userNameSpoken: '',          // pronúncia alternativa (ex.: "Áxel"); vazio = usa userName
  voice: 'pt-BR-AntonioNeural',
  rate: 0,                     // -50..50 (%)
  pitch: 0,                    // -30..30 (Hz)
  city: { name: 'Ceará-Mirim', admin: 'Rio Grande do Norte', lat: -5.6339, lon: -35.4256 },
  autostart: true,
  startDelaySec: 20,           // espera após ligar o PC, para não competir com o boot
  speakOnStart: true,
  fullscreen: true,
  aiModel: 'llama-3.1-8b-instant',  // modelo do Groq usado nas perguntas
  fallbackModel: 'gemini-2.5-flash',  // modelo do Gemini usado quando o Groq está limitado ou fora do ar
  sttModel: 'whisper-large-v3-turbo', // modelo do Groq que transcreve a fala
  webSearch: true,             // a IA pode pesquisar na internet (modelo Compound do Groq)
  webModel: 'groq/compound-mini',
  duckMusic: true,             // abaixa a música do Spotify enquanto o Jarvis fala
  earcons: true,               // sons curtos de confirmação (reconheceu o pedido, escuta ligada/desligada)
  apps: [],                    // programas extras que o Jarvis pode abrir: [{ name, target }]
  autoUpdate: true,            // procura versões novas no GitHub (só no app instalado)
  backgroundMode: true,        // fechar a janela deixa o Jarvis na bandeja, ouvindo; "Jarvis" faz a janela voltar
  bargeIn: true,               // falar por cima interrompe o Jarvis (desligue se usar caixas de som e ele se ouvir)
  listenOnStart: true,         // microfone sempre aberto ao iniciar (o Jarvis só age quando ouve "Jarvis")
  micCompat: false,            // desliga o sandbox de áudio do Chromium (para drivers que não abrem o microfone)
  micLabel: '',                // microfone escolhido (parte do nome); vazio = automático, evitando virtuais
};

let file = null;
let data = structuredClone(DEFAULTS);

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const str = (v, max, fallback) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback;

function sanitize(raw) {
  const out = { ...DEFAULTS, ...raw };
  out.userName = str(out.userName, 40, DEFAULTS.userName);
  out.userNameSpoken = typeof out.userNameSpoken === 'string' ? out.userNameSpoken.trim().slice(0, 40) : '';
  out.voice = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(out.voice) ? out.voice : DEFAULTS.voice;
  out.rate = clamp(out.rate, -50, 50, 0);
  out.pitch = clamp(out.pitch, -30, 30, 0);
  out.startDelaySec = clamp(out.startDelaySec, 0, 180, DEFAULTS.startDelaySec);
  out.autostart = !!out.autostart;
  out.speakOnStart = !!out.speakOnStart;
  out.fullscreen = !!out.fullscreen;
  out.bargeIn = !!out.bargeIn;
  out.earcons = !!out.earcons;
  out.backgroundMode = !!out.backgroundMode;
  out.autoUpdate = !!out.autoUpdate;
  out.duckMusic = !!out.duckMusic;
  out.webSearch = !!out.webSearch;
  out.listenOnStart = !!out.listenOnStart;
  out.micCompat = !!out.micCompat;
  out.apps = (Array.isArray(out.apps) ? out.apps : [])
    .filter((a) => a && typeof a.name === 'string' && a.name.trim() && isValidTarget(a.target))
    .slice(0, 20)
    .map((a) => ({ name: a.name.trim().slice(0, 40), target: a.target }));
  out.micLabel = typeof out.micLabel === 'string' ? out.micLabel.trim().slice(0, 120) : '';
  for (const k of ['aiModel', 'sttModel', 'webModel', 'fallbackModel']) {
    out[k] = typeof out[k] === 'string' && /^[A-Za-z0-9._\/:-]{1,80}$/.test(out[k].trim()) ? out[k].trim() : DEFAULTS[k];
  }

  const c = out.city || {};
  const lat = Number(c.lat), lon = Number(c.lon);
  out.city = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? { name: str(c.name, 80, 'Local'), admin: typeof c.admin === 'string' ? c.admin.slice(0, 80) : '', lat, lon }
    : DEFAULTS.city;

  delete out.feeds;   // as notícias saíram do Jarvis; configurações antigas com feeds são limpas aqui
  return out;
}

function init(dir) {
  file = path.join(dir, 'settings.json');
  try {
    data = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    data = sanitize({});
  }
}

const get = () => data;

function update(patch) {
  data = sanitize({ ...data, ...(patch && typeof patch === 'object' ? patch : {}) });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[settings] não foi possível salvar:', e.message);
  }
  return data;
}

module.exports = { init, get, update, DEFAULTS, sanitize };
