'use strict';
// Spotify: controla o app do Spotify do computador pela Web API (precisa de Premium e do app aberto).
// Login OAuth com PKCE pelo navegador do sistema; o token fica cifrado no cofre. Tudo no processo principal.

const oauth = require('./oauth');

const ENDPOINTS = {
  auth: 'https://accounts.spotify.com/authorize',
  token: 'https://accounts.spotify.com/api/token',
  api: 'https://api.spotify.com/v1',
};
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing'];
const SECRET = 'spotify';
// O Spotify só aceita o retorno em 127.0.0.1 com a porta exatamente igual à registrada no painel do app.
const REDIRECT_PORT = 8898;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

const NOT_CONNECTED = 'O Spotify não está conectado. Conecte em Ajustes, na seção Spotify.';
const EXPIRED = 'O acesso ao Spotify expirou. Reconecte em Ajustes, na seção Spotify.';
const NO_DEVICE = 'Não encontrei o Spotify aberto. Abra o aplicativo do Spotify no computador e tente de novo.';

class SpotifyError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let secrets = null;
let openBrowser = null;
let endpoints = ENDPOINTS;
let port = REDIRECT_PORT;
let refreshing = null;

/** `endpoints` e `port` existem só para testes. */
function init(opts) {
  secrets = opts.secrets;
  openBrowser = opts.openBrowser;
  endpoints = { ...ENDPOINTS, ...opts.endpoints };
  port = opts.port ?? REDIRECT_PORT;
}

const saved = () => secrets.get(SECRET);

function status() {
  const s = saved();
  return {
    hasCredentials: !!s?.clientId,
    connected: !!s?.refreshToken && !s.needsReconnect,
    needsReconnect: !!s?.needsReconnect,
    redirectUri: REDIRECT_URI,
  };
}

async function connect({ clientId } = {}) {
  if (!/^[a-f0-9]{32}$/i.test(clientId ?? '')) {
    throw new SpotifyError('O ID do cliente parece errado. Ele tem 32 letras e números, na página do seu app em developer.spotify.com.', 'bad_client');
  }
  let tokens;
  try {
    tokens = await oauth.authorize({
      authUrl: endpoints.auth, tokenUrl: endpoints.token, clientId, scopes: SCOPES, port, openBrowser,
    });
  } catch (e) {
    throw new SpotifyError(e.message, e.code);
  }
  if (!tokens.refreshToken) throw new SpotifyError('O Spotify não entregou permissão duradoura. Tente conectar de novo.', 'no_refresh');
  secrets.set(SECRET, { clientId, ...tokens });
  return status();
}

async function disconnect() {
  secrets.remove(SECRET);
  return status();
}

async function renew(s) {
  refreshing ??= (async () => {
    try {
      const t = await oauth.refresh({ tokenUrl: endpoints.token, clientId: s.clientId, refreshToken: s.refreshToken });
      secrets.set(SECRET, { ...s, ...t });
      return t.accessToken;
    } catch (e) {
      if (e.code === 'invalid_grant') {
        secrets.set(SECRET, { ...s, accessToken: null, needsReconnect: true });
        throw new SpotifyError(EXPIRED, 'expired');
      }
      throw new SpotifyError(e.code === 'network' ? e.message : 'Não consegui renovar o acesso ao Spotify.', 'refresh');
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function accessToken({ force = false } = {}) {
  const s = saved();
  if (!s?.refreshToken) throw new SpotifyError(NOT_CONNECTED, 'not_connected');
  if (s.needsReconnect) throw new SpotifyError(EXPIRED, 'expired');
  if (!force && s.accessToken && s.expiresAt - Date.now() > 60000) return s.accessToken;
  return renew(s);
}

async function httpError(res) {
  let reason = '';
  let message = '';
  try {
    const j = await res.json();
    reason = j.error?.reason ?? '';
    message = j.error?.message ?? '';
  } catch { /* sem corpo */ }
  if (res.status === 404 && (reason === 'NO_ACTIVE_DEVICE' || /device/i.test(message))) return new SpotifyError(NO_DEVICE, 'no_device');
  if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(message)) {
    return new SpotifyError('O Spotify só deixa controlar a música com uma conta Premium ativa (a do dono do app também).', 'premium');
  }
  if (res.status === 403 && reason === 'VOLUME_CONTROL_DISALLOW') return new SpotifyError('Esse dispositivo não aceita mudar o volume por aqui.', 'volume');
  if (res.status === 403) {
    return new SpotifyError('O Spotify negou o acesso. No painel do seu app, em Gerenciar usuários, adicione o e-mail da sua conta, e confira se a assinatura Premium está ativa.', 'forbidden');
  }
  if (res.status === 429) return new SpotifyError('O Spotify limitou as consultas por agora. Tente de novo em instantes.', 'rate');
  return new SpotifyError(`O Spotify respondeu com erro ${res.status}${message ? `: ${message}` : ''}.`, 'http');
}

async function api(method, pathname, { query, body } = {}) {
  const url = new URL(endpoints.api + pathname);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
  const call = (token) => fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  let res;
  try {
    res = await call(await accessToken());
    if (res.status === 401) res = await call(await accessToken({ force: true }));
  } catch (e) {
    if (e instanceof SpotifyError) throw e;
    throw new SpotifyError('Sem conexão com o Spotify. Verifique a internet.', 'network');
  }
  if (!res.ok) throw await httpError(res);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- dispositivos ----------
/** O app do Spotify do PC: o que está ativo, senão o do tipo Computer, senão o primeiro. */
async function pickDevice() {
  const j = await api('GET', '/me/player/devices');
  const list = j?.devices ?? [];
  if (!list.length) throw new SpotifyError(NO_DEVICE, 'no_device');
  return list.find((d) => d.is_active) ?? list.find((d) => d.type === 'Computer') ?? list[0];
}

// ---------- busca e reprodução ----------
const KINDS = { musica: 'track', artista: 'artist', album: 'album', playlist: 'playlist' };

/** Acha o melhor resultado para o que foi pedido. */
async function find(query, kind = 'musica') {
  const type = KINDS[kind] ?? 'track';
  const j = await api('GET', '/search', { query: { q: String(query).slice(0, 200), type, limit: '5' } });
  const item = j?.[`${type}s`]?.items?.find(Boolean);
  if (!item) return null;
  const by = (item.artists ?? []).map((a) => a.name).slice(0, 2).join(' e ');
  return {
    type,
    uri: item.uri,
    name: item.name,
    by,
    label: by ? `${item.name}, de ${by}` : item.name,
  };
}

async function play({ query, kind = 'musica' }) {
  const q = String(query ?? '').trim();
  if (!q) throw new SpotifyError('Faltou dizer o que tocar.', 'bad_args');
  const found = await find(q, kind);
  if (!found) return { played: false, message: `Não achei "${q}" no Spotify.` };
  const device = await pickDevice();
  const body = found.type === 'track' ? { uris: [found.uri] } : { context_uri: found.uri };
  await api('PUT', '/me/player/play', { query: { device_id: device.id }, body });
  return { played: true, message: `Tocando ${found.label}`, found };
}

async function pause() {
  await api('PUT', '/me/player/pause');
}

async function resume() {
  const device = await pickDevice();
  await api('PUT', '/me/player/play', { query: { device_id: device.id } });
}

async function next() {
  await api('POST', '/me/player/next');
}

async function previous() {
  await api('POST', '/me/player/previous');
}

const clampVolume = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));

async function setVolume(percent) {
  const v = clampVolume(percent);
  if (!Number.isFinite(v)) throw new SpotifyError('O volume precisa ser um número de 0 a 100.', 'bad_args');
  await api('PUT', '/me/player/volume', { query: { volume_percent: String(v) } });
  return v;
}

/** Muda o volume em relação ao atual. */
async function changeVolume(delta) {
  const state = await api('GET', '/me/player');
  const now = state?.device?.volume_percent;
  if (now == null) throw new SpotifyError(NO_DEVICE, 'no_device');
  return setVolume(now + delta);
}

async function nowPlaying() {
  const j = await api('GET', '/me/player/currently-playing');
  if (!j?.item) return null;
  return { playing: !!j.is_playing, name: j.item.name, by: (j.item.artists ?? []).map((a) => a.name).slice(0, 2).join(' e ') };
}

/** Comandos curtos, sem passar pela IA ("pausa", "próxima", "volume 40"). Devolve uma frase só se houver algo a dizer. */
async function control(action, value) {
  switch (action) {
    case 'pause': await pause(); return '';
    case 'resume': await resume(); return '';
    case 'next': await next(); return '';
    case 'previous': await previous(); return '';
    case 'volume': await setVolume(value); return '';
    case 'louder': await changeVolume(+15); return '';
    case 'quieter': await changeVolume(-15); return '';
    case 'now': {
      const n = await nowPlaying();
      return n ? `${n.playing ? 'Está tocando' : 'Pausado'}: ${n.name}${n.by ? `, de ${n.by}` : ''}.` : 'Não tem nada tocando agora.';
    }
    default: throw new SpotifyError('Comando de música desconhecido.', 'bad_args');
  }
}

// ---------- ferramentas da IA ----------
const definitions = {
  spotify_tocar: {
    description: 'Toca música no Spotify do computador: uma música, um artista, um álbum ou uma playlist.',
    parameters: { type: 'object', properties: {
      busca: { type: 'string', description: 'O que tocar, ex.: "Legião Urbana", "Tempo Perdido Legião Urbana", "playlist de treino".' },
      tipo: { type: 'string', enum: ['musica', 'artista', 'album', 'playlist'], description: 'O que a busca representa. Padrão: musica.' },
    }, required: ['busca'] },
  },
  spotify_controlar: {
    description: 'Controla o que está tocando no Spotify: pausar, continuar, próxima, anterior, volume, ou dizer o que está tocando.',
    parameters: { type: 'object', properties: {
      acao: { type: 'string', enum: ['pausar', 'continuar', 'proxima', 'anterior', 'volume', 'mais_alto', 'mais_baixo', 'o_que_toca'] },
      volume: { type: 'number', description: 'De 0 a 100, só para a ação volume.' },
    }, required: ['acao'] },
  },
};

const ACTIONS = { pausar: 'pause', continuar: 'resume', proxima: 'next', anterior: 'previous', volume: 'volume', mais_alto: 'louder', mais_baixo: 'quieter', o_que_toca: 'now' };

const handlers = {
  async spotify_tocar({ busca, tipo }) {
    return (await play({ query: busca, kind: tipo })).message;
  },
  async spotify_controlar({ acao, volume }) {
    const action = ACTIONS[acao];
    if (!action) return 'Não entendi o comando de música.';
    const said = await control(action, volume);
    return said || 'Feito.';
  },
};

module.exports = {
  init, status, connect, disconnect, SpotifyError, REDIRECT_URI, REDIRECT_PORT,
  find, play, pause, resume, next, previous, setVolume, changeVolume, nowPlaying, control, pickDevice,
  definitions, handlers,
};
