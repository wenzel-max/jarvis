'use strict';
// Testa o ciclo de ferramentas da IA (src/ai.js + src/tools.js) com um Groq falso que faz
// streaming de chamadas de ferramenta em pedaços, como o de verdade.
const http = require('node:http');
const assert = require('node:assert');
const ai = require('../src/ai');
const { createTools } = require('../src/tools');

const sse = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const requests = [];
let strict = true;      // a API de verdade recusa histórico com chamadas de ferramenta sem a lista de ferramentas
let hang = null;        // (body) => true para nunca responder
let script = () => null;   // (body, n) => { content?, calls?: [{name, args}], status?, json? }

function groq(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: url.pathname, body });
    if (strict && body.messages?.some((m) => m.role === 'tool' || m.tool_calls) && !body.tools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: "'tools' must be defined when messages contain tool calls", code: 'invalid_request_error' } }));
    }
    if (hang && body.stream && hang(body)) return;   // nunca responde
    const step = script(body, requests.length) ?? { content: 'ok' };
    if (step.status) { res.writeHead(step.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(step.json ?? {})); }
    if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: step.content } }] })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (step.content) for (const piece of step.content.match(/.{1,12}/gs)) res.write(sse({ content: piece }));
    (step.calls ?? []).forEach((c, i) => {
      const args = JSON.stringify(c.args);
      res.write(sse({ tool_calls: [{ index: i, id: `call_${requests.length}_${i}`, type: 'function', function: { name: c.name, arguments: '' } }] }));
      for (const part of args.match(/.{1,9}/gs)) res.write(sse({ tool_calls: [{ index: i, function: { arguments: part } }] }));
    });
    res.end('data: [DONE]\n\n');
  });
}

const hasToolResult = (b) => b.messages.some((m) => m.role === 'tool');
const lastTool = (b) => b.messages.filter((m) => m.role === 'tool').at(-1)?.content;

(async () => {
  const srv = http.createServer(groq);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${srv.address().port}/openai/v1/chat/completions`;

  const gcalls = [];
  const fakeGoogle = {
    listEvents: async (a) => { gcalls.push(['listEvents', a]); return [{ id: 'ev9', title: 'Reunião com o time', start: '2026-10-05T10:00:00', end: '2026-10-05T11:00:00', allDay: false, location: 'Sala 2' }]; },
    createEvent: async (a) => { if (!a.title?.trim()) throw new Error('Faltou o título do compromisso.'); gcalls.push(['createEvent', a]); return { id: 'novo1', title: a.title, start: a.start, end: '2026-10-07T16:00:00', allDay: false, location: '' }; },
    updateEvent: async (id, a) => { gcalls.push(['updateEvent', id, a]); return { id, title: a.title || 'x', start: a.start || '2026-10-05T10:00:00', end: '2026-10-05T11:00:00', allDay: false, location: '' }; },
    deleteEvent: async (id) => { gcalls.push(['deleteEvent', id]); if (id === 'xx') throw new Error('Não encontrei esse item na agenda.'); },
    listTasks: async () => [{ id: 't1', title: 'Comprar pão', due: '2026-10-05', notes: '' }],
    createTask: async (a) => { gcalls.push(['createTask', a]); return { id: 't9', title: a.title, due: a.due || '', notes: '' }; },
    completeTask: async (id) => { gcalls.push(['completeTask', id]); },
  };
  let connected = true;
  let webOn = true;
  const settings = { aiModel: 'm', webModel: 'groq/compound-mini', userName: 'Axl', city: { name: 'Natal' } };
  const tools = createTools({
    google: fakeGoogle,
    web: (q, ctx) => ai.webSearch(q, { settings, key: 'k', endpoint, signal: ctx?.signal }),
    isGoogleConnected: () => connected,
    settings: () => ({ webSearch: webOn }),
  });
  const ask = async (question, over = {}) => {
    const spoken = [];
    const r = await ai.ask({ question, history: [] }, { settings, onSentence: (t) => spoken.push(t), endpoint, key: 'k', tools, ...over });
    return { ...r, spoken };
  };
  const names = () => tools.definitions().map((d) => d.function.name);

  // ---- ferramentas disponíveis dependem do que está conectado ----
  assert.deepStrictEqual(names(), ['pesquisar_na_internet', 'noticias', 'agenda_listar', 'agenda_criar', 'agenda_alterar', 'agenda_apagar', 'tarefas_listar', 'tarefas_criar', 'tarefas_concluir']);
  connected = false;
  assert.deepStrictEqual(names(), ['pesquisar_na_internet', 'noticias']);
  webOn = false;
  assert.deepStrictEqual(names(), []);
  webOn = true; connected = true;

  // ---- sem ferramentas: conversa normal, nada de "tools" no pedido ----
  connected = false; webOn = false;
  script = () => ({ content: 'Tudo bem por aqui, e com você?' });
  let r = await ask('Tudo bem?');
  assert.strictEqual(r.text, 'Tudo bem por aqui, e com você?');
  assert.strictEqual(requests.at(-1).body.tools, undefined);
  assert.match(requests.at(-1).body.messages[0].content, /não tem acesso à internet/);
  connected = true; webOn = true;

  // ---- consultar a agenda: frase antes da ferramenta, ferramenta, resposta final ----
  requests.length = 0;
  script = (b) => (hasToolResult(b)
    ? { content: 'Amanhã você tem a reunião com o time às dez, na sala 2.' }
    : { content: 'Deixa eu ver. ', calls: [{ name: 'agenda_listar', args: { inicio: '2026-10-05T00:00:00', fim: '2026-10-05T23:59:59' } }] });
  r = await ask('O que eu tenho amanhã?');
  assert.strictEqual(requests.length, 2);
  const first = requests[0].body;
  assert.strictEqual(first.tool_choice, 'auto');
  assert.strictEqual(first.parallel_tool_calls, false);
  assert.strictEqual(first.tools.length, 9);
  assert.match(first.messages[0].content, /Google Agenda/);
  assert.match(first.messages[0].content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00 \(fuso /);
  assert.deepStrictEqual(gcalls.at(-1), ['listEvents', { timeMin: '2026-10-05T00:00:00', timeMax: '2026-10-05T23:59:59', max: 20 }]);
  assert.match(lastTool(requests[1].body), /id=ev9 \| Reunião com o time \| .*10:00 até 11:00 \| local: Sala 2/);
  const asst = requests[1].body.messages.find((m) => m.tool_calls);
  assert.strictEqual(asst.tool_calls[0].function.name, 'agenda_listar');
  assert.ok(JSON.parse(asst.tool_calls[0].function.arguments).fim);
  assert.deepStrictEqual(r.spoken, ['Deixa eu ver.', 'Amanhã você tem a reunião com o time às dez,', 'na sala 2.']);
  assert.strictEqual(r.text, 'Deixa eu ver. Amanhã você tem a reunião com o time às dez, na sala 2.');

  // ---- criar compromisso ----
  script = (b) => (hasToolResult(b) ? { content: 'Marquei o dentista pra segunda às três da tarde.' }
    : { calls: [{ name: 'agenda_criar', args: { titulo: 'Dentista', inicio: '2026-10-07T15:00:00', local: 'Centro' } }] });
  r = await ask('Marca o dentista na segunda às 15h');
  assert.deepStrictEqual(gcalls.at(-1), ['createEvent', { title: 'Dentista', start: '2026-10-07T15:00:00', end: undefined, allDay: false, location: 'Centro' }]);
  assert.strictEqual(r.spoken[0], 'Marquei o dentista pra segunda às três da tarde.');

  // ---- encadeado: lista para achar o id e depois apaga ----
  let n = 0;
  script = (b) => {
    n++;
    if (n === 1) return { calls: [{ name: 'agenda_listar', args: { inicio: '2026-10-05T00:00:00', fim: '2026-10-05T23:59:59' } }] };
    if (n === 2) return { calls: [{ name: 'agenda_apagar', args: { id: 'ev9' } }] };
    return { content: 'Pronto, apaguei a reunião.' };
  };
  r = await ask('Cancela a reunião de amanhã');
  assert.deepStrictEqual(gcalls.at(-1), ['deleteEvent', 'ev9']);
  assert.strictEqual(r.text, 'Pronto, apaguei a reunião.');

  // ---- tarefas ----
  script = (b) => (hasToolResult(b) ? { content: 'Anotado.' } : { calls: [{ name: 'tarefas_criar', args: { titulo: 'Pagar a luz', data: '2026-10-10' } }] });
  await ask('Cria uma tarefa pagar a luz até dia 10');
  assert.deepStrictEqual(gcalls.at(-1), ['createTask', { title: 'Pagar a luz', due: '2026-10-10' }]);
  assert.match(lastTool(requests.at(-1).body), /Tarefa criada: Pagar a luz/);

  // ---- erro da ferramenta vira texto para o modelo explicar ----
  script = (b) => (hasToolResult(b) ? { content: 'Não achei esse compromisso.' } : { calls: [{ name: 'agenda_apagar', args: { id: 'xx' } }] });
  r = await ask('Apaga o compromisso xx');
  assert.match(lastTool(requests.at(-1).body), /Não deu certo: Não encontrei esse item/);
  assert.strictEqual(r.text, 'Não achei esse compromisso.');

  // ---- ferramenta inexistente e argumentos quebrados não derrubam nada ----
  script = (b) => (hasToolResult(b) ? { content: 'Desculpa, não consegui.' } : { calls: [{ name: 'hackear_tudo', args: { a: 1 } }] });
  r = await ask('Faz algo estranho');
  assert.match(lastTool(requests.at(-1).body), /não existe/);
  assert.strictEqual(await tools.run('agenda_criar', 'texto solto'), 'Não deu certo: Faltou o título do compromisso.');

  // ---- pergunta sobre o que muda com o tempo: a primeira volta é obrigada a pesquisar ----
  requests.length = 0;
  script = (b) => (hasToolResult(b)
    ? { content: 'O próximo jogo do Flamengo é no sábado.' }
    : { calls: [{ name: 'pesquisar_na_internet', args: { consulta: 'próximo jogo do Flamengo' } }] });
  r = await ask('Qual é o próximo jogo do Flamengo?');
  assert.strictEqual(requests.length, 3, 'pergunta, busca (o mesmo servidor falso) e resposta');
  assert.deepStrictEqual(requests[0].body.tool_choice, { type: 'function', function: { name: 'pesquisar_na_internet' } });
  assert.strictEqual(requests[2].body.tool_choice, 'auto', 'só a primeira volta é forçada');
  assert.match(requests[0].body.messages[0].content, /SEMPRE pesquise/);
  assert.strictEqual(r.text, 'O próximo jogo do Flamengo é no sábado.');
  // pergunta comum não é forçada
  requests.length = 0;
  script = () => ({ content: 'Hoje é domingo.' });
  await ask('Que dia é hoje?');
  assert.strictEqual(requests[0].body.tool_choice, 'auto');

  // ---- modelo monta a chamada errado (400 tool_use_failed): repete sem ferramentas ----
  requests.length = 0;
  script = (b) => (b.tool_choice === 'auto' ? { status: 400, json: { error: { message: 'Failed to call a function.', code: 'tool_use_failed' } } } : { content: 'Posso ajudar sim.' });
  r = await ask('Me ajuda?');
  assert.strictEqual(requests.length, 2);
  assert.ok(requests[0].body.tools && requests[0].body.tool_choice === 'auto');
  assert.ok(requests[1].body.tools && requests[1].body.tool_choice === 'none', 'sem poder chamar ferramentas, mas com a lista (a API exige)');
  assert.strictEqual(r.text, 'Posso ajudar sim.');

  // ---- modelo preso em ferramentas: depois de 4 voltas é forçado a responder ----
  requests.length = 0;
  script = (b) => (b.tool_choice === 'auto' ? { calls: [{ name: 'tarefas_listar', args: {} }] } : { content: 'Chega de ferramentas, aqui está.' });
  r = await ask('Lista tarefas sem parar');
  assert.ok(requests.length <= 7, `muitas chamadas: ${requests.length}`);
  assert.strictEqual(r.text, 'Chega de ferramentas, aqui está.');
  assert.strictEqual(requests.at(-1).body.tool_choice, 'none');

  // ---- erro de ferramenta numa API estrita: a volta de recuperação é válida e o Jarvis responde ----
  script = (b) => {
    if (b.tool_choice === 'auto' && !hasToolResult(b)) return { calls: [{ name: 'tarefas_listar', args: {} }] };
    if (b.tool_choice === 'auto') return { status: 400, json: { error: { message: 'Failed to call a function.', code: 'tool_use_failed' } } };
    return { content: 'Não consegui consultar agora.' };
  };
  r = await ask('Quais são minhas tarefas?');
  assert.strictEqual(r.text, 'Não consegui consultar agora.');
  assert.ok(!r.error);

  // ---- ferramenta lenta: o Jarvis avisa em voz alta que ainda está trabalhando ----
  const slow = createTools({
    google: { ...fakeGoogle, listTasks: () => new Promise((res) => setTimeout(() => res([{ id: 't1', title: 'Pagar a luz', due: '', notes: '' }]), 260)) },
    web: null, isGoogleConnected: () => true, settings: () => ({ webSearch: false }),
  });
  script = (b) => (hasToolResult(b) ? { content: 'Tem uma tarefa: pagar a luz.' } : { content: 'Deixa eu ver. ', calls: [{ name: 'tarefas_listar', args: {} }] });
  r = await ask('Minhas tarefas?', { tools: slow, fillerMs: 70 });
  assert.deepStrictEqual(r.spoken.filter((t) => /instante|procurando/.test(t)), ['Só mais um instante.', 'Ainda estou procurando, só mais um pouquinho.'], 'avisa enquanto a ferramenta demora, em dois momentos');
  assert.strictEqual(r.spoken.at(-1), 'Tem uma tarefa: pagar a luz.');
  const fast = await ask('Minhas tarefas?', { fillerMs: 5000 });
  assert.ok(!fast.spoken.some((t) => /instante/.test(t)), 'ferramenta rápida não precisa de aviso');

  // ---- volta de conversa que trava: vira erro claro em vez de silêncio ----
  hang = () => true;
  const t0 = Date.now();
  r = await ask('Alguém aí?', { turnTimeoutMs: 150 });
  assert.match(r.error, /demorou demais/);
  assert.ok(Date.now() - t0 < 2000);
  hang = null;

  // ---- busca na internet (Compound, sem streaming) ----
  requests.length = 0;
  script = (b) => {
    if (!b.stream) return { content: '**O Flamengo** ganhou de 2 a 1 ontem. Veja [aqui](http://x.com).' };
    return hasToolResult(b) ? { content: 'O Flamengo ganhou de dois a um ontem.' } : { content: 'Deixa eu pesquisar. ', calls: [{ name: 'pesquisar_na_internet', args: { consulta: 'resultado do Flamengo ontem' } }] };
  };
  r = await ask('Como foi o jogo do Flamengo?');
  const web = requests.find((q) => !q.body.stream);
  assert.strictEqual(web.body.model, 'groq/compound-mini');
  assert.strictEqual(web.body.messages[1].content, 'resultado do Flamengo ontem');
  assert.match(lastTool(requests.at(-1).body), /^O Flamengo ganhou de 2 a 1 ontem\. Veja aqui\.$/, 'markdown e links são limpos');
  assert.deepStrictEqual(r.spoken, ['Deixa eu pesquisar.', 'O Flamengo ganhou de dois a um ontem.']);

  // ---- busca: modelo Compound não existe na conta -> descobre outro; sem nenhum -> avisa ----
  const saved = [];
  script = (b) => (b.model === 'groq/compound-mini' ? { status: 404, json: { error: { message: 'model not found', code: 'model_not_found' } } } : { content: 'Achei.' });
  const srv2 = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200); return res.end(JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }, { id: 'groq/compound' }] })); }
    groq(req, res);
  });
  await new Promise((rr) => srv2.listen(0, '127.0.0.1', rr));
  const ep2 = `http://127.0.0.1:${srv2.address().port}/openai/v1/chat/completions`;
  assert.strictEqual(await ai.webSearch('qualquer', { settings, key: 'k', endpoint: ep2, onSetting: (k, v) => saved.push([k, v]) }), 'Achei.');
  assert.deepStrictEqual(saved, [['webModel', 'groq/compound']]);
  const srv3 = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200); return res.end(JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }] })); }
    groq(req, res);
  });
  await new Promise((rr) => srv3.listen(0, '127.0.0.1', rr));
  const ep3 = `http://127.0.0.1:${srv3.address().port}/openai/v1/chat/completions`;
  assert.match(await ai.webSearch('qualquer', { settings, key: 'k', endpoint: ep3 }), /não está disponível na sua conta/);

  // ---- busca: limite do dia (429) vira texto para o modelo ----
  script = () => ({ status: 429, json: {} });
  assert.match(await tools.run('pesquisar_na_internet', { consulta: 'x' }), /Não deu certo: Atingi o limite gratuito/);

  for (const s of [srv, srv2, srv3]) { s.closeAllConnections(); s.close(); }
  console.log('tools: todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
