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
      return 'O microfone está em uso por outro programa. Feche-o e tente de novo.';
    default:
      return 'Não consegui usar o microfone. Tente de novo.';
  }
}

export class Mic {
  constructor() {
    this.level = 0;      // volume atual, 0..1
    this.active = false;
    this._finish = null;
    this._cancel = null;
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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.active = true;

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
    let floor = 0, floorN = 0;          // ruído de fundo
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

      const now = performance.now();
      const elapsed = now - t0;
      if (elapsed < NOISE_CALIBRATION_MS) {
        floor += rms; floorN++;
        return;
      }
      const threshold = Math.max(0.02, (floor / Math.max(1, floorN)) * 3);
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

    if (cancelled || speechMs < MIN_SPEECH_MS || !chunks.length) return null;
    const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
    return { buffer: await blob.arrayBuffer(), mime: blob.type };
  }
}
