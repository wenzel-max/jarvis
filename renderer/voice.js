// Voz do Jarvis: edge-tts (via processo principal) com reserva na voz do sistema.
// O áudio toca por Web Audio: cada frase é decodificada e agendada logo depois da anterior,
// então não há o "buraco" de uma troca de arquivo entre frases, e parar é imediato.
// Também mede o volume do que está tocando, para a esfera pulsar junto.

const BREATH_S = 0.12;     // respiração entre frases (pessoas não emendam uma frase na outra)
const LOOKAHEAD = 2;       // frases sintetizadas à frente da que está tocando
const START_DELAY_S = 0.03;

export class Voice {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.speaking = false;
    this.usingFallback = false;
    this.onFallback = null;     // chamado quando a voz online falha
    this._token = 0;
    this._fake = false;
    this._sources = new Set();
    this._tail = 0;             // instante (relógio do áudio) em que termina o que já está agendado
  }

  _graph() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.connect(this.ctx.destination);
  }

  /** Volume atual (0..1). Na voz do sistema não há áudio para medir, então simulamos. */
  readLevel() {
    if (!this.speaking) return 0;
    if (this._fake || !this.analyser) {
      const t = performance.now() / 1000;
      return 0.3 + 0.35 * Math.abs(Math.sin(t * 7.3)) * Math.abs(Math.sin(t * 2.1 + 1));
    }
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const b of this.buf) { const v = (b - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 3.2);
  }

  /** Usado na prévia da esfera, sem tocar áudio. */
  simulate(on) {
    this._fake = on;
    this.speaking = on;
  }

  /** Para tudo na hora: o que está tocando, o que está agendado e a voz do sistema. */
  stop() {
    this._token++;
    for (const src of this._sources) {
      try { src.stop(); } catch { /* já tinha terminado */ }
    }
    this._sources.clear();
    this._tail = 0;
    speechSynthesis?.cancel();
    this.speaking = false;
    this._fake = false;
  }

  /** Sintetiza (ou lê do cache) e decodifica uma frase. Devolve null se a voz online não respondeu. */
  async _prepare(text, s, cacheOnly) {
    try {
      const bytes = await window.jarvis.synthesize({ text, voice: s.voice, rate: s.rate, pitch: s.pitch, cacheOnly });
      this._graph();
      const copy = bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
      return await this.ctx.decodeAudioData(copy);
    } catch (e) {
      console.warn('[voz]', e.message);
      return null;
    }
  }

  /** Agenda a frase logo depois do que já está tocando. Devolve quando ela termina. */
  _schedule(audioBuffer) {
    this._graph();
    this.ctx.resume().catch(() => {});
    const src = this.ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.analyser);
    const now = this.ctx.currentTime;
    const when = this._tail > now ? this._tail + BREATH_S : now + START_DELAY_S;
    src.start(when);
    this._tail = when + audioBuffer.duration;
    this._sources.add(src);
    return new Promise((resolve) => {
      src.onended = () => { this._sources.delete(src); resolve(); };
    });
  }

  _speakSystem(text, s, token) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window) || token !== this._token) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR';
      u.voice = speechSynthesis.getVoices().find((v) => v.lang === 'pt-BR') || null;
      u.rate = Math.max(0.5, Math.min(2, 1 + (s.rate || 0) / 100));
      // alguns motores nunca disparam `end`; sem este limite o resumo ficaria preso em "Falando"
      const limit = setTimeout(() => { speechSynthesis.cancel(); resolve(); }, 2500 + text.length * 90);
      u.onend = u.onerror = () => { clearTimeout(limit); resolve(); };
      speechSynthesis.speak(u);
    });
  }

  /**
   * Fala frases em sequência. `sentences` pode ser uma lista ou um iterável assíncrono
   * (resposta da IA chegando aos poucos). Duas frases ficam sintetizadas à frente e cada uma é
   * agendada colada na anterior. Devolve true se terminou sem ser interrompida.
   */
  async speakSequence(sentences, { settings, onSentence } = {}) {
    this.stop();
    const token = this._token;
    this.speaking = true;
    this.usingFallback = false;
    const it = (sentences[Symbol.asyncIterator] ?? sentences[Symbol.iterator]).call(sentences);
    // cada frase pode ser texto simples ou { show, say }: o que aparece na tela x o que é falado
    // depois da primeira falha, as frases seguintes só usam o cache em disco (sem esperar a rede)
    const pull = async () => {
      const r = await it.next();
      if (r.done) return null;
      const say = typeof r.value === 'string' ? r.value : r.value.say;
      const show = typeof r.value === 'string' ? r.value : r.value.show;
      return { say, show, audio: await this._prepare(say, settings, this.usingFallback) };
    };

    const ahead = [];
    for (let i = 0; i < LOOKAHEAD; i++) ahead.push(pull());
    const ends = [];
    for (let i = 0; ; i++) {
      const cur = await ahead.shift();
      if (token !== this._token) return false;
      if (!cur) break;
      ahead.push(pull());
      if (!cur.audio && !this.usingFallback) { this.usingFallback = true; this.onFallback?.(); }
      onSentence?.(cur.show, i);
      if (cur.audio) {
        this._fake = false;
        ends.push(this._schedule(cur.audio));
      } else {
        // a voz do sistema não se agenda: espera o que já foi agendado terminar
        await Promise.all(ends);
        if (token !== this._token) return false;
        this._fake = true;
        await this._speakSystem(cur.say, settings, token);
      }
    }
    await Promise.all(ends);
    if (token === this._token) { this.speaking = false; this._fake = false; }
    return token === this._token;
  }
}
