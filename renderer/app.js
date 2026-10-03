import { Orb } from './orb.js';
import { Voice } from './voice.js';
import { buildBriefing, formatClock, formatDate, greeting, relativeTime, weatherLabel } from './format.js';

const api = window.jarvis;
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Todo texto vindo de fora (notícias, cidades) entra por textContent, nunca por innerHTML.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const hud = $('#hud');
const caption = $('#caption');
let settings = await api.getSettings();
let weather = null;
let news = [];
let speakId = 0;
let statusNote = '';

// ---------------------------------------------------------------------------
// Esfera e voz
// ---------------------------------------------------------------------------
const voice = new Voice($('#voice-audio'));
let orb = null;
try {
  orb = new Orb($('#orb'), { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  orb.onFrame = () => orb.setLevel(voice.readLevel());
} catch (err) {
  console.error('[esfera] WebGL indisponível:', err);
  hud.classList.add('no-webgl');
}
voice.onFallback = () => {
  statusNote = 'voz do Windows (sem conexão com o serviço de voz)';
  renderStatus();
};

const STATUS = { idle: 'Pronto', listening: 'Ouvindo', thinking: 'Pensando', speaking: 'Falando' };

function renderStatus() {
  const base = STATUS[hud.dataset.state] ?? '';
  $('#status-text').textContent = statusNote ? `${base}, ${statusNote}` : base;
}

function setState(state) {
  hud.dataset.state = state;
  orb?.setState(state);
  if (state === 'idle') statusNote = '';
  renderStatus();
}

const idleCaption = (now = new Date()) => `${greeting(now)}, ${settings.userName}.`;

// ---------------------------------------------------------------------------
// Relógio
// ---------------------------------------------------------------------------
function tick() {
  const now = new Date();
  $('#clock').textContent = formatClock(now);
  $('#date').textContent = formatDate(now);
  if (hud.dataset.state === 'idle') caption.textContent = idleCaption(now);
  if (news.length) renderNews();
  setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
}

// ---------------------------------------------------------------------------
// Clima
// ---------------------------------------------------------------------------
function renderWeather() {
  const c = weather.current;
  const d = weather.daily;
  const rows = [
    ['Sensação', `${Math.round(c.apparent_temperature)}°`],
    ['Umidade', `${Math.round(c.relative_humidity_2m)}%`],
    ['Vento', `${Math.round(c.wind_speed_10m)} km/h`],
    ['Hoje', `${Math.round(d.temperature_2m_min[0])}° a ${Math.round(d.temperature_2m_max[0])}°`],
  ];
  const rain = d.precipitation_probability_max?.[0];
  if (rain != null) rows.push(['Chuva', `${Math.round(rain)}%`]);

  const list = el('dl', 'weather-list');
  for (const [k, v] of rows) list.append(el('dt', null, k), el('dd', null, v));
  $('#weather').replaceChildren(
    el('p', 'weather-temp', `${Math.round(c.temperature_2m)}°`),
    el('p', 'weather-desc', weatherLabel(c.weather_code)),
    el('p', 'weather-city', settings.city.name),
    list,
  );
}

async function loadWeather() {
  try {
    weather = await api.getWeather(settings.city.lat, settings.city.lon);
    renderWeather();
    return true;
  } catch (err) {
    console.warn('[clima]', err);
    if (!weather) {
      $('#weather').replaceChildren(
        el('p', 'muted', 'Não consegui carregar o clima. Verifique a conexão; tento de novo em 2 minutos.'),
      );
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Notícias
// ---------------------------------------------------------------------------
function renderNews() {
  const ul = $('#news');
  ul.replaceChildren(
    ...news.map((n) => {
      const btn = el('button', 'news-item');
      btn.type = 'button';
      btn.title = 'Abrir no navegador';
      const meta = el('span', 'meta');
      meta.append(el('span', null, n.source), el('span', null, relativeTime(n.time)));
      btn.append(el('span', 'headline', n.title), meta);
      btn.addEventListener('click', () => api.openLink(n.link));
      const li = el('li');
      li.append(btn);
      return li;
    }),
  );
}

async function loadNews() {
  try {
    const r = await api.getNews(settings.feeds);
    if (r.items.length) {
      news = r.items;
      renderNews();
      return true;
    }
    throw new Error('nenhuma manchete recebida');
  } catch (err) {
    console.warn('[notícias]', err);
    if (!news.length) {
      $('#news').replaceChildren(
        el('li', 'muted', 'Não consegui carregar as notícias. Verifique a conexão ou as fontes em Ajustes.'),
      );
    }
    return false;
  }
}

// Atualiza em intervalos; se falhar, tenta de novo mais cedo. Devolve a primeira tentativa.
const timers = {};
function loop(name, fn, okMs, failMs) {
  clearTimeout(timers[name]);
  const first = fn();
  first.then((ok) => { timers[name] = setTimeout(() => loop(name, fn, okMs, failMs), ok ? okMs : failMs); });
  return first;
}

// ---------------------------------------------------------------------------
// Fala e resumo do dia
// ---------------------------------------------------------------------------
async function speak(sentences) {
  const id = ++speakId;
  setState('speaking');
  $('#btn-stop').hidden = false;
  try {
    await voice.speakSequence(sentences, {
      settings,
      onSentence: (text) => { caption.textContent = text; },
    });
  } finally {
    if (id === speakId) {
      $('#btn-stop').hidden = true;
      setState('idle');
      caption.textContent = idleCaption();
    }
  }
}

function stopSpeaking() {
  speakId++;
  voice.stop();
  $('#btn-stop').hidden = true;
  setState('idle');
  caption.textContent = idleCaption();
}

let firstLoad = Promise.resolve();

async function runBriefing() {
  const id = ++speakId;
  voice.stop();
  setState('thinking');
  $('#btn-brief').disabled = true;
  try {
    await Promise.race([firstLoad, sleep(6000)]);
    if (id !== speakId) return;
    await speak(buildBriefing({
      name: settings.userName,
      nameSpoken: settings.userNameSpoken,
      now: new Date(),
      weather,
      cityName: settings.city.name,
      news,
    }));
  } finally {
    $('#btn-brief').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------
const drawer = $('#settings');
let voicesLoaded = false;
let pending = {};
let saveTimer = null;

async function save(patch, { debounce = 0 } = {}) {
  Object.assign(settings, patch);
  pending = { ...pending, ...patch };
  clearTimeout(saveTimer);
  const run = async () => {
    const send = pending;
    pending = {};
    settings = await api.setSettings(send);
  };
  if (debounce) saveTimer = setTimeout(run, debounce);
  else await run();
}

async function loadVoices() {
  if (voicesLoaded) return;
  voicesLoaded = true;
  const select = $('#set-voice');
  select.replaceChildren(el('option', null, 'Carregando vozes…'));
  const list = await Promise.race([api.listVoices(), sleep(6000).then(() => null)]).catch(() => null);
  const voices = list?.length ? list : [{ id: settings.voice, name: settings.voice.replace(/^pt-BR-|Neural$/g, ''), gender: '' }];
  select.replaceChildren(
    ...voices.map((v) => {
      const o = el('option', null, `${v.name}${v.gender ? (v.gender === 'Male' ? ' (masculina)' : ' (feminina)') : ''}`);
      o.value = v.id;
      return o;
    }),
  );
  select.value = settings.voice;
}

const feedsToText = (feeds) => feeds.map((f) => `${f.name} | ${f.url}`).join('\n');
function textToFeeds(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const i = line.indexOf('|');
    const name = i >= 0 ? line.slice(0, i).trim() : '';
    const url = (i >= 0 ? line.slice(i + 1) : line).trim();
    return { name: name || (URL.canParse(url) ? new URL(url).hostname : url), url };
  });
}

function fillSettings() {
  $('#set-rate').value = settings.rate;
  $('#out-rate').textContent = `${settings.rate > 0 ? '+' : ''}${settings.rate}%`;
  $('#set-pitch').value = settings.pitch;
  $('#out-pitch').textContent = `${settings.pitch > 0 ? '+' : ''}${settings.pitch} Hz`;
  $('#set-name').value = settings.userName;
  $('#set-name-spoken').value = settings.userNameSpoken;
  $('#city-current').textContent = `Cidade atual: ${settings.city.name}${settings.city.admin ? `, ${settings.city.admin}` : ''}.`;
  $('#set-feeds').value = feedsToText(settings.feeds);
  $('#set-autostart').checked = settings.autostart;
  $('#set-speak').checked = settings.speakOnStart;
  $('#set-fullscreen').checked = settings.fullscreen;
  $('#set-delay').value = settings.startDelaySec;
}

function openSettings() {
  fillSettings();
  drawer.hidden = false;
  $('#settings-close').focus();
  loadVoices();
}
function closeSettings() {
  drawer.hidden = true;
  $('#btn-settings').focus();
}

function bindSettings() {
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#btn-quit').addEventListener('click', () => api.quit());

  $('#set-voice').addEventListener('change', (e) => save({ voice: e.target.value }));
  $('#set-rate').addEventListener('input', (e) => {
    $('#out-rate').textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value}%`;
    save({ rate: Number(e.target.value) }, { debounce: 300 });
  });
  $('#set-pitch').addEventListener('input', (e) => {
    $('#out-pitch').textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value} Hz`;
    save({ pitch: Number(e.target.value) }, { debounce: 300 });
  });
  $('#btn-sample').addEventListener('click', () => {
    const spoken = settings.userNameSpoken || settings.userName;
    speak([{ show: `Olá, ${settings.userName}. Esta é a minha voz.`, say: `Olá, ${spoken}. Esta é a minha voz.` }]);
  });

  $('#set-name').addEventListener('change', (e) => { save({ userName: e.target.value }); caption.textContent = idleCaption(); });
  $('#set-name-spoken').addEventListener('change', (e) => save({ userNameSpoken: e.target.value }));

  const search = async () => {
    const q = $('#city-query').value;
    const msg = $('#city-msg');
    const list = $('#city-results');
    list.replaceChildren();
    msg.hidden = true;
    if (q.trim().length < 2) return;
    try {
      const found = await api.searchCity(q);
      if (!found.length) { msg.textContent = 'Nenhuma cidade encontrada. Tente outro nome.'; msg.hidden = false; return; }
      for (const c of found) {
        const b = el('button');
        b.type = 'button';
        b.append(el('span', null, c.name), el('small', null, c.admin));
        b.addEventListener('click', async () => {
          await save({ city: c });
          list.replaceChildren();
          $('#city-query').value = '';
          fillSettings();
          weather = null;
          loop('weather', loadWeather, 15 * 60e3, 2 * 60e3);
        });
        const li = el('li');
        li.append(b);
        list.append(li);
      }
    } catch {
      msg.textContent = 'Não consegui buscar agora. Verifique a conexão.';
      msg.hidden = false;
    }
  };
  $('#btn-city').addEventListener('click', search);
  $('#city-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });

  $('#set-feeds').addEventListener('change', async (e) => {
    await save({ feeds: textToFeeds(e.target.value) });
    e.target.value = feedsToText(settings.feeds);
    news = [];
    loop('news', loadNews, 20 * 60e3, 2 * 60e3);
  });

  $('#set-autostart').addEventListener('change', (e) => save({ autostart: e.target.checked }));
  $('#set-speak').addEventListener('change', (e) => save({ speakOnStart: e.target.checked }));
  $('#set-fullscreen').addEventListener('change', (e) => save({ fullscreen: e.target.checked }));
  $('#set-delay').addEventListener('change', (e) => save({ startDelaySec: Number(e.target.value) }));

  // prévia: mostra cada estado da esfera por alguns segundos
  let previewTimer = null;
  document.querySelectorAll('[data-preview]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = btn.dataset.preview;
      speakId++;
      voice.stop();
      clearTimeout(previewTimer);
      voice.simulate(state === 'speaking');
      setState(state);
      if (state !== 'idle') {
        previewTimer = setTimeout(() => { voice.simulate(false); setState('idle'); }, 7000);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
$('#btn-brief').addEventListener('click', runBriefing);
$('#btn-stop').addEventListener('click', stopSpeaking);
bindSettings();

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!drawer.hidden) closeSettings();
    else api.setFullscreen(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    drawer.hidden ? openSettings() : closeSettings();
  }
});

tick();
firstLoad = Promise.all([
  loop('weather', loadWeather, 15 * 60e3, 2 * 60e3),
  loop('news', loadNews, 20 * 60e3, 2 * 60e3),
]);

// A esfera leva ~2,6 s para montar; o texto aparece junto com o fim da animação.
const assembleMs = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 2600;
setTimeout(() => {
  hud.classList.add('ready');
  if (settings.speakOnStart) runBriefing();
}, assembleMs);
