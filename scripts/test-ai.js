'use strict';
// Testa src/ai.js sem rede: servidor local que imita o streaming (SSE) da API.
const http = require('node:http');
const assert = require('node:assert');
const { streamChat, Sentencer, cleanForSpeech } = require('../src/ai');

const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}/v1`); } finally { srv.closeAllConnections(); srv.close(); }
}

(async () => {
  // divisão em frases
  const out = [];
  const s = new Sentencer((t) => out.push(t));
  for (const piece of ['Olá, Axl! Hoje o céu está ', 'nublado em Natal. Leve ', 'um guarda-chuva. 3.5 graus.', ' Ok']) s.push(piece);
  s.flush();
  assert.deepStrictEqual(out, ['Olá, Axl! Hoje o céu está nublado em Natal.', 'Leve um guarda-chuva. 3.5 graus.', 'Ok']);
  assert.strictEqual(cleanForSpeech('**Oi** [site](https://x.com) 😀\n- item um'), 'Oi site item um');

  // resposta em streaming, com pedaços cortados no meio da linha
  await withServer((req, res) => {
    assert.strictEqual(req.headers.authorization, 'Bearer gsk_teste');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const body = sse('Claro, ') + sse('Axl. Estou aqui ') + sse('para ajudar você hoje.') + 'data: [DONE]\n\n';
    res.write(body.slice(0, 40)); setTimeout(() => { res.write(body.slice(40)); res.end(); }, 30);
  }, async (endpoint) => {
    const got = [];
    const full = await streamChat({ key: 'gsk_teste', model: 'm', messages: [], signal: new AbortController().signal, onSentence: (t) => got.push(t), endpoint });
    assert.strictEqual(full, 'Claro, Axl. Estou aqui para ajudar você hoje.');
    assert.deepStrictEqual(got, ['Claro, Axl. Estou aqui para ajudar você hoje.']);
  });

  // erros HTTP viram mensagens em português
  for (const [status, re] of [[401, /chave do Groq foi recusada/], [429, /limite gratuito/], [404, /modelo "m"/], [500, /erro 500/]]) {
    await withServer((req, res) => { res.writeHead(status); res.end('{}'); }, async (endpoint) => {
      await assert.rejects(streamChat({ key: 'k', model: 'm', messages: [], signal: new AbortController().signal, onSentence() {}, endpoint }), re);
    });
  }

  // sem servidor: mensagem de conexão
  await assert.rejects(streamChat({ key: 'k', model: 'm', messages: [], signal: new AbortController().signal, onSentence() {}, endpoint: 'http://127.0.0.1:1/v1' }), /Sem conexão/);

  // cancelamento no meio do stream
  await withServer((req, res) => { res.writeHead(200); res.write(sse('Começo da resposta longa. ')); }, async (endpoint) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    await assert.rejects(streamChat({ key: 'k', model: 'm', messages: [], signal: ctrl.signal, onSentence() {}, endpoint }));
  });

  console.log('ai: todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
