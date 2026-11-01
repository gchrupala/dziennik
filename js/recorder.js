// Nagrywanie dźwięku + równoczesna transkrypcja na żywo.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const LANGS = [
  { code: 'pl-PL', label: 'PL', name: 'Polski' },
  { code: 'es-ES', label: 'ES', name: 'Español' },
  { code: 'en-US', label: 'EN', name: 'English' },
];

export const speechSupported = Boolean(SR);
const localCapable = Boolean(SR && typeof SR.available === 'function' && 'processLocally' in SR.prototype);

// Rozpoznawanie mowy na urządzeniu (nowsze Chrome) — działa bez internetu po pobraniu modelu.
export const offlineSpeech = {
  supported: localCapable,
  async status(lang) {
    if (!localCapable) return 'unavailable';
    try { return await SR.available({ langs: [lang], processLocally: true }); } catch { return 'unavailable'; }
  },
  async install(lang) {
    if (!localCapable) return false;
    try { return await SR.install({ langs: [lang], processLocally: true }); } catch { return false; }
  },
};

const FATAL = {
  'not-allowed': 'Brak zgody na rozpoznawanie mowy — nagrywam sam dźwięk.',
  'service-not-allowed': 'Rozpoznawanie mowy jest zablokowane — nagrywam sam dźwięk.',
  'language-not-supported': 'Ten język nie jest obsługiwany przez rozpoznawanie mowy.',
  'audio-capture': 'Rozpoznawanie mowy nie ma dostępu do mikrofonu — nagrywam sam dźwięk.',
};
const OFFLINE_MSG = 'Brak internetu — nagrywam sam dźwięk. Transkrypcja wróci po odzyskaniu połączenia.';

const join = (...parts) => parts.map((p) => (p || '').trim()).filter(Boolean).join(' ');

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  return candidates.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

export class RecordingSession {
  constructor({ lang, onTranscript, onSpeechStatus, onLevel, onChunk }) {
    Object.assign(this, { lang, onTranscript, onSpeechStatus, onLevel, onChunk });
    this.langs = [lang];
    this.committed = '';     // tekst z zakończonych sesji rozpoznawania
    this.sessionFinal = '';  // finalne wyniki bieżącej sesji
    this.interim = '';       // tymczasowy (niepewny) fragment
    this.active = false;
    this.localLangs = new Set();
    this.speechState = 'off';
  }

  get transcript() { return join(this.committed, this.sessionFinal); }
  get mimeType() { return this.recorder?.mimeType || this.preferredType || 'audio/webm'; }
  blob() { return new Blob(this.chunks, { type: this.mimeType }); }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw Object.assign(new Error('Ta przeglądarka nie pozwala nagrywać dźwięku (wymagane HTTPS).'), { name: 'NotSupportedError' });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.preferredType = pickMimeType();
    try {
      this.recorder = new MediaRecorder(this.stream, this.preferredType ? { mimeType: this.preferredType, audioBitsPerSecond: 64000 } : undefined);
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.chunks = [];
    this.recorder.addEventListener('dataavailable', (e) => {
      if (!e.data?.size) return;
      this.chunks.push(e.data);
      if (this.active) this.onChunk?.(this.blob());
    });
    this.active = true;
    this.startedAt = performance.now();
    this.recorder.start(10000); // fragment co 10 s — zapisywany na bieżąco
    this.startMeter();
    this.onOnline = () => this.resumeSpeech();
    window.addEventListener('online', this.onOnline);
    this.startSpeech();
  }

  async stop() {
    this.active = false;
    const durationMs = performance.now() - this.startedAt;
    window.removeEventListener('online', this.onOnline);
    const stopped = this.recorder.state === 'inactive'
      ? Promise.resolve()
      : new Promise((res) => this.recorder.addEventListener('stop', res, { once: true }));
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await Promise.all([stopped, this.stopSpeech()]);
    cancelAnimationFrame(this.raf);
    this.audioCtx?.close().catch(() => {});
    this.stream.getTracks().forEach((t) => t.stop());
    return { blob: this.blob(), mimeType: this.mimeType, durationMs, transcript: this.transcript, langs: this.langs };
  }

  setLang(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    if (!this.langs.includes(lang)) this.langs.push(lang);
    this.failures = 0;
    if (!this.active || !SR) return;
    if (this.speechState === 'running' && this.rec) this.rec.stop(); // onend wystartuje z nowym językiem
    else if (this.speechState === 'waiting' || this.speechState === 'failed') this.spawn();
  }

  // ---------- poziom dźwięku ----------
  startMeter() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
      this.audioCtx.resume?.().catch(() => {});
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      this.audioCtx.createMediaStreamSource(this.stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!this.active) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        this.onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 5));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* wskaźnik poziomu jest opcjonalny */ }
  }

  // ---------- transkrypcja ----------
  status(state, message = '') { this.onSpeechStatus?.(state, message); }
  emitTranscript() { this.onTranscript?.({ text: this.transcript, interim: this.interim }); }

  startSpeech() {
    if (!SR) {
      this.status('unsupported', 'Ta przeglądarka nie obsługuje transkrypcji — nagrywam sam dźwięk.');
      return;
    }
    this.useTrack = true;
    this.failures = 0;
    if (localCapable) {
      for (const { code } of LANGS) {
        offlineSpeech.status(code).then((s) => { if (s === 'available') this.localLangs.add(code); });
      }
    }
    this.spawn();
  }

  spawn() {
    clearTimeout(this.respawnTimer);
    if (!this.active) return;
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const local = this.localLangs.has(this.lang) && (this.forceLocal || !navigator.onLine);
    if (local) rec.processLocally = true;

    const t0 = Date.now();
    let heard = false;
    let error = null;
    rec.onresult = (e) => {
      heard = true;
      const finals = [];
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals.push(r[0].transcript);
        else interim += r[0].transcript;
      }
      this.sessionFinal = join(...finals);
      this.interim = interim.trim();
      this.emitTranscript();
    };
    rec.onerror = (e) => { error = e.error; };
    rec.onend = () => {
      this.committed = join(this.committed, this.sessionFinal, this.interim);
      this.sessionFinal = '';
      this.interim = '';
      this.emitTranscript();
      if (this.rec === rec) this.rec = null;
      if (!this.active) {
        this.speechState = 'off';
        this.speechEnded?.();
        return;
      }
      this.afterEnd({ error, local, quick: !heard && Date.now() - t0 < 1500 });
    };

    this.rec = rec;
    this.speechState = 'running';
    try {
      // Przekazanie ścieżki z getUserMedia (tam, gdzie obsługiwane) pozwala dzielić mikrofon z nagrywaniem.
      if (this.useTrack) rec.start(this.stream.getAudioTracks()[0]);
      else rec.start();
    } catch {
      try { this.useTrack = false; rec.start(); } catch {
        this.rec = null;
        this.speechState = 'failed';
        this.status('error', 'Nie udało się uruchomić transkrypcji — nagrywam sam dźwięk.');
        return;
      }
    }
    this.status(local ? 'local' : 'listening', local ? 'Transkrypcja offline (na urządzeniu).' : '');
  }

  afterEnd({ error, local, quick }) {
    if (error === 'network') {
      if (!local && this.localLangs.has(this.lang)) {
        this.forceLocal = true;
        return this.respawn(0);
      }
      this.speechState = 'waiting';
      this.status('waiting', OFFLINE_MSG);
      this.respawnTimer = setTimeout(() => this.resumeSpeech(), 30000);
      return;
    }
    if (error === 'language-not-supported' && local) {
      this.localLangs.delete(this.lang);
      this.forceLocal = false;
      return this.respawn(0);
    }
    if (error === 'audio-capture' && this.useTrack) {
      this.useTrack = false;
      return this.respawn(0);
    }
    if (FATAL[error]) {
      this.speechState = 'failed';
      return this.status('error', FATAL[error]);
    }
    this.failures = quick ? (this.failures || 0) + 1 : 0;
    if (this.failures >= 5) {
      this.speechState = 'failed';
      return this.status('error', 'Rozpoznawanie mowy nie działa — nagrywam sam dźwięk.');
    }
    this.respawn(this.failures * 400);
  }

  respawn(ms) {
    this.speechState = 'restarting';
    clearTimeout(this.respawnTimer);
    this.respawnTimer = setTimeout(() => this.spawn(), ms);
  }

  resumeSpeech() {
    if (!this.active || this.speechState !== 'waiting') return;
    this.forceLocal = false;
    this.failures = 0;
    this.spawn();
  }

  stopSpeech() {
    clearTimeout(this.respawnTimer);
    const rec = this.rec;
    if (!rec) {
      this.speechState = 'off';
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Przeglądarka nie zakończyła rozpoznawania — zachowaj to, co już jest.
        this.committed = join(this.committed, this.sessionFinal, this.interim);
        this.sessionFinal = '';
        this.interim = '';
        this.speechEnded = null;
        try { rec.abort(); } catch { /* ignore */ }
        resolve();
      }, 2500);
      this.speechEnded = () => { clearTimeout(timer); this.speechEnded = null; resolve(); };
      try { rec.stop(); } catch { this.speechEnded(); }
    });
  }
}
