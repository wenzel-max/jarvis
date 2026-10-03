'use strict';
// Google Agenda e Google Tarefas. Login OAuth (PKCE) pelo navegador do sistema; tokens cifrados no cofre.
// Todas as chamadas saem do processo principal (o renderer não faz rede).

const oauth = require('./oauth');

const ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  calendar: 'https://www.googleapis.com/calendar/v3',
  tasks: 'https://tasks.googleapis.com/tasks/v1',
};
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/tasks'];
const SECRET = 'google';

const NOT_CONNECTED = 'O Google não está conectado. Conecte em Ajustes, na seção Google Agenda e Tarefas.';
const EXPIRED = 'O acesso ao Google expirou. Reconecte em Ajustes, na seção Google Agenda e Tarefas.';

class GoogleError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let secrets = null;
let openBrowser = null;
let endpoints = ENDPOINTS;
let refreshing = null;   // uma renovação por vez

/** `endpoints` existe só para testes. */
function init(opts) {
  secrets = opts.secrets;
  openBrowser = opts.openBrowser;
  endpoints = { ...ENDPOINTS, ...opts.endpoints };
}

const saved = () => secrets.get(SECRET);

function status() {
  const s = saved();
  return {
    hasCredentials: !!s?.clientId,
    connected: !!s?.refreshToken && !s.needsReconnect,
    needsReconnect: !!s?.needsReconnect,
  };
}

async function connect({ clientId, clientSecret } = {}) {
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId ?? '')) {
    throw new GoogleError('O ID do cliente parece errado. Ele termina com .apps.googleusercontent.com.', 'bad_client');
  }
  if (!/^[\w-]{10,120}$/.test(clientSecret ?? '')) {
    throw new GoogleError('A chave secreta do cliente parece errada. Copie de novo do Google Cloud.', 'bad_client');
  }
  let tokens;
  try {
    tokens = await oauth.authorize({
      authUrl: endpoints.auth, tokenUrl: endpoints.token, clientId, clientSecret, scopes: SCOPES,
      extraParams: { access_type: 'offline', prompt: 'consent' }, openBrowser,
    });
  } catch (e) {
    throw new GoogleError(e.message, e.code);
  }
  if (!tokens.refreshToken) {
    throw new GoogleError('O Google não entregou permissão duradoura. Tente conectar de novo e aceite todos os acessos.', 'no_refresh');
  }
  secrets.set(SECRET, { clientId, clientSecret, ...tokens });
  return status();
}

async function disconnect() {
  const s = saved();
  if (s?.refreshToken) {
    try {   // melhor esforço: avisa o Google que este acesso deve ser encerrado
      await fetch(endpoints.revoke, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: s.refreshToken }), signal: AbortSignal.timeout(8000),
      });
    } catch { /* sem internet: o acesso é apagado aqui mesmo assim */ }
  }
  secrets.remove(SECRET);
  return status();
}

async function renew(s) {
  refreshing ??= (async () => {
    try {
      const t = await oauth.refresh({ tokenUrl: endpoints.token, clientId: s.clientId, clientSecret: s.clientSecret, refreshToken: s.refreshToken });
      secrets.set(SECRET, { ...s, ...t });
      return t.accessToken;
    } catch (e) {
      if (e.code === 'invalid_grant') {
        secrets.set(SECRET, { ...s, accessToken: null, needsReconnect: true });
        throw new GoogleError(EXPIRED, 'expired');
      }
      throw new GoogleError(e.code === 'network' ? e.message : 'Não consegui renovar o acesso ao Google.', 'refresh');
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function accessToken({ force = false } = {}) {
  const s = saved();
  if (!s?.refreshToken) throw new GoogleError(NOT_CONNECTED, 'not_connected');
  if (s.needsReconnect) throw new GoogleError(EXPIRED, 'expired');
  if (!force && s.accessToken && s.expiresAt - Date.now() > 60000) return s.accessToken;
  return renew(s);
}

async function httpError(res) {
  let detail = '';
  try { detail = (await res.json()).error?.message ?? ''; } catch { /* sem corpo */ }
  if (res.status === 403 && /has not been used|disabled|accessNotConfigured/i.test(detail)) {
    return new GoogleError('A API do Google Agenda ou Tarefas não está ativada no seu projeto do Google Cloud. Ative as duas e tente de novo.', 'api_disabled');
  }
  if (res.status === 403) return new GoogleError('O Google negou o acesso. Reconecte em Ajustes e aceite todas as permissões.', 'forbidden');
  if (res.status === 404 || res.status === 410) return new GoogleError('Não encontrei esse item na agenda.', 'not_found');
  if (res.status === 429) return new GoogleError('O Google limitou as consultas por agora. Tente de novo em instantes.', 'rate');
  return new GoogleError(`O Google respondeu com erro ${res.status}${detail ? `: ${detail}` : ''}.`, 'http');
}

async function api(method, base, pathname, { query, body } = {}) {
  const url = new URL(base + pathname);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const call = (token) => fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let res;
  try {
    res = await call(await accessToken());
    if (res.status === 401) res = await call(await accessToken({ force: true }));
  } catch (e) {
    if (e instanceof GoogleError) throw e;
    throw new GoogleError('Sem conexão com o Google. Verifique a internet.', 'network');
  }
  if (!res.ok) throw await httpError(res);
  return res.status === 204 ? null : res.json();
}

// ---------- Agenda ----------
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const hasOffset = (s) => /(Z|[+-]\d\d:?\d\d)$/.test(s);
const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

const toEvent = (e) => ({
  id: e.id,
  title: e.summary || '(sem título)',
  start: e.start?.dateTime || e.start?.date,
  end: e.end?.dateTime || e.end?.date,
  allDay: !!e.start?.date,
  location: e.location || '',
});

function parseWhen(value, label) {
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) {
    throw new GoogleError(`A data de ${label} não é válida. Use o formato 2026-10-05T14:30:00.`, 'bad_date');
  }
  return d;
}

/** Monta start/end do Google a partir de textos ISO. Dia inteiro usa só a data (o fim é exclusivo). */
function when({ start, end, allDay }) {
  if (allDay || isDateOnly(start)) {
    const first = start.slice(0, 10);
    const last = end && isDateOnly(end.slice(0, 10)) ? end.slice(0, 10) : first;
    const exclusive = new Date(`${last}T00:00:00Z`);
    exclusive.setUTCDate(exclusive.getUTCDate() + 1);
    return { start: { date: first }, end: { date: exclusive.toISOString().slice(0, 10) } };
  }
  const s = parseWhen(start, 'início');
  const e = end ? parseWhen(end, 'fim') : new Date(s.getTime() + 3600000);
  if (e <= s) throw new GoogleError('O fim do compromisso precisa ser depois do início.', 'bad_date');
  const fmt = (raw, d) => ({ dateTime: raw && hasOffset(raw) ? raw : (raw ?? d.toISOString()), timeZone: timeZone() });
  return { start: fmt(start, s), end: fmt(end, e) };
}

async function listEvents({ timeMin, timeMax, max = 15 } = {}) {
  const j = await api('GET', endpoints.calendar, '/calendars/primary/events', {
    query: {
      timeMin: parseWhen(timeMin, 'início').toISOString(), timeMax: parseWhen(timeMax, 'fim').toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(50, max)), timeZone: timeZone(),
    },
  });
  return (j.items ?? []).filter((e) => e.status !== 'cancelled').map(toEvent);
}

async function createEvent({ title, start, end, allDay, description, location } = {}) {
  if (!title?.trim()) throw new GoogleError('Faltou o título do compromisso.', 'bad_args');
  const body = { summary: title.trim().slice(0, 200), ...when({ start, end, allDay }) };
  if (description) body.description = String(description).slice(0, 1000);
  if (location) body.location = String(location).slice(0, 200);
  return toEvent(await api('POST', endpoints.calendar, '/calendars/primary/events', { body }));
}

async function updateEvent(id, { title, start, end, allDay, description, location } = {}) {
  if (!id) throw new GoogleError('Faltou o identificador do compromisso.', 'bad_args');
  const body = {};
  if (title) body.summary = String(title).trim().slice(0, 200);
  if (description !== undefined) body.description = String(description).slice(0, 1000);
  if (location !== undefined) body.location = String(location).slice(0, 200);
  if (start) Object.assign(body, when({ start, end, allDay }));
  return toEvent(await api('PATCH', endpoints.calendar, `/calendars/primary/events/${encodeURIComponent(id)}`, { body }));
}

async function deleteEvent(id) {
  if (!id) throw new GoogleError('Faltou o identificador do compromisso.', 'bad_args');
  await api('DELETE', endpoints.calendar, `/calendars/primary/events/${encodeURIComponent(id)}`);
}

// ---------- Tarefas ----------
const toTask = (t) => ({ id: t.id, title: t.title || '(sem título)', due: t.due ? t.due.slice(0, 10) : '', notes: t.notes || '' });

async function listTasks({ max = 30 } = {}) {
  const j = await api('GET', endpoints.tasks, '/lists/@default/tasks', {
    query: { showCompleted: 'false', showHidden: 'false', maxResults: String(Math.min(100, max)) },
  });
  return (j.items ?? []).filter((t) => t.title?.trim()).map(toTask);
}

async function createTask({ title, due, notes } = {}) {
  if (!title?.trim()) throw new GoogleError('Faltou o título da tarefa.', 'bad_args');
  const body = { title: title.trim().slice(0, 200) };
  if (notes) body.notes = String(notes).slice(0, 1000);
  if (due) {
    if (!isDateOnly(String(due).slice(0, 10))) throw new GoogleError('A data da tarefa não é válida. Use 2026-10-05.', 'bad_date');
    body.due = `${String(due).slice(0, 10)}T00:00:00.000Z`;
  }
  return toTask(await api('POST', endpoints.tasks, '/lists/@default/tasks', { body }));
}

async function completeTask(id) {
  if (!id) throw new GoogleError('Faltou o identificador da tarefa.', 'bad_args');
  await api('PATCH', endpoints.tasks, `/lists/@default/tasks/${encodeURIComponent(id)}`, { body: { status: 'completed' } });
}

/** O dia de hoje (no fuso do PC) para o painel e o resumo falado. Nunca lança. */
async function today() {
  if (!status().connected) return { connected: false, events: [], tasks: [] };
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  try {
    const [events, tasks] = await Promise.all([
      listEvents({ timeMin: start.toISOString(), timeMax: end.toISOString(), max: 20 }),
      listTasks({ max: 20 }),
    ]);
    return { connected: true, events, tasks };
  } catch (e) {
    return { connected: true, error: e.message, events: [], tasks: [] };
  }
}

module.exports = {
  init, status, connect, disconnect, today, GoogleError,
  listEvents, createEvent, updateEvent, deleteEvent, listTasks, createTask, completeTask,
};
