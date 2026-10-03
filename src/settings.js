'use strict';
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
  feeds: [
    { name: 'G1', url: 'https://g1.globo.com/rss/g1/' },
    { name: 'Folha', url: 'https://feeds.folha.uol.com.br/emcimadahora/rss091.xml' },
    { name: 'Tecnoblog', url: 'https://tecnoblog.net/feed/' },
  ],
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

  const c = out.city || {};
  const lat = Number(c.lat), lon = Number(c.lon);
  out.city = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? { name: str(c.name, 80, 'Local'), admin: typeof c.admin === 'string' ? c.admin.slice(0, 80) : '', lat, lon }
    : DEFAULTS.city;

  out.feeds = (Array.isArray(out.feeds) ? out.feeds : [])
    .filter((f) => f && typeof f.url === 'string' && /^https?:\/\//i.test(f.url))
    .slice(0, 8)
    .map((f) => ({ name: str(f.name, 30, new URL(f.url).hostname), url: f.url.trim().slice(0, 500) }));
  if (!out.feeds.length) out.feeds = structuredClone(DEFAULTS.feeds);
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

module.exports = { init, get, update, DEFAULTS };
