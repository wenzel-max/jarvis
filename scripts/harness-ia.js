'use strict';
// Harness da interface de perguntas: Electron real, IPC simulado (sem rede), capturas em scripts/out/.
// Uso: xvfb-run -a npx electron scripts/harness-ia.js
const { app, BrowserWindow, ipcMain } = require('electron');

// Microfone falso do Chromium (gera bipes) e permissão automática.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = {
  userName: 'Axl', userNameSpoken: '', voice: 'pt-BR-AntonioNeural', rate: 0, pitch: 0,
  city: { name: 'Natal', admin: 'Rio Grande do Norte', lat: -5.79, lon: -35.2 },
  autostart: false, startDelaySec: 0, speakOnStart: false, fullscreen: false, aiModel: 'llama-3.1-8b-instant',
  feeds: [{ name: 'G1', url: 'https://g1.globo.com/rss/g1/' }],
};
let mode = 'ok';
const asked = [];
const heard = [];
let sttMode = 'ok';

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
  ipcMain.handle('ai:key-status', () => ({ hasKey: mode !== 'nokey' }));
  ipcMain.handle('ai:key-set', (_e, k) => (k.length < 20 ? { ok: false, error: 'A chave tem formato inválido.' } : { ok: true, hasKey: true }));
  ipcMain.handle('stt:transcribe', (_e, req) => {
    heard.push({ bytes: req.audio?.byteLength ?? req.audio?.length ?? 0, mime: req.mime });
    return sttMode === 'ok' ? { text: 'Que horas são?', model: 'whisper-large-v3-turbo' } : { error: 'Não entendi o que você disse. Tente falar mais perto do microfone.' };
  });
  ipcMain.handle('ai:cancel', () => {});
  ipcMain.handle('ai:ask', async (e, req) => {
    asked.push({ q: req.question, hist: req.history?.length ?? 0 });
    await sleep(900); // "pensando"
    if (mode === 'error') return { error: 'A chave do Groq foi recusada. Confira a chave em Ajustes.' };
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

async function ask(win, q) {
  await js(win, `(() => { const i = document.querySelector('#ask-input'); i.value = ${JSON.stringify(q)}; document.querySelector('#ask-form').requestSubmit(); })()`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fakeIpc();
  const win = new BrowserWindow({
    width: 1366, height: 768, show: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  const logs = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) logs.push(msg); });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await sleep(3500);
  const results = [];
  const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name} ${extra}`); };

  await js(win, `window.__seen = { states: [], captions: [] };
    new MutationObserver(() => { const st = document.querySelector('#hud').dataset.state; const s = window.__seen.states; if (s[s.length - 1] !== st) s.push(st); })
      .observe(document.querySelector('#hud'), { attributes: true, attributeFilter: ['data-state'] });
    new MutationObserver(() => window.__seen.captions.push(document.querySelector('#caption').textContent))
      .observe(document.querySelector('#caption'), { childList: true, characterData: true, subtree: true });`);
  await shot(win, '1-repouso');

  // 1) pergunta com sucesso
  await ask(win, 'Como está o tempo em Natal?');
  await sleep(300);
  check('estado pensando logo após perguntar', (await state(win)) === 'thinking', await state(win));
  check('campo desabilitado enquanto responde', await js(win, "document.querySelector('#ask-input').disabled"));
  await shot(win, '2-pensando');
  await sleep(1800);
  for (let i = 0; i < 40 && (await state(win)) !== 'idle'; i++) await sleep(500);
  const seen = await js(win, 'window.__seen');
  check('passou por pensando -> falando -> ocioso', seen.states.join('>').includes('thinking>speaking>idle'), seen.states.join('>'));
  check('legenda mostrou as duas frases da resposta', seen.captions.some((c) => /vinte e oito/.test(c)) && seen.captions.some((c) => /quarenta e cinco/.test(c)), JSON.stringify(seen.captions));
  check('volta ao repouso no fim', (await state(win)) === 'idle', await state(win));
  check('campo reabilitado', !(await js(win, "document.querySelector('#ask-input').disabled")));

  // 2) segunda pergunta leva o histórico
  await ask(win, 'E amanhã?');
  await sleep(300);
  for (let i = 0; i < 40 && (await state(win)) !== 'idle'; i++) await sleep(500);
  check('histórico enviado na segunda pergunta', asked[1]?.hist === 2, JSON.stringify(asked));

  // 3) erro antes de falar
  mode = 'error';
  await ask(win, 'Teste de erro');
  await sleep(1800);
  check('erro aparece na legenda e volta ao repouso', /chave do Groq foi recusada/.test(await caption(win)) && (await state(win)) === 'idle', `${await state(win)} | ${await caption(win)}`);
  check('campo reabilitado após erro', !(await js(win, "document.querySelector('#ask-input').disabled")));
  await shot(win, '4-erro');

  // 4) Ajustes
  await js(win, "document.querySelector('#btn-settings').click()");
  await sleep(500);
  await shot(win, '5-ajustes');
  await js(win, "(() => { document.querySelector('#set-ai-key').value = 'curta'; document.querySelector('#btn-ai-key').click(); })()");
  await sleep(300);
  check('chave inválida mostra o erro', /formato inválido/.test(await js(win, "document.querySelector('#ai-msg').textContent")));

  // 5) voz de entrada: grava com o microfone falso, termina manualmente e a pergunta segue o fluxo normal
  await js(win, "document.querySelector('#btn-settings').click()"); // fecha os Ajustes (alterna)
  await sleep(300);
  mode = 'ok';
  const before = asked.length;
  await js(win, "document.querySelector('#ask-mic').click()");
  await sleep(2500);
  check('estado ouvindo com o microfone aberto', (await state(win)) === 'listening', await state(win));
  check('botão vira "Terminei"', (await js(win, "document.querySelector('#ask-mic').textContent")) === 'Terminei');

  await shot(win, '6-ouvindo');
  await js(win, "document.querySelector('#ask-mic').click()"); // Terminei
  for (let i = 0; i < 30 && asked.length === before; i++) await sleep(300);
  check('áudio enviado para transcrição', heard.length === 1 && heard[0].bytes > 500 && /webm|ogg/.test(heard[0].mime), JSON.stringify(heard));
  check('texto reconhecido virou pergunta', asked.at(-1)?.q === 'Que horas são?', JSON.stringify(asked.at(-1)));
  for (let i = 0; i < 40 && (await state(win)) !== 'idle'; i++) await sleep(500);
  check('botão volta a "Falar" e campo livre', (await js(win, "document.querySelector('#ask-mic').textContent")) === 'Falar' && !(await js(win, "document.querySelector('#ask-input').disabled")));

  // 6) fala não entendida
  sttMode = 'fail';
  await js(win, "document.querySelector('#ask-mic').click()");
  await sleep(2200);
  await js(win, "document.querySelector('#ask-mic').click()");
  await sleep(1200);
  check('fala não entendida mostra aviso e volta ao repouso', /Não entendi/.test(await caption(win)) && (await state(win)) === 'idle', `${await state(win)} | ${await caption(win)}`);

  // 7) cancelar com Esc durante a escuta
  await js(win, "document.querySelector('#ask-mic').click()");
  await sleep(1000);
  await js(win, "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await sleep(700);
  check('Esc cancela a escuta', (await state(win)) === 'idle' && (await js(win, "document.querySelector('#ask-mic').textContent")) === 'Falar' && heard.length === 2, `${await state(win)} heard=${heard.length}`);

  // 7b) botão "Testar microfone" nos Ajustes: abre, mede por 4 s e explica o resultado
  await js(win, "document.querySelector('#btn-settings').click()");
  await sleep(400);
  await js(win, "document.querySelector('#set-mic-compat').click()");
  await sleep(300);
  check('modo de compatibilidade salva e oferece reiniciar', settings.micCompat === true && !(await js(win, "document.querySelector('#compat-restart').hidden")), String(settings.micCompat));
  await js(win, "document.querySelector('#set-mic-compat').click()");
  await sleep(200);
  check('seletor de microfone tem a opção automática', /^Automático/.test(await js(win, "document.querySelector('#set-mic option').textContent")));
  await js(win, "document.querySelector('#btn-mic-test').click()");
  await sleep(600);
  check('teste do microfone mostra "Fale agora"', (await js(win, "document.querySelector('#btn-mic-test').textContent")) === 'Fale agora…');
  await sleep(5000);
  const micMsg = await js(win, "document.querySelector('#mic-msg').textContent");
  check('teste do microfone informa o nível medido', /nível máximo \d+%/.test(micMsg), micMsg);
  check('botão volta ao normal e estado ocioso', (await js(win, "document.querySelector('#btn-mic-test').textContent")) === 'Testar microfone' && (await state(win)) === 'idle');
  await js(win, "document.querySelector('#settings-close').click()");
  await sleep(300);

  // 8) microfone bloqueado no Windows
  await js(win, "(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('negado'), { name: 'NotAllowedError' })); })()");
  await js(win, "document.querySelector('#ask-mic').click()");
  await sleep(600);
  check('permissão negada explica como liberar', /Windows bloqueou o microfone/.test(await caption(win)) && (await state(win)) === 'idle' && !(await js(win, "document.querySelector('#ask-input').disabled")), await caption(win));
  await shot(win, '7-mic-bloqueado');

  console.log(logs.length ? `Erros no console:\n${logs.join('\n')}` : 'Sem erros no console.');
  console.log(results.every(Boolean) ? 'TUDO OK' : 'HÁ FALHAS');
  app.exit(results.every(Boolean) ? 0 : 1);
});
