// Voz do Jarvis: edge-tts (via processo principal) com reserva na voz do sistema.
// Também mede o volume do áudio que está tocando, para a esfera pulsar junto.

export class Voice {
  constructor(audioEl) {
    this.audio = audioEl;
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.speaking = false;
    this.usingFallback = false;
    this.onFallback = null;     // chamado quando a voz online falha
    this._token = 0;
    this._fake = false;
  }

  _graph() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaElementSource(this.audio);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.buf = new Uint8Array(this.analyser.fftSize);
    src.connect(this.analyser);
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

  stop() {
    this._token++;
    this.audio.pause();
    speechSynthesis?.cancel();
    this.speaking = false;
    this._fake = false;
  }

  async _fetch(text, s, cacheOnly = false) {
    const bytes = await window.jarvis.synthesize({ text, voice: s.voice, rate: s.rate, pitch: s.pitch, cacheOnly });
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  }

  _play(url, token) {
    return new Promise((resolve) => {
      let watch = null;
      const done = () => {
        clearInterval(watch);
        this.audio.removeEventListener('ended', done);
        this.audio.removeEventListener('error', done);
        URL.revokeObjectURL(url);
        resolve();
      };
      this.audio.addEventListener('ended', done);
      this.audio.addEventListener('error', done);
      // stop() interrompe o áudio sem disparar `ended`; este vigia encerra a espera nesse caso
      watch = setInterval(() => { if (token !== this._token) done(); }, 150);
      this.audio.src = url;
      this._graph();
      this.ctx.resume().catch(() => {});
      this.audio.play().catch(done);
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
   * (resposta da IA chegando aos poucos). Enquanto uma frase toca, a próxima já é preparada,
   * então quase não há pausa entre elas.
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
      const url = await this._fetch(say, settings, this.usingFallback).catch((e) => { console.warn('[voz]', e.message); return null; });
      return { say, show, url };
    };

    let next = pull();
    for (let i = 0; ; i++) {
      const cur = await next;
      if (token !== this._token) { if (cur?.url) URL.revokeObjectURL(cur.url); return false; }
      if (!cur) break;
      if (!cur.url && !this.usingFallback) { this.usingFallback = true; this.onFallback?.(); }
      next = pull();
      onSentence?.(cur.show, i);
      if (cur.url) {
        this._fake = false;
        await this._play(cur.url, token);
      } else {
        this._fake = true;
        await this._speakSystem(cur.say, settings, token);
      }
    }
    if (token === this._token) { this.speaking = false; this._fake = false; }
    return token === this._token;
  }
}
