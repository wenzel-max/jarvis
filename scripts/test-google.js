'use strict';
// Testa oauth.js, secrets.js e google.js sem rede: um "Google" falso local e um navegador simulado.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const secrets = require('../src/secrets');
const oauth = require('../src/oauth');
const google = require('../src/google');

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().replace(/^ENC:/, ''), 'base64').toString(),
};
const CLIENT_ID = 'meu-app-123.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-segredo_do_cliente';

const log = { token: [], revoke: 0, calls: [] };
let challenge = null;      // code_challenge visto na página de login
let fail401Once = false;

const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

async function fakeGoogle(req, res) {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  if (url.pathname === '/token') {
    const f = Object.fromEntries(new URLSearchParams(body));
    log.token.push(f);
    if (f.grant_type === 'authorization_code') {
      assert.strictEqual(f.code, 'CODE1');
      assert.strictEqual(f.client_secret, CLIENT_SECRET);
      const expected = crypto.createHash('sha256').update(f.code_verifier).digest('base64url');
      if (expected !== challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE não confere' });
      return send(res, 200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
    }
    if (f.refresh_token === 'REVOKED') return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    return send(res, 200, { access_token: `AT${log.token.filter((t) => t.grant_type === 'refresh_token').length + 1}`, expires_in: 3600 });
  }
  if (url.pathname === '/revoke') { log.revoke++; return send(res, 200, {}); }
  // APIs
  const auth = req.headers.authorization || '';
  log.calls.push({ method: req.method, path: url.pathname, auth, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null });
  if (fail401Once && auth === 'Bearer AT1') { fail401Once = false; return send(res, 401, { error: { message: 'Invalid Credentials' } }); }
  if (url.pathname.endsWith('/calendars/primary/events') && req.method === 'GET') {
    return send(res, 200, { items: [
      { id: 'a1', summary: 'Reunião com o time', start: { dateTime: '2026-10-05T10:00:00-03:00' }, end: { dateTime: '2026-10-05T11:00:00-03:00' }, location: 'Sala 2' },
      { id: 'a2', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
      { id: 'a3', summary: 'Cancelado', status: 'cancelled', start: { dateTime: '2026-10-05T12:00:00-03:00' } },
    ] });
  }
  if (url.pathname.endsWith('/calendars/primary/events') && req.method === 'POST') {
    const b = JSON.parse(body);
    if (b.summary === 'Sem permissão') return send(res, 403, { error: { message: 'Google Calendar API has not been used in project 123 before or it is disabled.' } });
    return send(res, 200, { id: 'novo1', ...b });
  }
  if (url.pathname.includes('/calendars/primary/events/') && req.method === 'PATCH') return send(res, 200, { id: 'a1', ...JSON.parse(body) });
  if (url.pathname.includes('/calendars/primary/events/') && req.method === 'DELETE') return send(res, url.pathname.endsWith('/nada') ? 404 : 204);
  if (url.pathname.endsWith('/lists/@default/tasks') && req.method === 'GET') return send(res, 200, { items: [{ id: 't1', title: 'Comprar pão', due: '2026-10-05T00:00:00.000Z' }, { id: 't2', title: ' ' }] });
  if (url.pathname.endsWith('/lists/@default/tasks') && req.method === 'POST') return send(res, 200, { id: 't9', ...JSON.parse(body) });
  if (url.pathname.includes('/lists/@default/tasks/') && req.method === 'PATCH') return send(res, 200, { id: 't1', ...JSON.parse(body) });
  send(res, 404, {});
}

/** "Navegador": lê a URL de login, confere os parâmetros e chama o retorno local como o Google faria. */
function browser(mode = 'ok') {
  return async (loginUrl) => {
    const u = new URL(loginUrl);
    const p = Object.fromEntries(u.searchParams);
    assert.strictEqual(p.code_challenge_method, 'S256');
    assert.strictEqual(p.response_type, 'code');
    assert.match(p.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    challenge = p.code_challenge;
    if (mode === 'ok') {
      assert.strictEqual(p.client_id, CLIENT_ID);
      assert.ok(p.scope.includes('calendar.events') && p.scope.includes('auth/tasks'));
      assert.strictEqual(p.access_type, 'offline');
      assert.strictEqual(p.prompt, 'consent');
    }
    const q = mode === 'denied' ? 'error=access_denied' : mode === 'state' ? 'code=CODE1&state=errado' : `code=CODE1&state=${p.state}`;
    setTimeout(() => fetch(`${p.redirect_uri}?${q}`).catch(() => {}), 20);
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-g-'));
  secrets.init(dir, fakeSafe);
  const server = http.createServer(fakeGoogle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoints = { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, calendar: `${base}/calendar/v3`, tasks: `${base}/tasks/v1` };
  const start = (mode) => google.init({ secrets, openBrowser: browser(mode), endpoints });
  const last = () => log.calls.at(-1);

  // cofre
  secrets.set('teste', { a: 1 });
  assert.deepStrictEqual(secrets.get('teste'), { a: 1 });
  assert.ok(!fs.readFileSync(path.join(dir, 'teste.bin')).toString().includes('"a"'), 'o arquivo não pode ter texto puro');
  secrets.remove('teste');
  assert.strictEqual(secrets.get('teste'), null);
  assert.throws(() => secrets.set('../fora', 1), /inválido/);

  // antes de conectar
  start('ok');
  assert.deepStrictEqual(google.status(), { hasCredentials: false, connected: false, needsReconnect: false });
  await assert.rejects(google.listEvents({ timeMin: '2026-10-05T00:00:00', timeMax: '2026-10-06T00:00:00' }), /não está conectado/);
  assert.deepStrictEqual(await google.today(), { connected: false, events: [], tasks: [] });

  // credenciais com cara de erradas nem abrem o navegador
  await assert.rejects(google.connect({ clientId: 'abc', clientSecret: CLIENT_SECRET }), /ID do cliente/);
  await assert.rejects(google.connect({ clientId: CLIENT_ID, clientSecret: '!' }), /chave secreta/);

  // login negado, estado trocado
  start('denied');
  await assert.rejects(google.connect({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), /não autorizou/);
  start('state');
  await assert.rejects(google.connect({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), /não confere/);
  assert.strictEqual(google.status().connected, false);
  // tempo esgotado
  await assert.rejects(oauth.authorize({ authUrl: `${base}/auth`, tokenUrl: endpoints.token, clientId: 'x', scopes: ['a'], openBrowser: async () => {}, timeoutMs: 200 }), /demorou demais/);

  // login de verdade (PKCE conferido pelo servidor)
  start('ok');
  const st = await google.connect({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.deepStrictEqual(st, { hasCredentials: true, connected: true, needsReconnect: false });
  const raw = fs.readFileSync(path.join(dir, 'google.bin')).toString();
  assert.ok(!raw.includes('RT1') && !raw.includes(CLIENT_SECRET), 'tokens e segredo não podem ficar em texto puro');

  // agenda: leitura
  const evs = await google.listEvents({ timeMin: '2026-10-05T00:00:00', timeMax: '2026-10-06T00:00:00' });
  assert.deepStrictEqual(evs.map((e) => [e.title, e.allDay]), [['Reunião com o time', false], ['(sem título)', true]]);
  assert.strictEqual(last().auth, 'Bearer AT1');
  assert.strictEqual(last().query.singleEvents, 'true');
  assert.strictEqual(last().query.orderBy, 'startTime');

  // agenda: criar (com hora, sem fim -> 1 hora; dia inteiro; datas ruins)
  const ev = await google.createEvent({ title: 'Dentista', start: '2026-10-07T15:00:00' });
  assert.strictEqual(last().body.summary, 'Dentista');
  assert.strictEqual(last().body.start.dateTime, '2026-10-07T15:00:00');
  assert.ok(last().body.start.timeZone && last().body.end.dateTime);
  assert.ok(new Date(last().body.end.dateTime) - new Date('2026-10-07T15:00:00') === 3600000, 'duração padrão de 1 hora');
  assert.strictEqual(ev.id, 'novo1');
  await google.createEvent({ title: 'Feriado', start: '2026-10-12', allDay: true });
  assert.deepStrictEqual(last().body.start, { date: '2026-10-12' });
  assert.deepStrictEqual(last().body.end, { date: '2026-10-13' });
  await google.createEvent({ title: 'Viagem', start: '2026-10-20', end: '2026-10-22', allDay: true });
  assert.deepStrictEqual(last().body.end, { date: '2026-10-23' });
  await assert.rejects(google.createEvent({ title: 'X', start: 'amanhã cedo' }), /não é válida/);
  await assert.rejects(google.createEvent({ title: 'X', start: '2026-10-07T15:00:00', end: '2026-10-07T14:00:00' }), /depois do início/);
  await assert.rejects(google.createEvent({ title: ' ', start: '2026-10-07T15:00:00' }), /título/);
  await assert.rejects(google.createEvent({ title: 'Sem permissão', start: '2026-10-07T15:00:00' }), /não está ativada/);

  // agenda: mudar e apagar
  await google.updateEvent('a1', { start: '2026-10-05T16:00:00-03:00', end: '2026-10-05T17:00:00-03:00' });
  assert.strictEqual(last().method, 'PATCH');
  assert.strictEqual(last().body.start.dateTime, '2026-10-05T16:00:00-03:00');
  await google.updateEvent('a1', { title: 'Novo nome' });
  assert.deepStrictEqual(last().body, { summary: 'Novo nome' });
  await google.deleteEvent('a1');
  assert.strictEqual(last().method, 'DELETE');
  await assert.rejects(google.deleteEvent('nada'), /Não encontrei/);

  // tarefas
  assert.deepStrictEqual(await google.listTasks(), [{ id: 't1', title: 'Comprar pão', due: '2026-10-05', notes: '' }]);
  assert.strictEqual(last().query.showCompleted, 'false');
  await google.createTask({ title: 'Pagar a luz', due: '2026-10-10' });
  assert.strictEqual(last().body.due, '2026-10-10T00:00:00.000Z');
  await assert.rejects(google.createTask({ title: 'X', due: 'sexta' }), /não é válida/);
  await google.completeTask('t1');
  assert.deepStrictEqual(last().body, { status: 'completed' });

  // hoje (painel e resumo)
  const hoje = await google.today();
  assert.strictEqual(hoje.connected, true);
  assert.ok(hoje.events.length === 2 && hoje.tasks.length === 1);

  // token vencido -> renova com refresh_token
  const s = secrets.get('google'); secrets.set('google', { ...s, expiresAt: Date.now() - 1000 });
  const before = log.token.length;
  await google.listTasks();
  assert.strictEqual(log.token.length, before + 1);
  assert.strictEqual(log.token.at(-1).grant_type, 'refresh_token');
  assert.strictEqual(last().auth, 'Bearer AT1'.replace('1', String(log.token.filter((t) => t.grant_type === 'refresh_token').length + 1)));
  // renovações simultâneas viram uma só
  secrets.set('google', { ...secrets.get('google'), expiresAt: Date.now() - 1000 });
  const b2 = log.token.length;
  await Promise.all([google.listTasks(), google.listTasks(), google.listTasks()]);
  assert.strictEqual(log.token.length, b2 + 1, 'uma renovação para várias chamadas ao mesmo tempo');

  // 401 no meio do caminho -> renova e repete
  secrets.set('google', { ...secrets.get('google'), accessToken: 'AT1', expiresAt: Date.now() + 3600000 });
  fail401Once = true;
  const b3 = log.token.length;
  await google.listTasks();
  assert.strictEqual(log.token.length, b3 + 1);

  // login revogado -> pede para reconectar, e reconectar conserta
  secrets.set('google', { ...secrets.get('google'), refreshToken: 'REVOKED', expiresAt: Date.now() - 1000 });
  await assert.rejects(google.listTasks(), /expirou. Reconecte/);
  assert.strictEqual(google.status().needsReconnect, true);
  assert.strictEqual(google.status().connected, false);
  assert.match((await google.today()).events.length === 0 ? 'ok' : 'x', /ok/);
  start('ok');
  await google.connect({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.strictEqual(google.status().connected, true);

  // sem internet
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r)); const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
  google.init({ secrets, openBrowser: browser('ok'), endpoints: { ...endpoints, calendar: `http://127.0.0.1:${deadPort}` } });
  await assert.rejects(google.listEvents({ timeMin: '2026-10-05T00:00:00', timeMax: '2026-10-06T00:00:00' }), /Sem conexão/);
  assert.match((await google.today()).error, /Sem conexão/);
  start('ok');

  // desconectar apaga tudo e avisa o Google
  await google.disconnect();
  assert.strictEqual(log.revoke, 1);
  assert.ok(!secrets.has('google'));
  assert.strictEqual(google.status().connected, false);

  server.closeAllConnections();
  server.close();
  console.log('google: todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
