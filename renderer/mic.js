// Microfone: grava uma fala e para sozinho quando você fica em silêncio.
// Também mede o volume (0..1) para a esfera pulsar enquanto o Jarvis ouve.

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const POLL_MS = 50;
const NOISE_CALIBRATION_MS = 350;  // mede o ruído do ambiente antes de decidir o que é voz
const MIN_SPEECH_MS = 300;         // menos que isso é estalo ou tosse, não fala

/** Mensagens em português para os erros de acesso ao microfone. */
export function micErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'O Windows bloqueou o microfone. Ative em Configurações, Privacidade e segurança, Microfone, e permita apps da área de trabalho.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Não encontrei nenhum microfone. Conecte um e tente de novo.';
    case 'NotReadableError':
      return `Não consegui abrir o microfone, mesmo tentando todas as formas. Feche programas que possam estar usando, como Discord, Teams ou chamadas no navegador. Detalhe técnico: ${err.message || 'sem detalhe'}`;
    default:
      return 'Não consegui usar o microfone. Tente de novo.';
  }
}

/** Volume em % (0..100) a partir do rms, na mesma escala da esfera. */
const pct = (rms) => Math.round(Math.min(1, rms * 5) * 100);

/** Explica, com os números medidos, por que não houve fala. */
export function explainNoSpeech(stats) {
  if (!stats) return 'Não ouvi nada. Aperte Falar e tente de novo.';
  const dev = stats.label ? `"${stats.label}"` : 'o microfone';
  if (stats.peak < 0.003) {
    return `O Jarvis abriu ${dev}, mas só chegou silêncio (nível ${pct(stats.peak)}%). Veja se o microfone não está mudo (tecla do notebook, Configurações, Sistema, Som, Entrada) e se o volume de entrada está alto.`;
  }
  return `O Jarvis abriu ${dev}, mas o volume ficou baixo (nível máximo ${pct(stats.peak)}%). Fale mais perto e mais alto e tente de novo.`;
}

export class Mic {
  constructor() {
    this.level = 0;      // volume atual, 0..1
    this.stats = null;   // da última gravação: { label, peak, speechMs }
    this.active = false;
    this._finish = null;
    this._cancel = null;
  }

  /**
   * Abre o microfone. Alguns drivers (ex.: "Grupo de microfones" da Intel Smart Sound) recusam
   * a configuração padrão do navegador com NotReadableError, então tenta, em ordem: filtros de
   * áudio, microfone cru, mono e cada dispositivo de entrada individualmente.
   */
  async _open() {
    const gum = (audio) => navigator.mediaDevices.getUserMedia({ audio });
    const attempts = [
      { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      true,
      { channelCount: 1 },
    ];
    let firstError = null;
    const tryAll = async (list) => {
      for (const constraints of list) {
        try {
          return await gum(constraints);
        } catch (err) {
          firstError ??= err;
          // Permissão negada ou falta de dispositivo não melhoram com outra configuração.
          if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') throw err;
          console.warn('[microfone] tentativa recusada:', err?.name, err?.message);
        }
      }
      return null;
    };

    let stream = await tryAll(attempts);
    if (stream) return stream;

    // Mesmo problema no dispositivo padrão: experimenta os outros, um a um.
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
    } catch { /* sem lista, vale o erro original */ }
    const seen = new Set();
    const others = devices.filter((d) => !seen.has(d.deviceId) && seen.add(d.deviceId)).slice(0, 6);
    for (const d of others) {
      stream = await tryAll([{ deviceId: { exact: d.deviceId } }, { deviceId: { exact: d.deviceId }, channelCount: 1 }]);
      if (stream) return stream;
    }
    throw firstError ?? new Error('Nenhum microfone disponível.');
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
