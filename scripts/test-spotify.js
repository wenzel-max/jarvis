'use strict';
// Testa src/spotify.js (e a integração com as ferramentas da IA) com um Spotify falso local.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const secrets = require('../src/secrets');
const spotify = require('../src/spotify');
const { createTools } = require('../src/tools');

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().replace(/^ENC:/, ''), 'base64').toString(),
};
const CLIENT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const calls = [];
const tokenReqs = [];
let challenge = null;
let devices = [{ id: 'D1', name: 'Celular', type: 'Smartphone', is_active: false }, { id: 'D2', name: 'PC da casa', type: 'Computer', is_active: false }];
let player = { device: { volume_percent: 40 } };
let nowItem = null;
let fail = null;   // { status, body } para a próxima chamada de API
let trackVolume = false;   // quando ligado, o player falso guarda o volume que recebe (testes do ducking)

const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

async function fakeSpotify(req, res) {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  if (url.pathname === '/token') {
    const f = Object.fromEntries(new URLSearchParams(body));
    tokenReqs.push(f);
    if (f.grant_type === 'authorization_code') {
      const expected = crypto.createHash('sha256').update(f.code_verifier).digest('base64url');
      if (expected !== challenge) return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, { access_token: 'SA1', refresh_token: 'SR1', expires_in: 3600 });
    }
    if (f.refresh_token === 'REVOKED') return send(res, 400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
    return send(res, 200, { access_token: `SA${tokenReqs.filter((t) => t.grant_type === 'refresh_token').length + 1}`, expires_in: 3600 });   // sem refresh_token novo
  }
  const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null, auth: req.headers.authorization };
  calls.push(rec);
  if (fail) { const f = fail; fail = null; return send(res, f.status, f.body); }
  if (url.pathname === '/v1/search') {
    const t = rec.query.type;
    const items = rec.query.q === 'nada existe' ? [] : [{ uri: `spotify:${t}:X1`, name: t === 'artist' ? 'Legião Urbana' : 'Tempo Perdido', artists: t === 'track' ? [{ name: 'Legião Urbana' }, { name: 'Outro' }, { name: 'Terceiro' }] : undefined }];
    return send(res, 200, { [`${t}s`]: { items } });
  }
  if (url.pathname === '/v1/me/player/devices') return send(res, 200, { devices });
  if (url.pathname === '/v1/me/player' && req.method === 'GET') return send(res, 200, player);
  if (url.pathname === '/v1/me/player/currently-playing') return nowItem ? send(res, 200, nowItem) : send(res, 204);
  if (trackVolume && url.pathname === '/v1/me/player/volume' && player?.device) player.device.volume_percent = Number(rec.query.volume_percent);
  if (['/v1/me/player/play', '/v1/me/player/pause', '/v1/me/player/next', '/v1/me/player/previous', '/v1/me/player/volume'].includes(url.pathname)) return send(res, 204);
  send(res, 404, {});
}

function browser(mode = 'ok') {
  return async (loginUrl) => {
    const p = Object.fromEntries(new URL(loginUrl).searchParams);
    assert.strictEqual(p.code_challenge_method, 'S256');
    assert.strictEqual(p.client_id, CLIENT_ID);
    assert.ok(['user-modify-playback-state', 'user-read-playback-state', 'user-read-currently-playing'].every((s) => p.scope.includes(s)));
    challenge = p.code_challenge;
    const q = mode === 'denied' ? 'error=access_denied' : `code=C1&state=${p.state}`;
    setTimeout(() => fetch(`${p.redirect_uri}?${q}`).catch(() => {}), 20);
  };
}

(async () => {
  assert.strictEqual(spotify.REDIRECT_URI, 'http://127.0.0.1:8898/callback');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-s-'));
  secrets.init(dir, fakeSafe);
  const server = http.createServer(fakeSpotify);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoints = { auth: `${base}/auth`, token: `${base}/token`, api: `${base}/v1` };
  const start = (mode) => spotify.init({ secrets, openBrowser: browser(mode), endpoints, port: 0 });
  const last = () => calls.at(-1);

  // antes de conectar
  start('ok');
  assert.strictEqual(spotify.status().connected, false);
  assert.strictEqual(spotify.status().redirectUri, 'http://127.0.0.1:8898/callback');
  await assert.rejects(spotify.pause(), /não está conectado/);
  await assert.rejects(spotify.connect({ clientId: 'curto' }), /ID do cliente/);
  start('denied');
  await assert.rejects(spotify.connect({ clientId: CLIENT_ID }), /não autorizou/);

  // login (PKCE conferido; nenhuma chave secreta enviada)
  start('ok');
  const st = await spotify.connect({ clientId: CLIENT_ID });
  assert.strictEqual(st.connected, true);
  assert.strictEqual(tokenReqs[0].client_secret, undefined);
  assert.strictEqual(tokenReqs[0].client_id, CLIENT_ID);
  assert.ok(!fs.readFileSync(path.join(dir, 'spotify.bin')).toString().includes('SR1'), 'token cifrado');

  // tocar música: busca -> escolhe o PC (tipo Computer) -> toca nele
  let r = await spotify.play({ query: 'Tempo Perdido Legião Urbana' });
  const search = calls.find((c) => c.path === '/v1/search');
  assert.deepStrictEqual([search.query.type, search.query.limit, search.query.q], ['track', '5', 'Tempo Perdido Legião Urbana']);
  assert.strictEqual(last().method, 'PUT');
  assert.strictEqual(last().path, '/v1/me/player/play');
  assert.strictEqual(last().query.device_id, 'D2');
  assert.deepStrictEqual(last().body, { uris: ['spotify:track:X1'] });
  assert.strictEqual(r.message, 'Tocando Tempo Perdido, de Legião Urbana e Outro');
  assert.strictEqual(last().auth, 'Bearer SA1');

  // artista -> context_uri
  r = await spotify.play({ query: 'Legião Urbana', kind: 'artista' });
  assert.deepStrictEqual(last().body, { context_uri: 'spotify:artist:X1' });
  assert.strictEqual(r.message, 'Tocando Legião Urbana');

  // não achou
  r = await spotify.play({ query: 'nada existe' });
  assert.strictEqual(r.played, false);
  assert.match(r.message, /Não achei "nada existe"/);
  await assert.rejects(spotify.play({ query: '  ' }), /o que tocar/);

  // escolha do dispositivo: ativo > Computer > primeiro
  devices = [{ id: 'D1', type: 'Smartphone', is_active: true }, { id: 'D2', type: 'Computer', is_active: false }];
  assert.strictEqual((await spotify.pickDevice()).id, 'D1');
  devices = [{ id: 'D1', type: 'Smartphone', is_active: false }, { id: 'D3', type: 'Speaker', is_active: false }];
  assert.strictEqual((await spotify.pickDevice()).id, 'D1');
  devices = [];
  await assert.rejects(spotify.play({ query: 'x' }), /Abra o aplicativo do Spotify/);
  devices = [{ id: 'D2', type: 'Computer', is_active: false }];

  // controles
  await spotify.control('pause');
  assert.deepStrictEqual([last().method, last().path], ['PUT', '/v1/me/player/pause']);
  await spotify.control('resume');
  assert.deepStrictEqual([last().method, last().path, last().query.device_id, last().body], ['PUT', '/v1/me/player/play', 'D2', null]);
  await spotify.control('next');
  assert.deepStrictEqual([last().method, last().path], ['POST', '/v1/me/player/next']);
  await spotify.control('previous');
  assert.deepStrictEqual([last().method, last().path], ['POST', '/v1/me/player/previous']);
  await spotify.control('volume', 55);
  assert.deepStrictEqual([last().path, last().query.volume_percent], ['/v1/me/player/volume', '55']);
  await spotify.control('volume', 250);
  assert.strictEqual(last().query.volume_percent, '100');
  await spotify.control('volume', -9);
  assert.strictEqual(last().query.volume_percent, '0');
  await assert.rejects(spotify.control('volume', 'alto'), /número de 0 a 100/);
  await spotify.control('louder');          // 40 + 15
  assert.strictEqual(last().query.volume_percent, '55');
  player = { device: { volume_percent: 95 } };
  await spotify.control('louder');
  assert.strictEqual(last().query.volume_percent, '100');
  player = { device: { volume_percent: 10 } };
  await spotify.control('quieter');
  assert.strictEqual(last().query.volume_percent, '0');
  await assert.rejects(spotify.control('dançar'), /desconhecido/);

  // o que está tocando
  assert.strictEqual(await spotify.control('now'), 'Não tem nada tocando agora.');
  nowItem = { is_playing: true, item: { name: 'Pais e Filhos', artists: [{ name: 'Legião Urbana' }] } };
  assert.strictEqual(await spotify.control('now'), 'Está tocando: Pais e Filhos, de Legião Urbana.');
  nowItem = { is_playing: false, item: { name: 'Pais e Filhos', artists: [] } };
  assert.strictEqual(await spotify.control('now'), 'Pausado: Pais e Filhos.');

  // erros reais do Spotify viram frases em português
  fail = { status: 403, body: { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } } };
  await assert.rejects(spotify.pause(), /Premium ativa/);
  fail = { status: 403, body: { error: { status: 403, message: 'User not registered in the Developer Dashboard' } } };
  await assert.rejects(spotify.pause(), /Gerenciar usuários/);
  fail = { status: 404, body: { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } } };
  await assert.rejects(spotify.pause(), /Abra o aplicativo do Spotify/);
  fail = { status: 403, body: { error: { status: 403, message: 'Cannot control device volume', reason: 'VOLUME_CONTROL_DISALLOW' } } };
  await assert.rejects(spotify.setVolume(30), /não aceita mudar o volume/);
  fail = { status: 429, body: {} };
  await assert.rejects(spotify.pause(), /limitou/);
  fail = { status: 500, body: { error: { message: 'Server error' } } };
  await assert.rejects(spotify.pause(), /erro 500/);

  // token vencido -> renova (o Spotify não manda refresh_token novo: o antigo é mantido)
  secrets.set('spotify', { ...secrets.get('spotify'), expiresAt: Date.now() - 1000 });
  const before = tokenReqs.length;
  await spotify.pause();
  assert.strictEqual(tokenReqs.length, before + 1);
  assert.strictEqual(tokenReqs.at(-1).grant_type, 'refresh_token');
  assert.strictEqual(secrets.get('spotify').refreshToken, 'SR1');
  // 401 -> renova e repete
  fail = { status: 401, body: { error: { message: 'The access token expired' } } };
  const b2 = tokenReqs.length;
  await spotify.pause();
  assert.strictEqual(tokenReqs.length, b2 + 1);

  // ---- abaixar a música enquanto o Jarvis fala ----
  trackVolume = true;
  const vols = () => calls.filter((c) => c.path === '/v1/me/player/volume').map((c) => c.query.volume_percent);
  const mark = () => calls.length;
  const volsSince = (n) => calls.slice(n).filter((c) => c.path === '/v1/me/player/volume').map((c) => c.query.volume_percent);
  player = { is_playing: true, device: { id: 'D2', volume_percent: 60 } };
  let n0 = mark();
  assert.strictEqual(await spotify.duck(), true);
  assert.deepStrictEqual(volsSince(n0), ['18'], '60 -> 30%');
  assert.strictEqual(calls.at(-1).query.device_id, 'D2');
  n0 = mark();
  assert.strictEqual(await spotify.duck(), false, 'já está baixo: não abaixa de novo');
  assert.deepStrictEqual(volsSince(n0), []);
  assert.ok(secrets.has('spotify-duck'), 'guardado para sobreviver a uma queda');
  assert.strictEqual(await spotify.unduck(), true);
  assert.strictEqual(player.device.volume_percent, 60, 'voltou ao volume de antes');
  assert.ok(!secrets.has('spotify-duck'));
  assert.strictEqual(await spotify.unduck(), false, 'sem nada abaixado, não faz nada');

  // você mexeu no volume enquanto ele falava: não desfaz
  await spotify.duck();
  player.device.volume_percent = 45;
  n0 = mark();
  assert.strictEqual(await spotify.unduck(), false);
  assert.deepStrictEqual(volsSince(n0), []);
  assert.strictEqual(player.device.volume_percent, 45);

  // música parada ou volume já muito baixo: não mexe
  player = { is_playing: false, device: { id: 'D2', volume_percent: 60 } };
  n0 = mark();
  assert.strictEqual(await spotify.duck(), false);
  player = { is_playing: true, device: { id: 'D2', volume_percent: 10 } };
  assert.strictEqual(await spotify.duck(), false);
  assert.deepStrictEqual(volsSince(n0), []);
  player = null;
  assert.strictEqual(await spotify.duck(), false, 'sem player ativo');
  player = { device: { volume_percent: 40 } };

  // abaixar e restaurar "ao mesmo tempo" não se atropelam: as chamadas rodam em fila
  player = { is_playing: true, device: { id: 'D2', volume_percent: 80 } };
  const both = await Promise.all([spotify.duck(), spotify.unduck(), spotify.duck(), spotify.unduck()]);
  assert.deepStrictEqual(both, [true, true, true, true]);
  assert.strictEqual(player.device.volume_percent, 80);

  // o app caiu no meio de uma fala: ao iniciar, restaura (só se foi há pouco)
  player = { is_playing: true, device: { id: 'D2', volume_percent: 12 } };
  secrets.set('spotify-duck', { from: 70, to: 12, device: 'D2', at: Date.now() - 60000 });
  assert.strictEqual(await spotify.restoreAfterCrash(), true);
  assert.strictEqual(player.device.volume_percent, 70);
  secrets.set('spotify-duck', { from: 70, to: 12, device: 'D2', at: Date.now() - 3600000 });
  player = { is_playing: true, device: { id: 'D2', volume_percent: 12 } };
  assert.strictEqual(await spotify.restoreAfterCrash(), false);
  assert.strictEqual(player.device.volume_percent, 12, 'foi há muito tempo: provavelmente você escolheu esse volume');
  assert.ok(!secrets.has('spotify-duck'));
  assert.strictEqual(await spotify.control('duck'), '');
  await spotify.control('unduck');
  trackVolume = false;
  player = { device: { volume_percent: 40 } };

  // integração com as ferramentas da IA
  const tools = createTools({
    google: {}, web: null, spotify: { definitions: spotify.definitions, handlers: spotify.handlers },
    isGoogleConnected: () => false, isSpotifyConnected: () => spotify.status().connected, settings: () => ({ webSearch: false }),
  });
  assert.deepStrictEqual(tools.definitions().map((d) => d.function.name), ['spotify_tocar', 'spotify_controlar']);
  assert.match(tools.capabilities().join(' '), /Spotify/);
  assert.strictEqual(await tools.run('spotify_tocar', { busca: 'Legião Urbana', tipo: 'artista' }), 'Tocando Legião Urbana');
  assert.strictEqual(await tools.run('spotify_controlar', { acao: 'volume', volume: 30 }), 'Feito.');
  assert.strictEqual(last().query.volume_percent, '30');
  assert.strictEqual(await tools.run('spotify_controlar', { acao: 'o_que_toca' }), 'Pausado: Pais e Filhos.');
  assert.match(await tools.run('spotify_controlar', { acao: 'dançar' }), /Não entendi/);
  devices = [];
  assert.match(await tools.run('spotify_tocar', { busca: 'x' }), /Não deu certo: Não encontrei o Spotify aberto/);

  // login revogado -> pede para reconectar
  secrets.set('spotify', { ...secrets.get('spotify'), refreshToken: 'REVOKED', expiresAt: Date.now() - 1000 });
  await assert.rejects(spotify.pause(), /expirou. Reconecte/);
  assert.strictEqual(spotify.status().needsReconnect, true);
  assert.deepStrictEqual(tools.definitions(), [], 'sem conexão, o Spotify some das ferramentas');
  start('ok');
  await spotify.connect({ clientId: CLIENT_ID });
  assert.strictEqual(spotify.status().connected, true);
  await spotify.disconnect();
  assert.ok(!secrets.has('spotify'));

  server.closeAllConnections();
  server.close();
  console.log('spotify: todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
