import { Orb } from './orb.js';
import { Voice } from './voice.js';
import { Mic, micErrorMessage, explainNoSpeech, listMicrophones, cleanLabel } from './mic.js';
import { parseCommand, classifyShort, classifyMedia } from './wake.js';
import { buildBriefing, formatClock, formatDate, greeting, weatherLabel } from './format.js';

const api = window.jarvis;
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Todo texto vindo de fora (cidades, compromissos) entra por textContent, nunca por innerHTML.
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const hud = $('#hud');
const notice$ = $('#notice');   // só para avisos e erros; o Jarvis não mostra legenda do que fala
let settings = await api.getSettings();
let chat = [];            // últimas perguntas e respostas, para a IA entender "e amanhã?"
let weather = null;
let agenda = null;
let spotifyOn = false;   // Spotify conectado: ativa os comandos de música sem IA
let speakId = 0;
let statusNote = '';
let followUntil = 0;   // até quando a conversa continua sem precisar dizer "Jarvis"

// ---------------------------------------------------------------------------
// Esfera e voz
// ---------------------------------------------------------------------------
const voice = new Voice();
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
  let base = STATUS[hud.dataset.state] ?? '';
  if (hud.dataset.state === 'idle' && mic.running) {
    base = Date.now() < followUntil ? 'Pode continuar falando' : 'Pronto, diga "Jarvis"';
  }
  $('#status-text').textContent = statusNote ? `${base}, ${statusNote}` : base;
}

let resumeTimer = null;

function setState(state) {
  hud.dataset.state = state;
  orb?.setState(state);
  if (state === 'idle') statusNote = '';
  // Enquanto o Jarvis pensa ou fala, o microfone só reage a uma fala forte e firme (você
  // interrompendo); a voz dele em si não pode contar. Volta ao normal um instante depois
  // que ele termina, por causa da sobra de eco no ambiente.
  clearTimeout(resumeTimer);
  if (state === 'speaking' || state === 'thinking') {
    mic.setDuck(true);
  } else if (state === 'idle') {
    resumeTimer = setTimeout(() => mic.setDuck(false), 700);
  } else {
    mic.setDuck(false);
  }
  renderStatus();
}

let noticeTimer = null;
/** Mostra um aviso discreto por alguns segundos. */
function showNotice(text) {
  clearTimeout(noticeTimer);
  notice$.textContent = text;
  notice$.hidden = false;
  noticeTimer = setTimeout(clearNotice, Math.min(15000, 4000 + text.length * 60));
}
function clearNotice() {
  clearTimeout(noticeTimer);
  notice$.hidden = true;
  notice$.textContent = '';
}

// ---------------------------------------------------------------------------
// Relógio
// ---------------------------------------------------------------------------
function tick() {
  const now = new Date();
  $('#clock').textContent = formatClock(now);
  $('#date').textContent = formatDate(now);
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
// Agenda e tarefas (Google)
// ---------------------------------------------------------------------------
const hhmm = (iso) => formatClock(new Date(iso));

function renderAgenda() {
  const box = $('#agenda');
  if (!agenda?.connected) {
    const text = agenda?.needsReconnect
      ? 'O acesso ao Google expirou. Reconecte em Ajustes.'
      : 'Conecte o Google em Ajustes para ver aqui a sua agenda e as suas tarefas.';
    box.replaceChildren(el('h2', null, 'Agenda'), el('p', 'muted', text));
    return;
  }
  const nodes = [el('h2', null, 'Hoje na agenda')];
  if (agenda.error) {
    nodes.push(el('p', 'muted', agenda.error));
  } else {
    const list = el('ul');
    const now = new Date();
    for (const e of agenda.events.slice(0, 6)) {
      const li = el('li');
      if (!e.allDay && new Date(e.end || e.start) < now) li.className = 'done';
      li.append(el('time', null, e.allDay ? 'dia todo' : hhmm(e.start)), el('span', null, e.title));
      list.append(li);
    }
    if (!agenda.events.length) list.append(el('li', 'muted', 'Nada marcado para hoje.'));
    nodes.push(list);
    if (agenda.tasks.length) {
      nodes.push(el('h2', null, 'Tarefas'));
      const tasks = el('ul');
      for (const t of agenda.tasks.slice(0, 5)) {
        const li = el('li');
        li.append(el('time', null, '·'), el('span', null, t.title));
        tasks.append(li);
      }
      nodes.push(tasks);
    }
  }
  box.replaceChildren(...nodes);
}

async function loadAgenda() {
  try {
    agenda = await api.agendaToday();
    renderAgenda();
    return !agenda.error;
  } catch (err) {
    console.warn('[agenda]', err);
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
      onSentence: () => {
        if (id !== speakId) return;
        if (hud.dataset.state !== 'speaking') setState('speaking');
      },
    });
  } finally {
    if (id === speakId) {
      $('#btn-stop').hidden = true;
      setState('idle');
    }
  }
}

/** Interrompe a pergunta em andamento (IA e fila de frases), se houver. */
function abortAsk() {
  api.cancelAi();
  currentQueue?.end();
}

function stopSpeaking() {
  speakId++;
  abortAsk();
  followUntil = 0;
  voice.stop();
  $('#btn-stop').hidden = true;
  setState('idle');
  clearNotice();
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

/**
 * Faz a pergunta à IA e fala a resposta. Devolve `true` se a resposta terminou sem ser
 * interrompida por outra ação (parar, resumo...).
 */
async function ask(question) {
  voice.stop();
  abortAsk();
  const queue = sentenceQueue();
  currentQueue = queue;

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
  if (reply.error && (early || sid === speakId)) showNotice(reply.error);
  return early || sid === speakId;
}

// ---------------------------------------------------------------------------
// Voz de entrada
// O microfone fica aberto; o Jarvis só age quando ouve "Jarvis" no começo da frase,
// ou logo depois de uma resposta (FOLLOW_UP_MS), para a conversa continuar sem repetir o nome.
// ---------------------------------------------------------------------------
const FOLLOW_UP_MS = 15000;
const MAX_TRANSCRIPTIONS_PER_MIN = 10;   // o plano gratuito do Whisper permite 20
const MAX_MISSES = 2;                    // "não entendi" seguidos antes de voltar a esperar o nome
const NOTICE_EVERY_MS = 60000;

const btnMic = $('#btn-mic');
let transcribing = false;
let pendingSeg = null;   // você continuou falando enquanto a frase anterior era transcrita
let misses = 0;
let sttTimes = [];
let lastNotice = 0;

function renderMicButton() {
  btnMic.textContent = mic.running ? 'Escuta ligada' : 'Escuta desligada';
  btnMic.classList.toggle('is-on', mic.running);
  renderStatus();
}

/** Aviso discreto, no máximo um por minuto (o microfone fica aberto o tempo todo). */
function notice(text, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastNotice < NOTICE_EVERY_MS) return;
  lastNotice = now;
  if (hud.dataset.state === 'idle' || hud.dataset.state === 'listening') {
    setState('idle');
    showNotice(text);
  }
}

function openFollowUp() {
  followUntil = Date.now() + FOLLOW_UP_MS;
  setTimeout(renderStatus, FOLLOW_UP_MS + 100);
  renderStatus();
}

const isMiss = (error) => /^Não entendi/.test(error);

/** Transcreve um trecho, respeitando o limite por minuto. Nunca lança. */
async function transcribeSegment(seg) {
  const now = Date.now();
  sttTimes = sttTimes.filter((t) => now - t < 60000);
  if (sttTimes.length >= MAX_TRANSCRIPTIONS_PER_MIN) return { error: 'limite local' };
  sttTimes.push(now);
  try {
    return await api.transcribe(seg.buffer, seg.mime);
  } catch (err) {
    console.warn('[voz de entrada]', err);
    return { error: 'Algo deu errado ao entender a sua voz.' };
  }
}

/** Você começou a falar por cima do Jarvis: ele para na hora e passa a ouvir. */
function interrupt() {
  speakId++;
  abortAsk();
  voice.stop();
  $('#btn-stop').hidden = true;
  clearNotice();
  openFollowUp();               // quem interrompe está falando com o Jarvis: não precisa dizer o nome
  setState('listening');
}

/** Uma frase captada pelo microfone: transcreve e decide se é com o Jarvis. */
async function handleSegment(seg) {
  if (transcribing) { pendingSeg = seg; return; }
  const inConversation = Date.now() < followUntil || seg.barge;
  transcribing = true;
  const reply = await transcribeSegment(seg);
  transcribing = false;
  if (hud.dataset.state === 'listening') setState('idle');
  const next = () => { if (pendingSeg) { const p = pendingSeg; pendingSeg = null; handleSegment(p); } };

  if (reply.error) {
    if (reply.error === 'limite local') { next(); return; }
    if (!isMiss(reply.error)) { pendingSeg = null; notice(reply.error); return; }   // chave, conexão, limite...
    if (!inConversation || seg.barge || pendingSeg) { next(); return; }   // barulho, interrupção sem palavras, ou você já continuou: fica quieto
    misses++;
    if (misses > MAX_MISSES) { misses = 0; followUntil = 0; renderStatus(); return; }
    await speak(['Não entendi, pode repetir?']);
    openFollowUp();
    return;
  }

  const parsed = parseCommand(reply.text);
  if (!parsed.woke && !inConversation) { next(); return; }           // conversa ao redor: não é com o Jarvis
  misses = 0;
  let command = parsed.command;

  // Você fez uma pausa no meio da frase e continuou: junta as duas partes antes de responder.
  if (pendingSeg) {
    const more = pendingSeg;
    pendingSeg = null;
    const r2 = await transcribeSegment(more);
    if (r2.text) command = `${command} ${parseCommand(r2.text).command}`.trim();
  }

  if (!command) {                                // só chamou o nome
    await speak(['Pois não?']);
    openFollowUp();
    return;
  }
  const short = classifyShort(command);
  if (short === 'stop') { openFollowUp(); return; }                 // "para", "chega": fica quieto, ouvindo
  if (short === 'thanks') {
    await speak(['De nada!']);
    openFollowUp();
    return;
  }
  // "pausa", "próxima", "volume 40": direto no Spotify, sem esperar a IA. A música é o retorno; só erros e "que música é essa" falam.
  const media = spotifyOn ? classifyMedia(command) : null;
  if (media) {
    const r = await api.mediaControl(media.action, media.value);
    const said = r.ok ? r.message : r.error;
    if (said) await speak([said]);
    openFollowUp();
    return;
  }
  if (await ask(command)) openFollowUp();
}

mic.onSpeechStart = () => {
  if (hud.dataset.state === 'idle') setState('listening');
};
mic.onBargeIn = interrupt;
mic.onSpeechEnd = (seg) => {
  if (!seg) { if (hud.dataset.state === 'listening') setState('idle'); return; }
  handleSegment(seg);
};

async function startMic() {
  if (mic.running) return true;
  mic.preferred = settings.micLabel;
  mic.bargeIn = settings.bargeIn;
  try {
    await mic.start();
  } catch (err) {
    console.warn('[microfone]', err);
    renderMicButton();
    notice(micErrorMessage(err), { force: true });
    return false;
  }
  mic.setDuck(hud.dataset.state === 'speaking' || hud.dataset.state === 'thinking');
  renderMicButton();
  return true;
}

function stopMic() {
  mic.stop();
  followUntil = 0;
  pendingSeg = null;
  if (hud.dataset.state === 'listening') setState('idle');
  renderMicButton();
}

const toggleMic = () => (mic.running ? stopMic() : startMic());
btnMic.addEventListener('click', toggleMic);

let firstLoad = Promise.resolve();

async function runBriefing() {
  const id = ++speakId;
  abortAsk();
  followUntil = 0;
  voice.stop();
  setState('thinking');
  $('#btn-brief').disabled = true;
  try {
    await Promise.race([firstLoad, sleep(6000)]);
    await Promise.race([loadAgenda(), sleep(3000)]);   // a agenda do resumo tem que ser a de agora, não a de 10 minutos atrás
    if (id !== speakId) return;
    await speak(buildBriefing({
      name: settings.userName,
      nameSpoken: settings.userNameSpoken,
      now: new Date(),
      weather,
      cityName: settings.city.name,
      agenda,
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

function fillSettings() {
  $('#set-rate').value = settings.rate;
  $('#out-rate').textContent = `${settings.rate > 0 ? '+' : ''}${settings.rate}%`;
  $('#set-pitch').value = settings.pitch;
  $('#out-pitch').textContent = `${settings.pitch > 0 ? '+' : ''}${settings.pitch} Hz`;
  $('#set-name').value = settings.userName;
  $('#set-name-spoken').value = settings.userNameSpoken;
  $('#city-current').textContent = `Cidade atual: ${settings.city.name}${settings.city.admin ? `, ${settings.city.admin}` : ''}.`;
  $('#set-autostart').checked = settings.autostart;
  $('#set-speak').checked = settings.speakOnStart;
  $('#set-fullscreen').checked = settings.fullscreen;
  $('#set-delay').value = settings.startDelaySec;
  $('#set-ai-model').value = settings.aiModel;
  $('#set-stt-model').value = settings.sttModel;
  $('#set-mic-compat').checked = settings.micCompat;
  $('#set-listen').checked = settings.listenOnStart;
  $('#set-bargein').checked = settings.bargeIn;
  $('#set-websearch').checked = settings.webSearch;
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

async function refreshGoogleStatus() {
  const s = await api.googleStatus();
  $('#google-status').textContent = s.connected
    ? 'Conectado. O Jarvis lê e cria compromissos e tarefas por voz.'
    : s.needsReconnect
      ? 'O acesso expirou (em modo de teste isso acontece a cada 7 dias). Clique em "Conectar de novo": não precisa colar nada outra vez.'
      : 'Não conectado. Siga os passos abaixo e cole as credenciais para conectar.';
  $('#btn-g-disconnect').hidden = !s.connected && !s.needsReconnect;
  $('#btn-g-connect').textContent = s.connected || s.needsReconnect ? 'Conectar de novo' : 'Conectar com o Google';
  return s;
}

async function refreshSpotifyStatus() {
  const s = await api.spotifyStatus();
  spotifyOn = s.connected;
  $('#spotify-redirect').textContent = s.redirectUri;
  $('#spotify-status').textContent = s.connected
    ? 'Conectado. Peça: "Jarvis, toca Legião Urbana", ou diga "pausa", "próxima", "volume 40".'
    : s.needsReconnect
      ? 'O acesso expirou. Conecte de novo para voltar a usar o Spotify.'
      : 'Não conectado. Siga os passos abaixo e cole o Client ID para conectar.';
  $('#btn-s-disconnect').hidden = !s.connected && !s.needsReconnect;
  $('#btn-s-connect').textContent = s.connected ? 'Conectar de novo' : 'Conectar com o Spotify';
  return s;
}

function openSettings() {
  fillSettings();
  refreshGoogleStatus();
  refreshSpotifyStatus();
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

  $('#set-name').addEventListener('change', (e) => { save({ userName: e.target.value }); });
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
  $('#btn-g-connect').addEventListener('click', async () => {
    const msg = $('#google-msg');
    const btn = $('#btn-g-connect');
    const clientId = $('#set-g-id').value.trim();
    const clientSecret = $('#set-g-secret').value.trim();
    msg.hidden = false;
    const known = (await api.googleStatus()).hasCredentials;   // credenciais já guardadas: reconectar sem colar de novo
    if (!known && (!clientId || !clientSecret)) { msg.textContent = 'Cole o ID e a chave secreta do cliente.'; return; }
    btn.disabled = true;
    msg.textContent = 'Abrindo o navegador para você entrar no Google…';
    const r = await api.googleConnect(clientId || clientSecret ? { clientId, clientSecret } : {});
    btn.disabled = false;
    if (r.ok) {
      msg.textContent = 'Conectado!';
      $('#set-g-id').value = '';
      $('#set-g-secret').value = '';
      loop('agenda', loadAgenda, 10 * 60e3, 2 * 60e3);
    } else {
      msg.textContent = r.error;
    }
    refreshGoogleStatus();
  });
  $('#btn-g-disconnect').addEventListener('click', async () => {
    await api.googleDisconnect();
    $('#google-msg').hidden = true;
    agenda = null;
    renderAgenda();
    refreshGoogleStatus();
  });
  $('#btn-s-connect').addEventListener('click', async () => {
    const msg = $('#spotify-msg');
    const btn = $('#btn-s-connect');
    const clientId = $('#set-s-id').value.trim();
    msg.hidden = false;
    if (!clientId) { msg.textContent = 'Cole o Client ID do seu app do Spotify.'; return; }
    btn.disabled = true;
    msg.textContent = 'Abrindo o navegador para você entrar no Spotify…';
    const r = await api.spotifyConnect({ clientId });
    btn.disabled = false;
    msg.textContent = r.ok ? 'Conectado!' : r.error;
    if (r.ok) $('#set-s-id').value = '';
    refreshSpotifyStatus();
  });
  $('#btn-s-disconnect').addEventListener('click', async () => {
    await api.spotifyDisconnect();
    $('#spotify-msg').hidden = true;
    refreshSpotifyStatus();
  });
  $('#set-websearch').addEventListener('change', (e) => save({ webSearch: e.target.checked }));
  $('#set-bargein').addEventListener('change', (e) => { save({ bargeIn: e.target.checked }); mic.bargeIn = e.target.checked; });
  $('#set-listen').addEventListener('change', (e) => {
    save({ listenOnStart: e.target.checked });
    if (e.target.checked) startMic(); else stopMic();
  });
  $('#set-mic-compat').addEventListener('change', async (e) => {
    await save({ micCompat: e.target.checked });
    $('#compat-restart').hidden = false;
  });
  $('#btn-relaunch').addEventListener('click', () => api.relaunch());
  $('#set-mic').addEventListener('change', (e) => save({ micLabel: e.target.value }));
  let testing = false;
  $('#btn-mic-test').addEventListener('click', async () => {
    if (testing) return;
    testing = true;
    const msg = $('#mic-msg');
    const btn = $('#btn-mic-test');
    const wasOn = mic.running;
    btn.textContent = 'Fale agora…';
    msg.hidden = false;
    msg.textContent = 'Ouvindo por 4 segundos. Diga alguma coisa.';
    let problem = null;
    mic.preferred = settings.micLabel;
    try {
      if (!wasOn) await mic.start();
      mic.resetStats();
      await sleep(4000);
    } catch (err) {
      problem = micErrorMessage(err);
    }
    const s = mic.stats;
    if (!wasOn) mic.stop();
    refreshMicList();
    btn.textContent = 'Testar microfone';
    testing = false;
    if (problem) { msg.textContent = problem; return; }
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
    if (!drawer.hidden) closeSettings();
    else if (hud.dataset.state !== 'idle') stopSpeaking();
    else api.setFullscreen(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleMic();
  } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    drawer.hidden ? openSettings() : closeSettings();
  }
});

tick();
renderAgenda();
refreshSpotifyStatus().catch(() => {});
firstLoad = Promise.all([
  loop('weather', loadWeather, 15 * 60e3, 2 * 60e3),
  loop('agenda', loadAgenda, 10 * 60e3, 2 * 60e3),
]);

// A esfera leva ~2,6 s para montar; o texto aparece junto com o fim da animação.
const assembleMs = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 2600;
setTimeout(() => {
  hud.classList.add('ready');
  if (settings.speakOnStart) runBriefing();
  if (settings.listenOnStart) startMic();
}, assembleMs);
