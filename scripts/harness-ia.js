'use strict';
// Harness da interface por voz: Electron real, IPC simulado (sem rede), microfone sintético
// que eu controlo (window.__say(ms, amp) liga um tom pelo tempo pedido) e capturas em scripts/out/.
// A "voz" do Jarvis é um tom WAV com duração proporcional ao texto, então o estado "falando" dura de verdade.
// Uso: xvfb-run -a npx electron --no-sandbox scripts/harness-ia.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = {
  userName: 'Axl', userNameSpoken: '', voice: 'pt-BR-AntonioNeural', rate: 0, pitch: 0,
  city: { name: 'Natal', admin: 'Rio Grande do Norte', lat: -5.79, lon: -35.2 },
  autostart: false, startDelaySec: 0, speakOnStart: false, fullscreen: false, listenOnStart: false, bargeIn: true,
  aiModel: 'llama-3.1-8b-instant', sttModel: 'whisper-large-v3-turbo', micLabel: '', micCompat: false,
  feeds: [{ name: 'G1', url: 'https://g1.globo.com/rss/g1/' }],
};
let aiMode = 'ok';
let googleOn = false;
const googleCalls = [];
const asked = [];     // perguntas que chegaram à IA
const heard = [];     // trechos de áudio enviados para transcrição { bytes, mime, at }
const spoken = [];    // frases que o Jarvis mandou sintetizar (o que ele fala)
const sttScript = []; // o que o "Whisper" devolve, na ordem: texto, { error } ou { text, delay }

// WAV de teste: tom de `sec` segundos a 24 kHz
function wav(sec) {
  const rate = 24000, n = Math.floor(rate * sec), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 4000), 44 + i * 2);
  return buf;
}

function fakeIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, p) => Object.assign(settings, p));
  ipcMain.handle('tts:voices', () => []);
  ipcMain.handle('tts:synthesize', async (_e, opts) => {
    spoken.push(opts.text);
    await sleep(120);                                  // latência da síntese
    return wav(0.5 + opts.text.length * 0.045);        // a fala dura em proporção ao texto
  });
  ipcMain.handle('weather:get', () => ({
    current: { temperature_2m: 28, apparent_temperature: 29, relative_humidity_2m: 63, weather_code: 3, wind_speed_10m: 21 },
    daily: { temperature_2m_max: [29], temperature_2m_min: [25], precipitation_probability_max: [45] },
  }));
  ipcMain.handle('news:get', () => ({ items: [{ title: 'Manchete de teste com acentuação: pró-ação', link: 'https://x.com', source: 'G1', time: Date.now() - 600000 }], failed: 0, total: 1 }));
  ipcMain.handle('geo:search', () => []);
  ipcMain.handle('shell:open', () => {});
  ipcMain.handle('win:fullscreen', () => false);
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:relaunch', () => {});
  ipcMain.handle('ai:key-status', () => ({ hasKey: true }));
  ipcMain.handle('ai:key-set', (_e, k) => (k.length < 20 ? { ok: false, error: 'A chave tem formato inválido.' } : { ok: true, hasKey: true }));
  ipcMain.handle('stt:transcribe', async (_e, req) => {
    const bytes = req.audio?.byteLength ?? req.audio?.length ?? 0;
    heard.push({ bytes, mime: req.mime, at: Date.now() });
    const next = sttScript.shift();
    if (next && typeof next === 'object' && next.delay) await sleep(next.delay);
    if (next === undefined) return { error: 'Não entendi o que você disse. Tente falar mais perto do microfone.' };
    return typeof next === 'string' ? { text: next, model: 'whisper-large-v3-turbo' } : next;
  });
  ipcMain.handle('google:status', () => ({ hasCredentials: googleOn, connected: googleOn, needsReconnect: false }));
  ipcMain.handle('google:connect', async (_e, creds) => {
    googleCalls.push(creds);
    if (!/apps\.googleusercontent\.com$/.test(creds?.clientId ?? '')) return { ok: false, error: 'O ID do cliente parece errado. Ele termina com .apps.googleusercontent.com.' };
    googleOn = true;
    return { ok: true, hasCredentials: true, connected: true, needsReconnect: false };
  });
  ipcMain.handle('google:disconnect', () => { googleOn = false; return { ok: true, connected: false }; });
  ipcMain.handle('agenda:today', () => {
    if (!googleOn) return { connected: false, events: [], tasks: [] };
    const at = (H, M = 0) => { const d = new Date(); d.setHours(H, M, 0, 0); return d.toISOString(); };
    return {
      connected: true,
      events: [
        { id: 'e1', title: 'Reunião com o time', start: at(23, 30), end: at(23, 59), allDay: false },
        { id: 'e2', title: 'Aniversário da Ana', start: '2026-10-05', end: '2026-10-06', allDay: true },
      ],
      tasks: [{ id: 't1', title: 'Comprar pão' }, { id: 't2', title: 'Pagar a luz' }],
    };
  });
  ipcMain.handle('ai:cancel', () => {});
  ipcMain.handle('ai:ask', async (e, req) => {
    asked.push({ q: req.question, hist: req.history?.length ?? 0 });
    await sleep(900); // "pensando"
    if (aiMode === 'error') return { error: 'A chave do Groq foi recusada. Confira a chave em Ajustes.' };
    const parts = ['Em Natal faz vinte e oito graus agora, com o céu nublado.', 'A chance de chuva hoje é de quarenta e cinco por cento.', 'Leve um guarda-chuva por garantia.'];
    for (const text of parts) { e.sender.send('ai:sentence', { id: req.id, text }); await sleep(400); }
    return { text: parts.join(' ') };
  });
}

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
}
const js = (win, code) => win.webContents.executeJavaScript(code);
const state = (win) => js(win, "document.querySelector('#hud').dataset.state");
const noticeText = (win) => js(win, "document.querySelector('#notice').hidden ? '' : document.querySelector('#notice').textContent");
const status = (win) => js(win, "document.querySelector('#status-text').textContent");
const click = (win, sel) => js(win, `document.querySelector(${JSON.stringify(sel)}).click()`);

// Microfone sintético: tom de "voz" controlado + ruído de fundo fraco.
const FAKE_MIC = `(() => {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 180;
  const gain = ctx.createGain(); gain.gain.value = 0;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest); osc.start();
  const noise = ctx.createOscillator(); noise.frequency.value = 3000;
  const ng = ctx.createGain(); ng.gain.value = 0.002; noise.connect(ng).connect(dest); noise.start();
  window.__say = (ms, amp = 0.3) => new Promise((r) => { gain.gain.value = amp; setTimeout(() => { gain.gain.value = 0; r(Date.now()); }, ms); });
  navigator.mediaDevices.getUserMedia = async () => dest.stream.clone();   // um microfone real entrega um stream novo a cada abertura
  navigator.mediaDevices.enumerateDevices = async () => [];
  window.__states = [];
  new MutationObserver(() => { const st = document.querySelector('#hud').dataset.state; const s = window.__states; if (s[s.length - 1] !== st) s.push(st); })
    .observe(document.querySelector('#hud'), { attributes: true, attributeFilter: ['data-state'] });
})()`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fakeIpc();
  const win = new BrowserWindow({
    width: 1366, height: 768, show: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  const logs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/ScriptProcessorNode is deprecated/.test(msg)) logs.push(msg); });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await sleep(3500);
  await js(win, FAKE_MIC);

  const results = [];
  const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name} ${extra}`); };
  const statesFrom = async () => { const s = await js(win, 'window.__states'); await js(win, 'window.__states = window.__states.slice(-1)'); return s; };
  // espera o Jarvis voltar ao repouso e o microfone voltar ao normal (700 ms depois)
  const settle = async (max = 30000) => {
    const t0 = Date.now();
    await sleep(600);
    while (Date.now() - t0 < max && (await state(win)) !== 'idle') await sleep(250);
    await sleep(1100);
  };
  const waitState = async (st, max = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < max && (await state(win)) !== st) await sleep(60); return (await state(win)) === st; };
  const speakAndWait = async (ms, extra = 2600, amp = 0.3) => { await js(win, `window.__say(${ms}, ${amp})`); await sleep(extra); };

  // ---- sem legendas, sem caixa de digitar ----
  check('não existe legenda nem caixa de digitar', await js(win, "!document.querySelector('#caption') && !document.querySelector('#ask-input') && !document.querySelector('#ask-form')"));
  await shot(win, '1-repouso');

  // ---- ligar a escuta ----
  await click(win, '#btn-mic');
  await sleep(1500);
  check('escuta ligada e status pede "Jarvis"', (await js(win, "document.querySelector('#btn-mic').textContent")) === 'Escuta ligada' && /diga "Jarvis"/.test(await status(win)), await status(win));

  // ---- conversa ao redor é ignorada; fim da frase é detectado rápido; sem silêncio sobrando no envio ----
  sttScript.push('Que horas são?');
  const endedAt = await js(win, 'window.__say(1400)');
  await sleep(2200);
  check('fala sem o nome é ignorada', heard.length === 1 && asked.length === 0 && (await state(win)) === 'idle', `heard=${heard.length} asked=${asked.length}`);
  const endLatency = heard[0].at - endedAt;
  check('fim da frase detectado em menos de 1 s', endLatency < 1000, `${endLatency} ms`);
  check('envio sem silêncio sobrando (WAV 16 kHz curto)', heard[0].mime === 'audio/wav' && heard[0].bytes < 70000, `${heard[0].bytes} bytes`);

  // ---- chamando pelo nome ----
  sttScript.push('Jarvis, como está o tempo em Natal?');
  await statesFrom();
  await speakAndWait(1400, 1500);
  await settle();
  check('"Jarvis, ..." chega à IA sem o nome', asked.at(-1)?.q === 'como está o tempo em Natal?', JSON.stringify(asked.at(-1)));
  const s1 = (await statesFrom()).join('>');
  check('ouvindo -> pensando -> falando -> repouso', /listening>thinking>speaking>idle/.test(s1), s1);
  check('o Jarvis falou as frases da resposta, sem legenda', spoken.some((t) => /vinte e oito/.test(t)) && spoken.some((t) => /quarenta e cinco/.test(t)) && (await noticeText(win)) === '');
  check('depois da resposta a conversa continua aberta', /Pode continuar falando/.test(await status(win)), await status(win));

  // ---- continua sem repetir o nome ----
  sttScript.push('E amanhã?');
  await speakAndWait(1000, 1500);
  await settle();
  check('segunda pergunta sem dizer "Jarvis"', asked.at(-1)?.q === 'E amanhã?' && asked.at(-1).hist === 2, JSON.stringify(asked.at(-1)));

  // ---- INTERRUPÇÃO: falar por cima faz o Jarvis parar e ouvir ----
  sttScript.push('Qual é a capital da França?');
  await speakAndWait(1000, 600);                       // faz uma pergunta; a resposta começa a ser falada
  check('o Jarvis começa a falar', await waitState('speaking', 12000));
  await sleep(400);
  const nBefore = spoken.length;
  await statesFrom();
  sttScript.push('Não, espera, qual é a capital do Brasil?');
  await js(win, 'window.__say(1000)');                 // você fala por cima
  await sleep(400);
  const s2 = (await statesFrom()).join('>');
  check('falar por cima interrompe: sai de "falando" e passa a ouvir', /listening/.test(s2), s2);
  await sleep(2600);
  await settle();
  check('depois de interromper, ele responde ao que você disse', asked.at(-1)?.q === 'Não, espera, qual é a capital do Brasil?', JSON.stringify(asked.at(-1)));
  check('a resposta interrompida não foi terminada', spoken.length > nBefore, `${spoken.length - nBefore} frases novas`);
  await shot(win, '2-depois-de-interromper');

  // ---- som fraco por cima NÃO interrompe (eco, estalo) ----
  sttScript.push('Qual é a capital da Itália?');
  await speakAndWait(1000, 600);
  check('começa a falar de novo', await waitState('speaking', 12000));
  await statesFrom();
  const hBefore = heard.length;
  await js(win, 'window.__say(900, 0.02)');            // fraco: abaixo do limiar de interrupção
  await sleep(300);
  check('som fraco por cima não interrompe', (await state(win)) === 'speaking', await state(win));
  await settle();
  check('e nada foi transcrito do som fraco', heard.length - hBefore === 0, `transcrições novas: ${heard.length - hBefore}`);

  // ---- "para" depois de interromper: fica quieto, sem chamar a IA ----
  sttScript.push('Qual é a capital da Espanha?');
  await speakAndWait(1000, 600);
  check('fala outra vez', await waitState('speaking', 12000));
  const askedBefore = asked.length;
  sttScript.push('Para!');
  await js(win, 'window.__say(800)');
  await sleep(3000);
  const stateAfterStop = await state(win);
  check('"Para!" interrompe e não chama a IA', asked.length === askedBefore && stateAfterStop === 'idle', `perguntas novas=${asked.length - askedBefore} estado=${stateAfterStop}`);
  await settle();

  // ---- "obrigado" responde na hora, sem IA ----
  const askedB2 = asked.length, spokenB2 = spoken.length;
  sttScript.push('Obrigado, Jarvis');
  await speakAndWait(1000, 1500);
  await settle();
  check('"Obrigado" -> "De nada!" sem chamar a IA', asked.length === askedB2 && spoken.slice(spokenB2).includes('De nada!'), JSON.stringify(spoken.slice(spokenB2)));

  // ---- pausa no meio da frase: as duas partes são juntadas ----
  sttScript.push({ text: 'Jarvis, qual é a capital', delay: 2600 });
  sttScript.push('da Alemanha?');
  await js(win, 'void window.__say(1000)');           // (sem esperar o fim do tom: o tempo aqui é o que importa)
  await sleep(1000 + 1300);                            // pausa de 1,3 s: a primeira parte já foi enviada
  await js(win, 'void window.__say(1000)');            // continua falando enquanto a primeira é transcrita
  await sleep(4500);
  await settle();
  check('pausa no meio da frase: juntou as duas partes', asked.at(-1)?.q === 'qual é a capital da Alemanha?', JSON.stringify(asked.at(-1)));

  // ---- não entendeu na conversa: pede para repetir ----
  const spokenB3 = spoken.length;
  sttScript.push({ error: 'Não entendi o que você disse. Tente falar mais perto do microfone.' });
  await speakAndWait(1000, 1500);
  await settle();
  check('"não entendi" -> Jarvis pede para repetir', spoken.slice(spokenB3).includes('Não entendi, pode repetir?'), JSON.stringify(spoken.slice(spokenB3)));

  // ---- só chamou o nome ----
  const spokenB4 = spoken.length;
  sttScript.push('Jarvis');
  await speakAndWait(900, 1500);
  await settle();
  check('só "Jarvis" -> "Pois não?"', spoken.slice(spokenB4).includes('Pois não?'));

  // ---- interrupção desligada nos Ajustes ----
  await click(win, '#btn-settings');
  await sleep(400);
  await click(win, '#set-bargein');
  await sleep(300);
  check('opção de interromper desliga e salva', settings.bargeIn === false);
  await click(win, '#settings-close');
  await sleep(300);
  sttScript.push('Qual é a capital de Portugal?');
  await speakAndWait(1000, 600);
  check('fala (interrupção desligada)', await waitState('speaking', 12000));
  const a0 = asked.length;
  await js(win, 'window.__say(900)');
  await sleep(500);
  check('com a interrupção desligada, falar por cima não para o Jarvis', (await state(win)) === 'speaking', await state(win));
  await settle();
  check('...e a fala por cima foi descartada', asked.length - a0 === 0, `perguntas novas=${asked.length - a0}`);
  await click(win, '#btn-settings'); await sleep(300); await click(win, '#set-bargein'); await sleep(200); await click(win, '#settings-close'); await sleep(200);

  // ---- pausar a escuta ----
  await click(win, '#btn-mic');
  await sleep(500);
  const n = heard.length;
  sttScript.push('Jarvis, olá');
  await speakAndWait(1200);
  check('com a escuta desligada nada é transcrito', heard.length === n && (await js(win, "document.querySelector('#btn-mic').textContent")) === 'Escuta desligada', `heard=${heard.length}/${n}`);
  await click(win, '#btn-mic');
  await sleep(1200);
  sttScript.length = 0;

  // ---- erros aparecem como aviso discreto ----
  sttScript.push({ error: 'A chave do Groq foi recusada. Confira a chave em Ajustes.' });
  await speakAndWait(1200);
  check('erro de configuração aparece como aviso', /chave do Groq foi recusada/.test(await noticeText(win)) && (await state(win)) === 'idle', await noticeText(win));
  await shot(win, '3-aviso');
  aiMode = 'error';
  await settle();
  sttScript.push('Jarvis, teste de erro');
  await speakAndWait(1200, 1500);
  await settle();
  check('erro da IA aparece como aviso e volta ao repouso', /chave do Groq foi recusada/.test(await noticeText(win)) && (await state(win)) === 'idle', `${await state(win)} | ${await noticeText(win)}`);
  aiMode = 'ok';

  // ---- Ajustes ----
  await click(win, '#btn-settings');
  await sleep(500);
  check('Ajustes tem "Ouvir o tempo todo"', await js(win, "!!document.querySelector('#set-listen')"));
  await click(win, '#set-mic-compat');
  await sleep(300);
  check('modo de compatibilidade salva e oferece reiniciar', settings.micCompat === true && !(await js(win, "document.querySelector('#compat-restart').hidden")));
  await click(win, '#set-mic-compat');
  check('seletor de microfone tem a opção automática', /^Automático/.test(await js(win, "document.querySelector('#set-mic option').textContent")));
  await click(win, '#btn-mic-test');
  await sleep(600);
  check('teste do microfone mostra "Fale agora"', (await js(win, "document.querySelector('#btn-mic-test').textContent")) === 'Fale agora…');
  await js(win, 'window.__say(2500)');
  await sleep(4500);
  const micMsg = await js(win, "document.querySelector('#mic-msg').textContent");
  check('teste do microfone informa o nível medido', /Funcionando.*nível máximo \d+%/.test(micMsg), micMsg);
  await shot(win, '4-ajustes');
  await click(win, '#settings-close');
  await sleep(300);

  // ---- Google Agenda e Tarefas ----
  check('sem Google conectado o painel da agenda não aparece', await js(win, "document.querySelector('#agenda').hidden"));
  await click(win, '#btn-settings');
  await sleep(400);
  check('Ajustes mostra "Não conectado"', /Não conectado/.test(await js(win, "document.querySelector('#google-status').textContent")));
  await js(win, "(() => { document.querySelector('#set-g-id').value = 'errado'; document.querySelector('#set-g-secret').value = 'GOCSPX-segredo_do_cliente'; })()");
  await click(win, '#btn-g-connect');
  await sleep(400);
  check('credencial errada mostra o erro e não conecta', /ID do cliente parece errado/.test(await js(win, "document.querySelector('#google-msg').textContent")) && !googleOn);
  await js(win, "document.querySelector('#set-g-id').value = 'meu-app.apps.googleusercontent.com'");
  await click(win, '#btn-g-connect');
  await sleep(700);
  check('conecta e limpa os campos de credencial', googleOn && (await js(win, "document.querySelector('#set-g-id').value + document.querySelector('#set-g-secret').value")) === '' && /Conectado/.test(await js(win, "document.querySelector('#google-status').textContent")));
  check('botão Desconectar aparece', !(await js(win, "document.querySelector('#btn-g-disconnect').hidden")));
  await shot(win, '5-google-ajustes');
  await click(win, '#settings-close');
  await sleep(500);
  const painel = await js(win, "document.querySelector('#agenda').hidden ? '' : document.querySelector('#agenda').textContent");
  check('painel mostra os compromissos e as tarefas', /Reunião com o time/.test(painel) && /Aniversário da Ana/.test(painel) && /dia todo/.test(painel) && /Comprar pão/.test(painel), painel.slice(0, 120));
  await shot(win, '6-agenda');
  const spokenBrief = spoken.length;
  await click(win, '#btn-brief');
  await settle(60000);
  const dito = spoken.slice(spokenBrief);
  check('o resumo falado inclui a agenda e as tarefas', dito.some((t) => /Você tem 2 compromissos hoje/.test(t)) && dito.some((t) => /Reunião com o time, às 23 e 30/.test(t)) && dito.some((t) => /2 tarefas pendentes/.test(t)), JSON.stringify(dito.filter((t) => /compromiss|tarefa|às/.test(t))));
  await click(win, '#btn-settings');
  await sleep(300);
  await click(win, '#btn-g-disconnect');
  await sleep(500);
  check('desconectar esconde o painel', !googleOn && await js(win, "document.querySelector('#agenda').hidden"));
  await click(win, '#settings-close');
  await sleep(300);

  // ---- microfone bloqueado no Windows ----
  await click(win, '#btn-mic');   // desliga
  await sleep(500);
  await js(win, "(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('negado'), { name: 'NotAllowedError' })); })()");
  await click(win, '#btn-mic');
  await sleep(800);
  check('permissão negada explica como liberar', /Windows bloqueou o microfone/.test(await noticeText(win)) && (await js(win, "document.querySelector('#btn-mic').textContent")) === 'Escuta desligada', await noticeText(win));

  console.log(logs.length ? `Erros no console:\n${logs.join('\n')}` : 'Sem erros no console.');
  console.log(results.every(Boolean) ? 'TUDO OK' : 'HÁ FALHAS');
  app.exit(results.every(Boolean) ? 0 : 1);
});
