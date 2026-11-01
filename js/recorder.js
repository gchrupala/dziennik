// Nagrywanie dźwięku + równoczesna transkrypcja.
// Z internetem: rozpoznawanie mowy przeglądarki (na żywo). Bez internetu: Whisper na urządzeniu
// (dźwięk cięty na ~20–28 s fragmenty w miejscach ciszy, tekst pojawia się z kilkunastosekundowym opóźnieniem).
import * as whisper from './whisper.js?v=202611010335';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const LANGS = [
  { code: 'pl-PL', label: 'PL', name: 'Polski' },
  { code: 'es-ES', label: 'ES', name: 'Español' },
  { code: 'en-US', label: 'EN', name: 'English' },
];

export const speechSupported = Boolean(SR);
const localCapable = Boolean(SR && typeof SR.available === 'function' && 'processLocally' in SR.prototype);

// Rozpoznawanie mowy na urządzeniu wbudowane w nowsze Chrome.
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
  'not-allowed': 'Brak zgody na rozpoznawanie mowy.',
  'service-not-allowed': 'Rozpoznawanie mowy jest zablokowane.',
  'language-not-supported': 'Ten język nie jest obsługiwany przez rozpoznawanie mowy przeglądarki.',
  'audio-capture': 'Rozpoznawanie mowy nie ma dostępu do mikrofonu.',
};

const SR16 = whisper.SAMPLE_RATE;
const SEG_MIN = 18 * SR16; // od tej długości tniemy przy pierwszej ciszy
const SEG_MAX = 28 * SR16; // twardy limit (okno Whispera to 30 s)
const SILENCE_RMS = 0.006; // fragment ciszy — nie wysyłamy do Whispera (unika „halucynacji”)

const join = (...parts) => parts.map((p) => (p || '').trim()).filter(Boolean).join(' ');

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  return candidates.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

export class RecordingSession {
  constructor({ lang, onTranscript, onSpeechStatus, onLevel, onChunk }) {
    Object.assign(this, { lang, onTranscript, onSpeechStatus, onLevel, onChunk });
    this.langs = [lang];
    this.pieces = [];        // [{ t: ms od startu, text }] — tekst z obu silników, sortowany po czasie
    this.sessionFinal = '';  // finalne wyniki bieżącej sesji rozpoznawania przeglądarki
    this.interim = '';
    this.srT = null;
    this.active = false;
    this.localLangs = new Set();
    this.speechState = 'off';
    this.whisperOn = false;
    this.pending = 0;
    this.idle = Promise.resolve();
  }

  // ---------- tekst ----------
  get transcript() {
    const parts = [...this.pieces];
    if (this.sessionFinal) parts.push({ t: this.srT ?? this.elapsed(), text: this.sessionFinal });
    return join(...parts.sort((a, b) => a.t - b.t).map((p) => p.text));
  }

  get mimeType() { return this.recorder?.mimeType || this.preferredType || 'audio/webm'; }
  blob() { return new Blob(this.chunks, { type: this.mimeType }); }
  elapsed() { return performance.now() - this.startedAt; }
  emitTranscript() { this.onTranscript?.({ text: this.transcript, interim: this.interim, pending: this.pending }); }
  status(state, message = '') { this.onSpeechStatus?.(state, message); }

  // ---------- start / stop ----------
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
    await this.startAudioGraph();
    this.onOnline = () => this.resumeSpeech();
    window.addEventListener('online', this.onOnline);

    const useWhisper = whisper.ready() && this.pcmOk;
    if (useWhisper) whisper.warmUp();
    if (useWhisper && whisper.mode() === 'always') {
      this.whisperOnly = true;
      this.setWhisper(true);
    } else if (!SR) {
      if (useWhisper) this.setWhisper(true);
      else this.status('unsupported', 'Ta przeglądarka nie obsługuje transkrypcji na żywo — nagrywam sam dźwięk.');
    } else {
      this.startSpeech();
    }
  }

  async stop() {
    this.active = false;
    const durationMs = this.elapsed();
    window.removeEventListener('online', this.onOnline);
    const stopped = this.recorder.state === 'inactive'
      ? Promise.resolve()
      : new Promise((res) => this.recorder.addEventListener('stop', res, { once: true }));
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await Promise.all([stopped, this.stopSpeech()]);
    if (this.whisperOn) this.cutSegment();
    this.whisperOn = false;
    cancelAnimationFrame(this.raf);
    this.audioCtx?.close().catch(() => {});
    this.stream.getTracks().forEach((t) => t.stop());
    return {
      blob: this.blob(),
      mimeType: this.mimeType,
      durationMs,
      transcript: this.transcript,
      langs: this.langs,
      pending: this.pending,
      // Whisper może jeszcze kończyć ostatnie fragmenty — wynik końcowy:
      done: this.idle.then(() => this.transcript),
    };
  }

  setLang(lang) {
    if (lang === this.lang) return;
    if (this.whisperOn) this.cutSegment(); // dotychczasowy dźwięk w poprzednim języku
    this.lang = lang;
    if (!this.langs.includes(lang)) this.langs.push(lang);
    this.failures = 0;
    if (!this.active || !SR || this.whisperOnly) return;
    if (this.speechState === 'running' && this.rec) this.rec.stop(); // onend wystartuje z nowym językiem
    else if (this.speechState === 'failed') this.spawn();
  }

  // ---------- dźwięk: poziom + próbki 16 kHz dla Whispera ----------
  async startAudioGraph() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      try {
        this.audioCtx = new Ctx({ sampleRate: SR16 });
      } catch {
        this.audioCtx = new Ctx();
      }
      this.audioCtx.resume?.().catch(() => {});
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        if (!this.active) return;
        analyser.getFloatTimeDomainData(buf);
        this.onLevel?.(Math.min(1, whisper.rms(buf) * 5));
        this.raf = requestAnimationFrame(tick);
      };
      tick();

      if (this.audioCtx.sampleRate === SR16 && this.audioCtx.audioWorklet) {
        await this.audioCtx.audioWorklet.addModule(new URL('./pcm-worklet.js?v=202611010335', import.meta.url));
        const node = new AudioWorkletNode(this.audioCtx, 'pcm-capture');
        node.port.onmessage = (e) => this.onPcm(e.data);
        source.connect(node);
        node.connect(this.audioCtx.destination); // wyjście jest ciche; połączenie utrzymuje przetwarzanie
        this.pcmOk = true;
      }
    } catch (err) {
      console.warn('Brak przechwytywania próbek dla Whispera:', err);
    }
  }

  // ---------- Whisper ----------
  setWhisper(on) {
    if (on === this.whisperOn || (on && !(whisper.ready() && this.pcmOk && this.active))) return false;
    if (on) {
      this.whisperOn = true;
      this.seg = [];
      this.segLen = 0;
      this.segT = this.elapsed();
      this.status('whisper', 'Transkrypcja offline (Whisper) — tekst pojawia się co kilkanaście sekund.');
    } else {
      this.cutSegment();
      this.whisperOn = false;
    }
    return true;
  }

  onPcm(block) {
    if (!this.active || !this.whisperOn) return;
    this.seg.push(block);
    this.segLen += block.length;
    if (this.segLen >= SEG_MAX || (this.segLen >= SEG_MIN && whisper.rms(block) < SILENCE_RMS * 2)) this.cutSegment();
  }

  cutSegment() {
    if (!this.seg?.length) return;
    const audio = new Float32Array(this.segLen);
    let o = 0;
    for (const b of this.seg) { audio.set(b, o); o += b.length; }
    const t = this.segT;
    const lang = this.lang;
    this.seg = [];
    this.segLen = 0;
    this.segT = this.elapsed();
    if (audio.length < SR16 / 2 || whisper.rms(audio) < SILENCE_RMS) return;
    this.pending++;
    this.emitTranscript();
    const job = whisper.transcribe(audio, lang)
      .then((text) => { if (text) this.pieces.push({ t, text }); })
      .catch((err) => {
        console.warn('Whisper:', err);
        this.status('error', `Błąd transkrypcji offline: ${err.message}`);
      })
      .finally(() => {
        this.pending--;
        this.emitTranscript();
      });
    this.idle = Promise.all([this.idle, job]);
  }

  // ---------- rozpoznawanie mowy przeglądarki ----------
  startSpeech() {
    this.useTrack = true;
    this.failures = 0;
    if (localCapable) {
      for (const { code } of LANGS) {
        offlineSpeech.status(code).then((s) => { if (s === 'available') this.localLangs.add(code); });
      }
    }
    if (!navigator.onLine && !this.localLangs.has(this.lang) && this.goOffline()) return;
    this.spawn();
  }

  // Bez internetu: Whisper (jeśli pobrany), w przeciwnym razie sam dźwięk.
  goOffline() {
    this.speechState = 'waiting';
    if (this.setWhisper(true) || this.whisperOn) return true;
    this.status('waiting', 'Brak internetu — nagrywam sam dźwięk. Pobierz model offline w Ustawieniach, żeby mieć transkrypcję bez sieci.');
    return true;
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
    this.srT = null;
    rec.onresult = (e) => {
      if (!heard) {
        heard = true;
        if (this.whisperOn) this.setWhisper(false); // przeglądarka znów rozpoznaje — Whisper niepotrzebny
        this.status(local ? 'local' : 'listening', local ? 'Transkrypcja offline (na urządzeniu).' : '');
      }
      this.srT ??= this.elapsed();
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
      const text = join(this.sessionFinal, this.interim);
      if (text) this.pieces.push({ t: this.srT ?? this.elapsed(), text });
      this.sessionFinal = '';
      this.interim = '';
      this.srT = null;
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
        this.fail('Nie udało się uruchomić rozpoznawania mowy.');
        return;
      }
    }
    if (!this.whisperOn) this.status(local ? 'local' : 'listening', local ? 'Transkrypcja offline (na urządzeniu).' : '');
  }

  fail(message) {
    this.speechState = 'failed';
    if (this.setWhisper(true) || this.whisperOn) return;
    this.status('error', `${message} Nagrywam sam dźwięk.`);
  }

  afterEnd({ error, local, quick }) {
    if (error === 'network') {
      if (!local && this.localLangs.has(this.lang)) {
        this.forceLocal = true;
        return this.respawn(0);
      }
      this.goOffline();
      // ponowna próba, gdy wróci internet (zdarzenie 'online') albo co 30 s
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
    if (FATAL[error]) return this.fail(FATAL[error]);
    this.failures = quick ? (this.failures || 0) + 1 : 0;
    if (this.failures >= 5) return this.fail('Rozpoznawanie mowy przeglądarki nie działa.');
    this.respawn(this.failures * 400);
  }

  respawn(ms) {
    this.speechState = 'restarting';
    clearTimeout(this.respawnTimer);
    this.respawnTimer = setTimeout(() => this.spawn(), ms);
  }

  resumeSpeech() {
    if (!this.active || this.speechState !== 'waiting') return;
    clearTimeout(this.respawnTimer);
    if (!navigator.onLine) {
      this.respawnTimer = setTimeout(() => this.resumeSpeech(), 30000);
      return;
    }
    this.forceLocal = false;
    this.failures = 0;
    this.spawn(); // Whisper wyłączy się dopiero, gdy przeglądarka faktycznie zacznie rozpoznawać
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
        const text = join(this.sessionFinal, this.interim);
        if (text) this.pieces.push({ t: this.srT ?? this.elapsed(), text });
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
