'use strict';
// Testa src/ai.js sem rede: servidor local que imita o streaming (SSE) da API.
const http = require('node:http');
const assert = require('node:assert');
const { streamChat, ask, transcribe, Sentencer, cleanForSpeech } = require('../src/ai');

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
  // primeira frase sai cedo: curta já serve, e sem ponto final fecha numa vírgula
  const early = [];
  const se = new Sentencer((t) => early.push(t));
  se.push('Tá bem nublado hoje. ');
  se.push('Faz vinte e oito graus agora, então leve um ');
  se.push('guarda-chuva se for sair.');
  se.flush();
  assert.deepStrictEqual(early, ['Tá bem nublado hoje.', 'Faz vinte e oito graus agora, então leve um guarda-chuva se for sair.']);
  const comma = [];
  const sc = new Sentencer((t) => comma.push(t));
  sc.push('Olha, em Natal hoje o céu está bem nublado, com chance de ');
  assert.deepStrictEqual(comma, ['Olha, em Natal hoje o céu está bem nublado,']);
  sc.push('chuva à tarde. Leve um guarda-chuva por precaução.');
  sc.flush();
  assert.deepStrictEqual(comma.slice(1), ['com chance de chuva à tarde.', 'Leve um guarda-chuva por precaução.']);
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

  // modelo recusado: descobre outro na lista da conta, tenta de novo e informa qual funcionou
  {
    const used = [];
    await withServer((req, res) => {
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-guard-4-12b' }, { id: 'meta-llama/llama-4-scout' }, { id: 'llama-3.1-8b-novo' }] }));
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const model = JSON.parse(raw).model;
        used.push(model);
        if (model === 'llama-3.1-8b-instant') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'The model `llama-3.1-8b-instant` has been decommissioned', code: 'model_decommissioned' } }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse('Tudo certo por aqui, Axl.') + 'data: [DONE]\n\n');
      });
    }, async (base) => {
      const got = [];
      const reply = await ask({ question: 'Oi?', history: [] }, {
        settings: { aiModel: 'llama-3.1-8b-instant', userName: 'Axl', city: { name: 'Natal' } },
        onSentence: (t) => got.push(t), endpoint: `${base}/openai/v1/chat/completions`, key: 'gsk_teste',
      });
      assert.deepStrictEqual(used, ['llama-3.1-8b-instant', 'llama-3.1-8b-novo']);
      assert.strictEqual(reply.model, 'llama-3.1-8b-novo');
      assert.strictEqual(reply.text, 'Tudo certo por aqui, Axl.');
      assert.deepStrictEqual(got, ['Tudo certo por aqui, Axl.']);
    });

    // sem alternativa na lista: mantém a mensagem pedindo para trocar o modelo
    await withServer((req, res) => {
      if (req.url.endsWith('/models')) { res.writeHead(200); return res.end(JSON.stringify({ data: [{ id: 'whisper-large-v3' }] })); }
      res.writeHead(404); res.end(JSON.stringify({ error: { message: 'model not found', code: 'model_not_found' } }));
    }, async (base) => {
      const reply = await ask({ question: 'Oi?' }, {
        settings: { aiModel: 'x', userName: 'Axl', city: { name: 'Natal' } },
        onSentence() {}, endpoint: `${base}/openai/v1/chat/completions`, key: 'gsk_teste',
      });
      assert.match(reply.error, /não aceitou o modelo "x"/);
    });

    // 400 que não é do modelo mostra o motivo
    await withServer((req, res) => { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'max_tokens inválido', code: 'invalid_request' } })); }, async (base) => {
      const reply = await ask({ question: 'Oi?' }, {
        settings: { aiModel: 'x', userName: 'Axl', city: { name: 'Natal' } },
        onSentence() {}, endpoint: `${base}/openai/v1/chat/completions`, key: 'gsk_teste',
      });
      assert.match(reply.error, /recusou o pedido: max_tokens inválido/);
    });
  }

  // ---------- voz de entrada ----------
  {
    const settings = { sttModel: 'whisper-large-v3-turbo' };
    const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const seen = [];
    const handler = (reply) => (req, res) => {
      if (req.url.endsWith('/models')) { res.writeHead(200); return res.end(JSON.stringify({ data: [{ id: 'llama-3.1-8b' }, { id: 'whisper-large-v3' }, { id: 'distil-whisper-pt' }] })); }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('latin1');
        seen.push({ auth: req.headers.authorization, type: req.headers['content-type'], raw });
        const out = reply(raw);
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    };

    // envio correto, com troca do modelo recusado
    await withServer(handler((raw) => (raw.includes('whisper-large-v3-turbo')
      ? { status: 400, body: { error: { message: 'model not found', code: 'model_not_found' } } }
      : { status: 200, body: { text: '  Que horas são?  ' } })), async (base) => {
      const r = await transcribe({ audio, mime: 'audio/webm;codecs=opus' }, { settings, endpoint: `${base}/openai/v1/audio/transcriptions`, key: 'gsk_teste' });
      assert.deepStrictEqual(r, { text: 'Que horas são?', model: 'whisper-large-v3' });
      const last = seen.at(-1);
      assert.strictEqual(last.auth, 'Bearer gsk_teste');
      assert.match(last.type, /^multipart\/form-data/);
      assert.match(last.raw, /name="language"\r\n\r\npt/);
      assert.match(last.raw, /name="file"; filename="fala\.webm"/);
      assert.match(last.raw, /name="model"\r\n\r\nwhisper-large-v3\r\n/);
    });

    // silêncio: o Whisper devolve frase de legenda, que deve ser descartada
    for (const text of ['Legendas pela comunidade Amara.org', '...', '']) {
      await withServer(handler(() => ({ status: 200, body: { text } })), async (base) => {
        const r = await transcribe({ audio, mime: 'audio/webm' }, { settings, endpoint: `${base}/openai/v1/audio/transcriptions`, key: 'k' });
        assert.match(r.error, /Não entendi/, `texto "${text}"`);
      });
    }

    // validações locais, sem rede
    assert.match((await transcribe({ audio, mime: 'video/mp4' }, { settings, key: 'k' })).error, /formato/);
    assert.match((await transcribe({ audio: new Uint8Array(0), mime: 'audio/webm' }, { settings, key: 'k' })).error, /gravar/);
    assert.match((await transcribe({ audio: new Uint8Array(6 * 1024 * 1024), mime: 'audio/webm' }, { settings, key: 'k' })).error, /longa demais/);
    assert.match((await transcribe({ audio: 'texto', mime: 'audio/webm' }, { settings, key: 'k' })).error, /gravar/);

    // erro de chave
    await withServer(handler(() => ({ status: 401, body: {} })), async (base) => {
      const r = await transcribe({ audio, mime: 'audio/webm' }, { settings, endpoint: `${base}/openai/v1/audio/transcriptions`, key: 'k' });
      assert.match(r.error, /chave do Groq foi recusada/);
    });
  }

  console.log('ai: todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
