'use strict';
// Harness da interface por voz: Electron real, IPC simulado (sem rede), microfone sintético
// que eu controlo (window.__say(ms) liga um tom pelo tempo pedido) e capturas em scripts/out/.
// Uso: xvfb-run -a npx electron --no-sandbox scripts/harness-ia.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = {
  userName: 'Axl', userNameSpoken: '', voice: 'pt-BR-AntonioNeural', rate: 0, pitch: 0,
  city: { name: 'Natal', admin: 'Rio Grande do Norte', lat: -5.79, lon: -35.2 },
  autostart: false, startDelaySec: 0, speakOnStart: false, fullscreen: false, listenOnStart: false,
  aiModel: 'llama-3.1-8b-instant', sttModel: 'whisper-large-v3-turbo', micLabel: '', micCompat: false,
  feeds: [{ name: 'G1', url: 'https://g1.globo.com/rss/g1/' }],
};
let aiMode = 'ok';
const asked = [];     // perguntas que chegaram à IA
const heard = [];     // trechos de áudio enviados para transcrição
const sttScript = []; // o que o "Whisper" devolve, na ordem: texto, ou { error }

function fakeIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, p) => Object.assign(settings, p));
  ipcMain.handle('tts:voices', () => []);
  ipcMain.handle('tts:synthesize', () => { throw new Error('sem rede (simulado)'); });
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
  ipcMain.handle('stt:transcribe', (_e, req) => {
    const bytes = req.audio?.byteLength ?? req.audio?.length ?? 0;
    heard.push({ bytes, mime: req.mime });
    const next = sttScript.shift();
    if (next === undefined) return { error: 'Não entendi o que você disse. Tente falar mais perto do microfone.' };
    return typeof next === 'string' ? { text: next, model: 'whisper-large-v3-turbo' } : next;
  });
  ipcMain.handle('ai:cancel', () => {});
  ipcMain.handle('ai:ask', async (e, req) => {
    asked.push({ q: req.question, hist: req.history?.length ?? 0 });
    await sleep(900); // "pensando"
    if (aiMode === 'error') return { error: 'A chave do Groq foi recusada. Confira a chave em Ajustes.' };
    const parts = ['Em Natal faz vinte e oito graus agora, com o céu nublado.', 'A chance de chuva hoje é de quarenta e cinco por cento.'];
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
const caption = (win) => js(win, "document.querySelector('#caption').textContent");
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
  window.__say = (ms) => new Promise((r) => { gain.gain.value = 0.3; setTimeout(() => { gain.gain.value = 0; r(); }, ms); });
  navigator.mediaDevices.getUserMedia = async () => dest.stream.clone();   // um microfone real entrega um stream novo a cada abertura
  navigator.mediaDevices.enumerateDevices = async () => [];
  window.__seen = { states: [], captions: [] };
  new MutationObserver(() => { const st = document.querySelector('#hud').dataset.state; const s = window.__seen.states; if (s[s.length - 1] !== st) s.push(st); })
    .observe(document.querySelector('#hud'), { attributes: true, attributeFilter: ['data-state'] });
  new MutationObserver(() => window.__seen.captions.push(document.querySelector('#caption').textContent))
    .observe(document.querySelector('#caption'), { childList: true, characterData: true, subtree: true });
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
  const seenReset = () => js(win, 'window.__seen = { states: window.__seen.states.slice(-1), captions: [] }');
  const seen = () => js(win, 'window.__seen');
  // espera o Jarvis voltar ao repouso e o microfone voltar a ouvir (700 ms depois)
  const settle = async (max = 25000) => {
    const t0 = Date.now();
    await sleep(600);
    while (Date.now() - t0 < max && (await state(win)) !== 'idle') await sleep(250);
    await sleep(1100);
  };
  // fala (tom) e espera a frase ser fechada pelo silêncio + processada
  const speakAndWait = async (ms, extra = 2600) => { await js(win, `window.__say(${ms})`); await sleep(extra); };

  // ---- sem caixa de digitar ----
  check('não existe mais caixa de digitar', !(await js(win, "!!document.querySelector('#ask-input') || !!document.querySelector('#ask-form')")));
  await shot(win, '1-repouso');

  // ---- ligar a escuta ----
  check('começa com a escuta desligada', (await js(win, "document.querySelector('#btn-mic').textContent")) === 'Escuta desligada');
  await click(win, '#btn-mic');
  await sleep(1500);
  check('botão vira "Escuta ligada"', (await js(win, "document.querySelector('#btn-mic').textContent")) === 'Escuta ligada');
  check('status pede para dizer "Jarvis"', /diga "Jarvis"/.test(await status(win)), await status(win));
  await shot(win, '2-escutando');

  // ---- conversa ao redor (sem o nome) é ignorada ----
  sttScript.push('Que horas são?');
  await speakAndWait(1200);
  check('fala sem o nome é transcrita mas ignorada', heard.length === 1 && asked.length === 0 && (await state(win)) === 'idle', `heard=${heard.length} asked=${asked.length} estado=${await state(win)}`);
  check('áudio enviado como WAV 16 kHz', heard[0]?.mime === 'audio/wav' && heard[0].bytes > 20000, JSON.stringify(heard[0]));

  // ---- barulho curto não vira transcrição ----
  await speakAndWait(150, 1800);
  check('estalo curto nem chega a ser transcrito', heard.length === 1, `heard=${heard.length}`);

  // ---- chamando pelo nome ----
  sttScript.push('Jarvis, como está o tempo em Natal?');
  await seenReset();
  await speakAndWait(1400, 1500);
  await shot(win, '3-pensando-ou-falando');
  await settle();
  const s1 = await seen();
  check('"Jarvis, ..." chega à IA sem o nome', asked.at(-1)?.q === 'como está o tempo em Natal?', JSON.stringify(asked.at(-1)));
  check('ouvindo -> pensando -> falando -> repouso', /listening>thinking>speaking>idle/.test(s1.states.join('>')), s1.states.join('>'));
  check('legenda mostra as frases da resposta', s1.captions.some((c) => /vinte e oito/.test(c)) && s1.captions.some((c) => /quarenta e cinco/.test(c)));
  check('depois da resposta a conversa continua aberta', /Pode continuar falando/.test(await status(win)), await status(win));

  // ---- continua sem precisar repetir o nome ----
  sttScript.push('E amanhã?');
  await speakAndWait(1000, 1500);
  await settle();
  check('segunda pergunta sem dizer "Jarvis"', asked.at(-1)?.q === 'E amanhã?' && asked.at(-1).hist === 2, JSON.stringify(asked.at(-1)));

  // ---- não entendeu na conversa: pede para repetir sozinho ----
  await seenReset();
  sttScript.push({ error: 'Não entendi o que você disse. Tente falar mais perto do microfone.' });
  await speakAndWait(1000, 1500);
  await settle();
  const s2 = await seen();
  check('"não entendi" -> Jarvis pede para repetir', s2.captions.some((c) => /Não entendi, pode repetir/.test(c)), JSON.stringify(s2.captions));
  check('e continua ouvindo, sem apertar nada', /Pode continuar falando/.test(await status(win)), await status(win));
  sttScript.push('Qual é a capital do Brasil?');
  await speakAndWait(1000, 1500);
  await settle();
  check('repetindo, ele responde normalmente', asked.at(-1)?.q === 'Qual é a capital do Brasil?', JSON.stringify(asked.at(-1)));

  // ---- só chamou o nome ----
  await seenReset();
  sttScript.push('Jarvis');
  await speakAndWait(900, 1500);
  await settle();
  check('só "Jarvis" -> "Pois não?"', (await seen()).captions.some((c) => /Pois não\?/.test(c)));

  // ---- o Jarvis não ouve a própria voz ----
  sttScript.push('Jarvis, qual é o seu nome?');
  await js(win, 'window.__say(1000)');
  for (let i = 0; i < 40 && (await state(win)) !== 'thinking'; i++) await sleep(150);
  const before = heard.length;
  await js(win, 'window.__say(700)');      // alguém (ou o eco) fala por cima enquanto o Jarvis pensa
  await settle();
  check('microfone fica mudo enquanto o Jarvis pensa e fala', heard.length === before && asked.at(-1)?.q === 'qual é o seu nome?', `transcrições durante: ${heard.length - before}`);

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

  // ---- erro de chave durante a escuta: avisa na legenda ----
  sttScript.push({ error: 'A chave do Groq foi recusada. Confira a chave em Ajustes.' });
  await speakAndWait(1200);
  check('erro de configuração aparece na legenda', /chave do Groq foi recusada/.test(await caption(win)) && (await state(win)) === 'idle', await caption(win));
  await shot(win, '4-erro');

  // ---- erro da IA depois de chamar o nome ----
  aiMode = 'error';
  await settle();
  sttScript.push('Jarvis, teste de erro');
  await speakAndWait(1200, 1500);
  await settle();
  check('erro da IA aparece na legenda e volta ao repouso', /chave do Groq foi recusada/.test(await caption(win)) && (await state(win)) === 'idle', `${await state(win)} | ${await caption(win)}`);
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
  check('teste não desliga a escuta que já estava ligada', (await js(win, "document.querySelector('#btn-mic').textContent")) === 'Escuta ligada');
  await shot(win, '5-ajustes');
  await click(win, '#settings-close');
  await sleep(300);

  // ---- microfone bloqueado no Windows ----
  await click(win, '#btn-mic');   // desliga
  await sleep(500);
  await js(win, "(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('negado'), { name: 'NotAllowedError' })); })()");
  await click(win, '#btn-mic');
  await sleep(800);
  check('permissão negada explica como liberar', /Windows bloqueou o microfone/.test(await caption(win)) && (await js(win, "document.querySelector('#btn-mic').textContent")) === 'Escuta desligada', await caption(win));
  await shot(win, '6-mic-bloqueado');

  console.log(logs.length ? `Erros no console:\n${logs.join('\n')}` : 'Sem erros no console.');
  console.log(results.every(Boolean) ? 'TUDO OK' : 'HÁ FALHAS');
  app.exit(results.every(Boolean) ? 0 : 1);
});
