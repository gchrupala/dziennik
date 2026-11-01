// Transkrypcja offline: Whisper działający w przeglądarce (Web Worker). Model pobiera się raz, przy internecie.
export const MODELS = [
  { id: 'onnx-community/whisper-small', name: 'Dokładny (small) — polecany', size: '≈ 250 MB', note: 'wyraźnie lepszy po polsku; na słabszym telefonie tekst może spływać z opóźnieniem' },
  { id: 'onnx-community/whisper-base', name: 'Szybki (base)', size: '≈ 80 MB', note: 'lżejszy i szybszy, ale sporo błędów' },
];
export const SAMPLE_RATE = 16000;

const MODEL_KEY = 'dziennik.whisperModel';
const MODE_KEY = 'dziennik.whisperMode';
const CACHE_NAME = 'transformers-cache';
const MODEL_FILES = ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export const supported = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && 'caches' in self;

/** Wybrany i pobrany model (id) albo null. */
export const installedModel = () => store.get(MODEL_KEY);
export const ready = () => supported && Boolean(installedModel());

/** 'auto' — z internetem rozpoznawanie przeglądarki, bez internetu Whisper; 'always' — zawsze Whisper. */
export const mode = () => (store.get(MODE_KEY) === 'always' ? 'always' : 'auto');
export const setMode = (m) => store.set(MODE_KEY, m);

let worker = null;
let seq = 0;
const waiters = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper-worker.js?v=202611011053', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const w = waiters.get(data.id);
    if (!w) return;
    if (data.type === 'progress') return w.onProgress?.(data.progress);
    waiters.delete(data.id);
    if (data.type === 'error') w.reject(new Error(data.message));
    else w.resolve(data);
  };
  worker.onerror = (e) => {
    for (const w of waiters.values()) w.reject(new Error(e.message || 'Błąd modułu Whisper'));
    waiters.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call(msg, { onProgress, transfer } = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

/** Czy pliki modelu są w pamięci podręcznej. */
export async function isCached(model) {
  try {
    const keys = await (await caches.open(CACHE_NAME)).keys();
    return MODEL_FILES.every((f) => keys.some((k) => k.url.includes(`/${model}/`) && k.url.endsWith(f)));
  } catch {
    return false;
  }
}

/** Pobiera model (z postępem 0..1) i ustawia go jako aktywny. */
export async function install(model, onProgress) {
  const files = new Map();
  await call({ type: 'load', model }, {
    onProgress: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let loaded = 0;
      let total = 0;
      for (const [l, t] of files.values()) { loaded += l; total += t; }
      onProgress?.(total ? loaded / total : 0);
    },
  });
  store.set(MODEL_KEY, model);
  navigator.storage?.persist?.().catch(() => {});
}

export async function remove(model) {
  try {
    const cache = await caches.open(CACHE_NAME);
    for (const k of await cache.keys()) if (k.url.includes(`/${model}/`)) await cache.delete(k);
  } catch { /* ignore */ }
  if (installedModel() === model) store.set(MODEL_KEY, null);
  worker?.terminate();
  worker = null;
}

/** Wczytuje model do pamięci z wyprzedzeniem (np. na starcie nagrania). */
export function warmUp() {
  if (ready()) queue = queue.then(() => call({ type: 'load', model: installedModel() })).catch(() => {});
}

let queue = Promise.resolve();

/** Transkrybuje próbki 16 kHz mono. Zadania wykonują się po kolei. lang: 'pl-PL' | 'es-ES' | 'en-US'. */
export function transcribe(audio, lang) {
  const model = installedModel();
  if (!model) return Promise.reject(new Error('Brak pobranego modelu Whisper'));
  const job = queue.then(() => call(
    { type: 'transcribe', model, audio, language: lang.slice(0, 2) },
    { transfer: [audio.buffer] },
  )).then((r) => r.text);
  queue = job.catch(() => {});
  return job;
}

/** Dekoduje zapisane nagranie do 16 kHz mono. */
export async function decodeBlob(blob) {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
  const out = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / decoded.numberOfChannels;
  }
  return out;
}

/** Dzieli długie nagranie na fragmenty ≤ 28 s, tnąc w miejscach ciszy (jak przy nagrywaniu na żywo). */
export function splitOnSilence(audio, { min = 18, max = 28, silence = 0.012 } = {}) {
  const block = SAMPLE_RATE / 4;
  const out = [];
  let start = 0;
  for (let i = 0; i < audio.length; i += block) {
    const end = Math.min(i + block, audio.length);
    const len = end - start;
    if (end === audio.length || len >= max * SAMPLE_RATE || (len >= min * SAMPLE_RATE && rms(audio.subarray(i, end)) < silence)) {
      out.push(audio.slice(start, end));
      start = end;
    }
  }
  return out;
}

/** Transkrypcja całego nagrania fragmentami; ciche fragmenty są pomijane. */
export async function transcribeLong(audio, lang) {
  const texts = [];
  for (const seg of splitOnSilence(audio)) {
    if (seg.length < SAMPLE_RATE / 2 || rms(seg) < 0.006) continue;
    const text = await transcribe(seg, lang);
    if (text) texts.push(text);
  }
  return texts.join(' ');
}

export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}
