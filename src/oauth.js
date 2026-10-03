'use strict';
// Login OAuth 2.0 para app de desktop: abre o navegador do sistema, recebe o retorno numa porta local
// (127.0.0.1) e troca o código por tokens com PKCE. Serve para o Google e para o Spotify.

const http = require('node:http');
const crypto = require('node:crypto');

class OAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

const page = (title, text) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Jarvis</title>
<body style="font-family:system-ui,sans-serif;background:#090604;color:#f3e8d2;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;padding:24px"><h1 style="color:#ffd27a;font-weight:500">${title}</h1><p style="color:#a09076">${text}</p></div></body></html>`;

async function postForm(url, params, signal) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new OAuthError('Sem conexão para falar com o serviço de login. Verifique a internet.', 'network');
  }
  let json = {};
  try { json = await res.json(); } catch { /* corpo vazio */ }
  if (!res.ok) throw new OAuthError(json.error_description || json.error || `HTTP ${res.status}`, json.error || String(res.status));
  return json;
}

const normalize = (j, previousRefresh) => ({
  accessToken: j.access_token,
  refreshToken: j.refresh_token || previousRefresh,
  expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
});

/**
 * Faz o login completo. `openBrowser(url)` abre a página de login.
 * `port` 0 = qualquer porta livre (Google); o Spotify exige a porta registrada no painel.
 */
async function authorize({ authUrl, tokenUrl, clientId, clientSecret, scopes, port = 0, extraParams = {}, openBrowser, timeoutMs = 180000, signal }) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(sha256(verifier));
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new OAuthError(e.code === 'EADDRINUSE'
      ? `A porta ${port} do login está ocupada. Feche outro programa que a use e tente de novo.` : e.message, e.code)));
    server.listen(port, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

  let timer;
  const got = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new OAuthError('O login demorou demais e foi cancelado. Tente conectar de novo.', 'timeout')), timeoutMs);
    signal?.addEventListener('abort', () => reject(new OAuthError('Login cancelado.', 'aborted')));
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const error = u.searchParams.get('error');
      const bad = error || u.searchParams.get('state') !== state || !u.searchParams.get('code');
      res.writeHead(bad ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(bad ? page('Não deu certo', 'Volte ao Jarvis e tente conectar de novo.') : page('Pronto!', 'Pode fechar esta janela e voltar ao Jarvis.'));
      if (error) reject(new OAuthError(error === 'access_denied' ? 'Você não autorizou o acesso.' : `O login foi recusado (${error}).`, error));
      else if (bad) reject(new OAuthError('A resposta do login não confere. Tente conectar de novo.', 'state'));
      else resolve(u.searchParams.get('code'));
    });
  });

  try {
    const url = new URL(authUrl);
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
      state, code_challenge: challenge, code_challenge_method: 'S256', ...extraParams,
    }).toString();
    await openBrowser(url.toString());
    const code = await got;
    const body = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier };
    if (clientSecret) body.client_secret = clientSecret;
    return normalize(await postForm(tokenUrl, body, signal));
  } finally {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close();
  }
}

/** Renova o access token. Se o login foi revogado ou expirou, lança OAuthError com code 'invalid_grant'. */
async function refresh({ tokenUrl, clientId, clientSecret, refreshToken, signal }) {
  const body = { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId };
  if (clientSecret) body.client_secret = clientSecret;
  return normalize(await postForm(tokenUrl, body, signal), refreshToken);
}

module.exports = { authorize, refresh, OAuthError };
