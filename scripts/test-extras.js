'use strict';
// Testes (sem rede) de lembretes, memória, programas, controle do Windows, clima por voz e as ferramentas novas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const reminders = require('../src/reminders');
const memory = require('../src/memory');
const apps = require('../src/apps');
const windows = require('../src/windows');
const feeds = require('../src/feeds');
const settingsMod = require('../src/settings');
const { createTools } = require('../src/tools');
const usage = require('../src/usage');
const background = require('../src/background');
const updaterMod = require('../src/updater');
const tts = require('../src/tts');
const crypto = require('node:crypto');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-x-'));

(async () => {
  // ---- lembretes com relógio falso ----
  {
    const dir = tmp();
    let t = 1_000_000_000_000;
    const fired = [];
    let pending = null;
    const opts = { onFire: (r) => fired.push(r), now: () => t, setTimer: (fn) => { pending = fn; return { unref() {} }; }, clearTimer: () => { pending = null; } };
    reminders.init(dir, opts);
    const r = reminders.addIn(10, 'tirar o macarrão', 'timer');
    assert.equal(r.at, t + 600000);
    assert.throws(() => reminders.addIn(0, 'x'), /minutos/);
    assert.throws(() => reminders.add({ text: '', at: t + 1000 }), /do que lembrar/);
    assert.throws(() => reminders.add({ text: 'x', at: t - 3600e3 }), /passou/);
    assert.throws(() => reminders.add({ text: 'x', at: t + 400 * 86400e3 }), /um ano/);
    t += 600000; pending();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].late, false);
    assert.equal(reminders.list().length, 0);
    // sobrevive a reiniciar e avisa atrasado
    reminders.add({ text: 'ligar pro Zé', at: t + 5000 });
    t += 3600e3;
    reminders.init(dir, opts);
    assert.equal(reminders.list().length, 1);
    pending();
    assert.equal(fired.length, 2);
    assert.equal(fired[1].late, true);
    // perdido há mais de 24 h é descartado
    reminders.add({ text: 'velho', at: t + 5000 });
    t += 3 * 86400e3;
    reminders.init(dir, opts);
    pending();
    assert.equal(fired.length, 2);
    // cancelar por pedaço do texto
    reminders.add({ text: 'Reunião com o João', at: t + 60000 });
    assert.equal(reminders.cancel('joao').text, 'Reunião com o João');
    assert.equal(reminders.cancel('nada'), null);
    // limite
    for (let i = 0; i < reminders.MAX_PENDING; i++) reminders.add({ text: `n${i}`, at: t + 60000 + i });
    assert.throws(() => reminders.add({ text: 'a mais', at: t + 99999 }), /demais/);
  }

  // ---- memória ----
  {
    const dir = tmp();
    memory.init(dir);
    assert.equal(memory.promptBlock('Axl'), '');
    const a = memory.add('O time do Axl é o Flamengo');
    assert.equal(memory.add('o time do axl é o flamengo!').duplicate, true);
    assert.equal(memory.list().length, 1);
    assert.match(memory.promptBlock('Axl'), /Flamengo/);
    memory.init(dir);
    assert.equal(memory.list().length, 1);
    assert.throws(() => memory.add('ab'), /guardar/);
    assert.equal(memory.remove('flamengo').id, a.id);
    assert.equal(memory.remove('flamengo'), null);
    for (let i = 0; i < memory.MAX_FACTS; i++) memory.add(`fato número ${i} abc`);
    assert.throws(() => memory.add('mais um fato'), /cheia/);
    memory.clear();
    assert.equal(memory.list().length, 0);
  }

  // ---- programas: só da lista ----
  {
    assert.ok(apps.isValidTarget('C:\\Program Files\\App\\app.exe'));
    assert.ok(apps.isValidTarget('https://exemplo.com/x'));
    assert.ok(apps.isValidTarget('spotify:'));
    for (const bad of ['calc.exe && del *', 'javascript:alert(1)', 'file:///C:/x.exe', 'C:\\x\\y.txt', 'C:\\a"b.exe', '', null, 'cmd /c dir']) assert.ok(!apps.isValidTarget(bad), String(bad));
    const calls = [];
    const openers = { openPath: async (p) => { calls.push(['path', p]); return ''; }, openExternal: async (u) => { calls.push(['ext', u]); } };
    assert.equal(await apps.open('Calculadora', [], openers), 'calculadora');
    assert.equal(await apps.open('configurações', [], openers), 'configurações');
    assert.deepEqual(calls, [['path', 'calc.exe'], ['ext', 'ms-settings:']]);
    await assert.rejects(apps.open('formatar disco', [], openers), /não está na lista/);
    await assert.rejects(apps.open('meu', [{ name: 'Meu', target: 'rm -rf /' }], openers), /não está na lista/);
    assert.equal(await apps.open('word', [{ name: 'Word', target: 'C:\\Office\\winword.exe' }], openers), 'Word');
    await assert.rejects(apps.open('calculadora', [], { openPath: async () => 'falhou', openExternal() {} }), /Não consegui abrir/);
    const s = settingsMod.sanitize({ apps: [{ name: 'Ok', target: 'C:\\a\\b.exe' }, { name: 'Mau', target: 'cmd /c x' }, null] });
    assert.deepEqual(s.apps, [{ name: 'Ok', target: 'C:\\a\\b.exe' }]);
  }

  // ---- Windows ----
  {
    const ran = [];
    const run = async (f, a) => { ran.push([f, a]); };
    await assert.rejects(windows.control('mudo', null, { platform: 'linux', run }), /Windows/);
    assert.equal(await windows.control('bloquear_tela', null, { platform: 'win32', run }), 'Bloqueei a tela.');
    assert.equal(ran[0][0], 'rundll32.exe');
    await windows.control('volume', 40, { platform: 'win32', run });
    assert.match(ran[1][1][3], /1\.\.20/);
    await assert.rejects(windows.control('volume', '1; calc', { platform: 'win32', run }), /0 a 100/);
    await assert.rejects(windows.control('desligar', null, { platform: 'win32', run }), /Não sei/);
    assert.equal(ran.length, 2);
  }

  // ---- previsão (servidor falso) ----
  {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ current: { temperature_2m: 29.6, weather_code: 2 }, daily: { time: ['2026-10-03', '2026-10-04'], weather_code: [2, 61], temperature_2m_max: [31, 28], temperature_2m_min: [24, 23], precipitation_probability_max: [10, 80] } }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    feeds.ENDPOINTS.forecast = `http://127.0.0.1:${srv.address().port}/f`;
    const f = await feeds.getForecast(-5.6, -35.2, 2);
    assert.equal(f.days.length, 2);
    assert.equal(f.days[1].rain, 80);
    await assert.rejects(feeds.getForecast('x', 1), /inválidas/);

    // ---- ferramentas ----
    const dir = tmp();
    let t = 1_700_000_000_000;
    reminders.init(dir, { now: () => t, onFire() {}, setTimer: () => ({ unref() {} }), clearTimer() {} });
    memory.init(dir);
    const opened = [];
    const tools = createTools({
      web: async (q) => `busca: ${q}`, isGoogleConnected: () => false, isSpotifyConnected: () => false,
      settings: () => ({ webSearch: true, city: { name: 'Ceará-Mirim', lat: -5.6, lon: -35.2 }, apps: [] }),
      reminders, memory, apps, windows, weather: feeds.getForecast,
      openers: { openPath: async (p) => { opened.push(p); return ''; }, openExternal: async (u) => { opened.push(u); } },
    });
    const names = tools.definitions().map((d) => d.function.name);
    for (const n of ['lembrete_criar', 'lembretes_listar', 'lembrete_cancelar', 'memoria_guardar', 'memoria_esquecer', 'clima', 'noticias', 'abrir_programa']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('windows_controlar') || process.platform === 'win32');
    const prog = tools.definitions().find((d) => d.function.name === 'abrir_programa');
    assert.ok(prog.function.parameters.properties.nome.enum.includes('calculadora'));
    assert.match(await tools.run('lembrete_criar', { texto: 'macarrão', em_minutos: 10 }), /Timer criado/);
    assert.match(await tools.run('lembretes_listar', {}), /macarrão/);
    assert.match(await tools.run('lembrete_criar', { texto: 'x' }), /Não deu certo/);
    assert.match(await tools.run('lembrete_cancelar', { referencia: 'macarr' }), /Cancelei/);
    assert.match(await tools.run('memoria_guardar', { fato: 'Axl torce pelo Flamengo' }), /Guardado/);
    assert.match(await tools.run('memoria_guardar', { fato: 'axl torce pelo flamengo' }), /já sabia/);
    assert.match(await tools.run('memoria_esquecer', { referencia: 'flamengo' }), /Esqueci/);
    const clima = await tools.run('clima', { dias: 2 });
    assert.match(clima, /Ceará-Mirim: 30 graus, parcialmente nublado/);
    assert.match(clima, /amanhã: chuva fraca/);
    assert.match(await tools.run('noticias', { assunto: 'futebol' }), /futebol/);
    assert.match(await tools.run('abrir_programa', { nome: 'calculadora' }), /Abri calculadora/);
    assert.match(await tools.run('abrir_programa', { nome: 'powershell' }), /Não deu certo/);
    assert.deepEqual(opened, ['calc.exe']);
    assert.ok(tools.capabilities().some((c) => /lembretes/.test(c)));
    srv.close();
  }
  // ---- contador de uso do Whisper ----
  {
    const dir = tmp();
    let t = 1_700_000_000_000;
    usage.init(dir, { now: () => t });
    assert.equal(usage.warning(), '');
    usage.recordStt(32000 * 3);          // 3 s -> cobra o mínimo de 10 s
    assert.equal(usage.stats().daySeconds, 10);
    usage.recordStt(32000 * 25);
    assert.equal(usage.stats().daySeconds, 35);
    assert.match(usage.summary(), /2 de 2000 pedidos/);
    for (let i = 0; i < 700; i++) usage.recordStt(32000 * 10);   // 7.000 s na última hora
    assert.match(usage.warning(), /por hora/);
    usage.init(dir, { now: () => t });   // persiste
    assert.equal(usage.stats().dayRequests, 702);
    t += 2 * 3600e3;
    assert.equal(usage.stats().hourSeconds, 0);
    assert.equal(usage.warning(), '');
    for (let i = 0; i < 1300; i++) usage.recordStt(32000 * 10);
    assert.match(usage.warning(), /cota diária/);
    t += 25 * 3600e3;
    assert.equal(usage.stats().dayRequests, 0);
  }

  // ---- pré-aquecer o cache de voz: o que já está em disco não vai à rede ----
  {
    const dir = tmp();
    tts.init(dir);
    const phrase = 'Pois não?';
    const key = crypto.createHash('sha1').update([phrase, 'pt-BR-AntonioNeural', 0, 0].join('|')).digest('hex');
    fs.writeFileSync(path.join(dir, `${key}.mp3`), Buffer.from([1, 2, 3]));
    assert.equal(await tts.prewarm([phrase], { voice: 'pt-BR-AntonioNeural', rate: 0, pitch: 0 }), 0);
    assert.equal(await tts.prewarm(['outra'], { voice: 'pt-BR-AntonioNeural' }, { shouldStop: () => true }), 0);
    assert.deepEqual([...(await tts.synthesize({ text: phrase, voice: 'pt-BR-AntonioNeural' }))], [1, 2, 3]);
  }
  // ---- segundo plano (peças do Electron falsas) ----
  {
    const mkWin = () => { const w = { visible: true, min: false, calls: [], isDestroyed: () => false, isVisible: () => w.visible, isMinimized: () => w.min, restore() { w.min = false; }, show() { w.visible = true; w.calls.push('show'); }, hide() { w.visible = false; w.calls.push('hide'); }, focus() {} }; return w; };
    const w = mkWin();
    const reg = {}; const sent = []; let quitCalled = 0; let menu = null; let trayClick = null; const logs = [];
    class FakeTray { constructor() {} setToolTip() {} setContextMenu(m) { menu = m; } on(ev, fn) { if (ev === 'click') trayClick = fn; } destroy() { this.dead = true; } }
    const cfg = { backgroundMode: true };
    const bg = background.create({
      Tray: FakeTray, Menu: { buildFromTemplate: (t) => t }, nativeImage: { createFromPath: () => ({}) },
      globalShortcut: { register: (a, fn) => { reg[a] = fn; return a !== 'Control+Alt+M'; }, unregisterAll() { reg.cleared = true; } },
      iconPath: 'x.png', getWin: () => w, send: (c) => sent.push(c), quit: () => { quitCalled++; }, settings: () => cfg, log: (k, t) => logs.push(t),
    });
    bg.start();
    assert.ok(bg.hasTray);
    assert.ok(logs.some((l) => /Control\+Alt\+M.*em uso/.test(l)));
    let prevented = 0;
    assert.equal(bg.onClose({ preventDefault: () => { prevented++; } }), true);   // fechar só esconde
    assert.equal(prevented, 1);
    assert.equal(w.visible, false);
    bg.show({ byWake: true });                                                     // "Jarvis" chama
    assert.equal(w.visible, true);
    bg.conversationEnded();
    assert.equal(w.visible, false);                                                // some sozinho depois
    bg.show();                                                                     // aberto pelo usuário: não esconde sozinho
    bg.conversationEnded();
    assert.equal(w.visible, true);
    reg['Control+Alt+J']();
    assert.equal(w.visible, false);
    trayClick();
    assert.equal(w.visible, true);
    menu.find((i) => /escuta/.test(i.label ?? '')).click();
    assert.deepEqual(sent, ['cmd:toggle-listen']);
    cfg.backgroundMode = false;
    assert.equal(bg.onClose({ preventDefault: () => { prevented++; } }), false);   // modo desligado: fecha de verdade
    assert.equal(prevented, 1);
    cfg.backgroundMode = true;
    menu.find((i) => /Fechar/.test(i.label ?? '')).click();
    assert.equal(quitCalled, 1);
    assert.equal(bg.onClose({ preventDefault: () => { prevented++; } }), false);   // saindo: não segura
    bg.stop();
    assert.ok(reg.cleared);
  }
  // ---- atualizador ----
  {
    const logs = []; let checks = 0;
    const handlers = {};
    const fake = { on: (e, f) => { handlers[e] = f; }, checkForUpdates: async () => { checks++; } };
    const mk = (over) => updaterMod.create({ isPackaged: true, settings: () => ({ autoUpdate: true }), log: (k, t) => logs.push(t), load: () => fake, ...over });
    assert.equal(await mk({ isPackaged: false }).check(), 'desligado');
    assert.equal(await mk({ settings: () => ({ autoUpdate: false }) }).check(), 'desligado');
    assert.equal(checks, 0);
    assert.equal(await mk().check(), 'ok');
    assert.equal(checks, 1);
    handlers['update-downloaded']({ version: '1.2.0' });
    assert.ok(logs.some((l) => /1\.2\.0 baixada/.test(l)));
    const failing = { on() {}, checkForUpdates: async () => { throw new Error('404 Not Found\nmais coisa'); } };
    assert.equal(await mk({ load: () => failing }).check(), 'erro');
    assert.ok(logs.some((l) => l === 'atualização: 404 Not Found'));
    assert.equal(await mk({ load: () => { throw new Error('módulo ausente'); } }).check(), 'erro');
  }
  console.log('extras: todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
