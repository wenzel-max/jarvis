// Microfone: grava uma fala e para sozinho quando você fica em silêncio.
// Também mede o volume (0..1) para a esfera pulsar enquanto o Jarvis ouve.

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const POLL_MS = 50;
const NOISE_CALIBRATION_MS = 350;  // mede o ruído do ambiente antes de decidir o que é voz
const MIN_SPEECH_MS = 300;         // menos que isso é estalo ou tosse, não fala
const MAX_CANDIDATES = 8;

// Microfones virtuais (Steam, mesa de som, OBS...) abrem sem erro mas só entregam silêncio.
const VIRTUAL = /steam|virtual|vb-audio|voicemeeter|cable|obs\b|nvidia broadcast|stereo mix|mixagem|loopback|blackhole|soundflower/i;
const ALIASES = new Set(['default', 'communications']);

/** Tira o prefixo que o Chromium põe nos atalhos ("Default - ", "Communications - "). */
export const cleanLabel = (label) => (label || '').replace(/^(default|communications|padrão|comunicações)\s+-\s+/i, '').trim();

/** Lista as entradas de áudio. Os nomes só aparecem depois que o microfone foi aberto uma vez. */
export async function listMicrophones() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const seen = new Set();
    return all
      .filter((d) => d.kind === 'audioinput' && d.deviceId && !seen.has(d.deviceId) && seen.add(d.deviceId))
      .map((d) => ({ id: d.deviceId, label: d.label || '', alias: ALIASES.has(d.deviceId), virtual: VIRTUAL.test(d.label || '') }));
  } catch {
    return [];
  }
}

/** Ordem de tentativa: o escolhido, microfones reais, atalhos do sistema, virtuais por último. */
function rank(d, preferred) {
  if (preferred && cleanLabel(d.label).toLowerCase().includes(preferred.toLowerCase())) return d.alias ? 0.5 : 0;
  if (d.alias) return d.virtual ? 4 : 2;
  return d.virtual ? 3 : 1;
}

/** Resumo do que foi tentado em cada dispositivo, para as mensagens de erro. */
export function describeReport(report) {
  if (!report?.length) return '';
  return report
    .map((r) => `${cleanLabel(r.label) || 'padrão'}: ${r.ok ? 'abriu' : `recusou (${r.why})`}`)
    .join('; ');
}

/** Mensagens em português para os erros de acesso ao microfone. */
export function micErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'O Windows bloqueou o microfone. Ative em Configurações, Privacidade e segurança, Microfone, e permita apps da área de trabalho.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Não encontrei nenhum microfone. Conecte um e tente de novo.';
    case 'NotReadableError': {
      const tried = describeReport(err.report);
      return `Não consegui abrir o microfone, mesmo tentando todas as formas. Feche programas que possam estar usando, como Discord, Teams ou chamadas no navegador.${tried ? ` Tentei: ${tried}.` : ''} Detalhe técnico: ${err.message || 'sem detalhe'}`;
    }
    default:
      return 'Não consegui usar o microfone. Tente de novo.';
  }
}

/** Volume em % (0..100) a partir do rms, na mesma escala da esfera. */
const pct = (rms) => Math.round(Math.min(1, rms * 5) * 100);

/** Explica, com os números medidos, por que não houve fala. */
export function explainNoSpeech(stats, report) {
  if (!stats) return 'Não ouvi nada. Aperte Falar e tente de novo.';
  const dev = stats.label ? `"${cleanLabel(stats.label)}"` : 'o microfone';
  const tried = describeReport(report);
  const extra = tried ? ` Dispositivos testados: ${tried}.` : '';
  if (stats.peak < 0.003) {
    const virtual = VIRTUAL.test(stats.label || '') ? ' Esse é um microfone virtual, que não capta som: escolha o microfone real em Ajustes.' : '';
    return `O Jarvis abriu ${dev}, mas só chegou silêncio (nível ${pct(stats.peak)}%).${virtual} Veja se o microfone não está mudo (tecla do notebook, Configurações, Sistema, Som, Entrada) e se o volume de entrada está alto.${extra}`;
  }
  return `O Jarvis abriu ${dev}, mas o volume ficou baixo (nível máximo ${pct(stats.peak)}%). Fale mais perto e mais alto e tente de novo.${extra}`;
}

export class Mic {
  constructor() {
    this.level = 0;      // volume atual, 0..1
    this.stats = null;   // da última gravação: { label, peak, speechMs }
    this.report = [];    // o que foi tentado em cada dispositivo na última abertura
    this.preferred = ''; // parte do nome do microfone escolhido pelo usuário ('' = automático)
    this.active = false;
    this._finish = null;
    this._cancel = null;
  }

  /**
   * Abre o microfone. Drivers como o "Grupo de microfones" da Intel Smart Sound recusam a
   * configuração padrão do navegador (NotReadableError), e o "padrão" do Windows às vezes é um
   * microfone virtual mudo. Por isso: abre o padrão (isso revela os nomes), ordena os
   * dispositivos (reais antes de virtuais) e tenta cada um com várias configurações.
   */
  async _open() {
    const report = [];
    this.report = report;
    const gum = (audio) => navigator.mediaDevices.getUserMedia({ audio });
    const fatal = (err) => err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    const why = (err) => `${err?.name ?? 'erro'}${err?.message ? `: ${err.message}` : ''}`;
    let firstError = null;

    // 0) o padrão do sistema: dá a permissão e revela os nomes dos dispositivos
    let fallback = null;
    for (const c of [{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, true]) {
      try {
        fallback = await gum(c);
        break;
      } catch (err) {
        firstError ??= err;
        if (fatal(err)) throw err;
        console.warn('[microfone] padrão recusado:', err?.name, err?.message);
      }
    }
    const fallbackLabel = cleanLabel(fallback?.getAudioTracks()[0]?.label);
    if (fallback) report.push({ label: fallbackLabel || 'padrão', ok: true });
    else report.push({ label: 'padrão', ok: false, why: why(firstError) });

    // 1) o melhor candidato; se o padrão que abriu já é ele, acabou
    const ordered = (await listMicrophones())
      .map((d) => ({ d, r: rank(d, this.preferred) }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.d)
      .slice(0, MAX_CANDIDATES);
    if (fallback && (!ordered.length || cleanLabel(ordered[0].label) === fallbackLabel)) return fallback;

    // 2) tenta cada dispositivo, do melhor para o pior
    for (const d of ordered) {
      if (fallback && cleanLabel(d.label) === fallbackLabel) continue;   // já sabemos que abre
      const exact = { deviceId: { exact: d.id } };
      const variants = [exact, { ...exact, channelCount: 1 }, { ...exact, channelCount: 2 },
        { ...exact, sampleRate: 48000 }, { ...exact, sampleRate: 44100 }, { ...exact, sampleRate: 16000, channelCount: 1 }];
      let lastError = null;
      for (const v of variants) {
        try {
          const stream = await gum(v);
          fallback?.getTracks().forEach((t) => t.stop());
          report.push({ label: d.label, ok: true });
          return stream;
        } catch (err) {
          firstError ??= err;
          lastError = err;
          if (fatal(err)) throw err;
        }
      }
      report.push({ label: d.label, ok: false, why: why(lastError) });
    }

    if (fallback) return fallback;
    const error = firstError ?? new Error('Nenhum microfone disponível.');
    error.report = report;
    throw error;
  }

  /** Para de gravar agora e entrega o que foi dito até aqui. */
  finish() { this._finish?.(); }

  /** Descarta a gravação. */
  cancel() { this._cancel?.(); }

  /**
   * Grava até o silêncio. Devolve { buffer, mime } ou null se não houve fala (ou foi cancelado).
   * Lança o erro do getUserMedia se o microfone não puder ser usado.
   */
  async record({ maxMs = 15000, noSpeechMs = 7000, silenceMs = 1300 } = {}) {
    if (this.active) return null;
    const stream = await this._open();
    this.active = true;
    const stats = { label: stream.getAudioTracks()[0]?.label ?? '', peak: 0, speechMs: 0 };
    this.stats = stats;

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);

    const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const t0 = performance.now();
    let floor = Infinity;               // ruído de fundo: o MENOR volume dos primeiros instantes
    let speechMs = 0, lastVoice = 0, spoke = false;
    let cancelled = false;
    let timer = null;

    const done = new Promise((resolve) => {
      rec.onstop = () => resolve();
    });
    const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    this._finish = stop;
    this._cancel = () => { cancelled = true; stop(); };

    const poll = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const b of samples) { const v = (b - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / samples.length);
      this.level = Math.min(1, rms * 5);
      stats.peak = Math.max(stats.peak, rms);

      const now = performance.now();
      const elapsed = now - t0;
      if (elapsed < NOISE_CALIBRATION_MS) {
        floor = Math.min(floor, rms);   // se você já começou a falar, as pausas entre palavras ainda contam
        return;
      }
      // Teto no limiar: voz de verdade passa dele mesmo em quarto barulhento ou com a fala já em curso.
      const threshold = Math.min(0.035, Math.max(0.006, floor * 3));
      if (rms > threshold) {
        spoke = true;
        speechMs += POLL_MS;
        lastVoice = now;
      }
      if (spoke && now - lastVoice > silenceMs) stop();
      else if (!spoke && elapsed > noSpeechMs) stop();
      else if (elapsed > maxMs) stop();
    };

    rec.start(250);
    timer = setInterval(poll, POLL_MS);
    await done;

    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    this.level = 0;
    this.active = false;
    this._finish = this._cancel = null;

    stats.speechMs = speechMs;
    if (cancelled || speechMs < MIN_SPEECH_MS || !chunks.length) return null;
    const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
    return { buffer: await blob.arrayBuffer(), mime: blob.type };
  }
}
