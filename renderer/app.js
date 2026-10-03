import { Orb } from './orb.js';
import { Voice } from './voice.js';
import { Mic, micErrorMessage, explainNoSpeech, listMicrophones, cleanLabel } from './mic.js';
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
let chat = [];            // últimas perguntas e respostas, para a IA entender "e amanhã?"
let weather = null;
let news = [];
let speakId = 0;
let statusNote = '';

// ---------------------------------------------------------------------------
// Esfera e voz
// ---------------------------------------------------------------------------
const voice = new Voice($('#voice-audio'));
const mic = new Mic();
let orb = null;
try {
  orb = new Orb($('#orb'), { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  orb.onFrame = () => orb.setLevel(hud.dataset.state === 'listening' ? mic.level : voice.readLevel());
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
async function speak(sentences, { startState = 'speaking' } = {}) {
  const id = ++speakId;
  setState(startState);
  $('#btn-stop').hidden = false;
  try {
    await voice.speakSequence(sentences, {
      settings,
      onSentence: (text) => {
        if (id !== speakId) return;
        if (hud.dataset.state !== 'speaking') setState('speaking');
        caption.textContent = text;
      },
    });
  } finally {
    if (id === speakId) {
      $('#btn-stop').hidden = true;
      setState('idle');
      caption.textContent = idleCaption();
    }
  }
}

/** Interrompe a pergunta em andamento (IA e fila de frases), se houver. */
function abortAsk() {
  api.cancelAi();
  currentQueue?.end();
  mic.cancel();
}

function stopSpeaking() {
  speakId++;
  abortAsk();
  askInput.disabled = askSend.disabled = false;
  voice.stop();
  $('#btn-stop').hidden = true;
  setState('idle');
  caption.textContent = idleCaption();
}

// ---------------------------------------------------------------------------
// Perguntas à IA
// ---------------------------------------------------------------------------
/** Fila de frases: a IA empurra conforme escreve e a voz puxa conforme fala. */
function sentenceQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(x) { items.push(x); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (ended) return;
        await new Promise((r) => { wake = r; });
        wake = null;
      }
    },
  };
}

let currentQueue = null;
const askInput = $('#ask-input');
const askSend = $('#ask-send');

async function ask(question) {
  voice.stop();
  abortAsk();
  const queue = sentenceQueue();
  currentQueue = queue;
  askInput.disabled = askSend.disabled = true;
  caption.textContent = question;

  const speaking = speak(queue, { startState: 'thinking' });
  const sid = speakId;   // speak() acabou de gerar o id desta fala
  let reply;
  try {
    reply = await api.askAi({ question, history: chat }, (text) => queue.push(text));
  } catch (err) {
    console.warn('[ia]', err);
    reply = { error: 'Algo deu errado ao falar com a IA. Tente de novo.' };
  }
  queue.end();
  if (sid === speakId && reply.text) {
    chat = [...chat, { role: 'user', content: question }, { role: 'assistant', content: reply.text }].slice(-8);
  }
  // Erro antes de qualquer fala: mostra a mensagem na hora, sem esperar a voz.
  const early = sid === speakId && !!reply.error && hud.dataset.state === 'thinking';
  if (early) {
    speakId++;
    voice.stop();
    setState('idle');
    $('#btn-stop').hidden = true;
  }
  await speaking;
  if (reply.error && (early || sid === speakId)) caption.textContent = reply.error;
  if (currentQueue === queue) {
    askInput.disabled = askSend.disabled = false;
    askInput.focus();
  }
}

// ---------------------------------------------------------------------------
// Voz de entrada
// ---------------------------------------------------------------------------
const micBtn = $('#ask-mic');

/** Mostra uma mensagem na legenda e volta ao repouso. */
function showNotice(text) {
  setState('idle');
  $('#btn-stop').hidden = true;
  caption.textContent = text;
}

async function listen() {
  if (mic.active) { mic.finish(); return; }   // segundo clique = terminei de falar
  const id = ++speakId;
  voice.stop();
  abortAsk();
  currentQueue = null;   // uma resposta antiga não deve reativar o campo durante a escuta
  askInput.disabled = askSend.disabled = true;
  micBtn.textContent = 'Terminei';
  setState('listening');
  caption.textContent = 'Pode falar.';
  $('#btn-stop').hidden = false;

  let heard = null;
  let problem = null;
  mic.preferred = settings.micLabel;
  try {
    heard = await mic.record();
  } catch (err) {
    console.warn('[microfone]', err);
    problem = micErrorMessage(err);
  }
  micBtn.textContent = 'Falar';
  if (id !== speakId) return;   // outra ação assumiu (parar, resumo, pergunta digitada)

  if (problem || !heard) {
    askInput.disabled = askSend.disabled = false;
    showNotice(problem ?? explainNoSpeech(mic.stats, mic.report));
    return;
  }

  setState('thinking');
  caption.textContent = 'Entendendo…';
  let reply;
  try {
    reply = await api.transcribe(heard.buffer, heard.mime);
  } catch (err) {
    console.warn('[voz de entrada]', err);
    reply = { error: 'Algo deu errado ao entender a sua voz. Tente de novo.' };
  }
  if (id !== speakId) return;
  askInput.disabled = askSend.disabled = false;
  if (reply.error) { showNotice(reply.error); return; }
  ask(reply.text);
}

micBtn.addEventListener('click', listen);

$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = askInput.value.trim();
  if (!q || askInput.disabled) return;
  askInput.value = '';
  ask(q);
});

let firstLoad = Promise.resolve();

async function runBriefing() {
  const id = ++speakId;
  abortAsk();
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
  $('#set-ai-model').value = settings.aiModel;
  $('#set-stt-model').value = settings.sttModel;
  refreshAiStatus();
}

async function refreshAiStatus() {
  const { hasKey } = await api.aiKeyStatus();
  $('#ai-status').textContent = hasKey
    ? 'Chave salva com segurança neste computador. Cole outra para trocar, ou deixe vazio e salve para apagar.'
    : 'Sem chave ainda. Crie uma chave gratuita no Groq e cole aqui para poder fazer perguntas.';
}

/** Preenche a lista de microfones; os nomes só aparecem depois que o microfone foi aberto uma vez. */
async function refreshMicList() {
  const select = $('#set-mic');
  const devices = (await listMicrophones()).filter((d) => !d.alias && d.label);
  const options = [{ value: '', text: 'Automático (evita microfones virtuais)' }];
  for (const d of devices) options.push({ value: cleanLabel(d.label), text: d.virtual ? `${cleanLabel(d.label)} (virtual)` : cleanLabel(d.label) });
  if (settings.micLabel && !options.some((o) => o.value === settings.micLabel)) {
    options.push({ value: settings.micLabel, text: `${settings.micLabel} (não encontrado agora)` });
  }
  select.replaceChildren(...options.map((o) => { const n = el('option', null, o.text); n.value = o.value; return n; }));
  select.value = settings.micLabel;
}

function openSettings() {
  fillSettings();
  refreshMicList();
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
  $('#btn-ai-getkey').addEventListener('click', () => api.openLink('https://console.groq.com/keys'));
  $('#btn-ai-key').addEventListener('click', async () => {
    const msg = $('#ai-msg');
    const input = $('#set-ai-key');
    const r = await api.setAiKey(input.value);
    msg.hidden = false;
    msg.textContent = r.ok ? (r.hasKey ? 'Chave salva.' : 'Chave apagada.') : r.error;
    if (r.ok) input.value = '';
    refreshAiStatus();
  });
  $('#set-ai-model').addEventListener('change', async (e) => {
    await save({ aiModel: e.target.value });
    e.target.value = settings.aiModel;
  });
  $('#set-mic').addEventListener('change', (e) => save({ micLabel: e.target.value }));
  $('#btn-mic-test').addEventListener('click', async () => {
    const msg = $('#mic-msg');
    const btn = $('#btn-mic-test');
    if (mic.active) { mic.cancel(); return; }
    speakId++;
    voice.stop();
    abortAsk();
    btn.textContent = 'Fale agora…';
    msg.hidden = false;
    msg.textContent = 'Ouvindo por 4 segundos. Diga alguma coisa.';
    setState('listening');
    let problem = null;
    mic.preferred = settings.micLabel;
    try {
      await mic.record({ maxMs: 4000, noSpeechMs: 4000, silenceMs: 4000 });
    } catch (err) {
      problem = micErrorMessage(err);
    }
    setState('idle');
    refreshMicList();
    btn.textContent = 'Testar microfone';
    if (problem) { msg.textContent = problem; return; }
    const s = mic.stats;
    msg.textContent = s.speechMs >= 300
      ? `Funcionando: "${cleanLabel(s.label) || 'microfone'}" captou a sua voz (nível máximo ${Math.round(Math.min(1, s.peak * 5) * 100)}%).`
      : explainNoSpeech(s, mic.report);
  });
  $('#set-stt-model').addEventListener('change', async (e) => {
    await save({ sttModel: e.target.value });
    e.target.value = settings.sttModel;
  });
  $('#set-delay').addEventListener('change', (e) => save({ startDelaySec: Number(e.target.value) }));

  // prévia: mostra cada estado da esfera por alguns segundos
  let previewTimer = null;
  document.querySelectorAll('[data-preview]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const state = btn.dataset.preview;
      speakId++;
      abortAsk();
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
    if (mic.active) stopSpeaking();
    else if (!drawer.hidden) closeSettings();
    else api.setFullscreen(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    listen();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    askInput.focus();
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
