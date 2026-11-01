// Web Worker: rozpoznawanie mowy Whisper na urządzeniu (transformers.js + ONNX Runtime/WASM).
// Model i pliki WASM trafiają do Cache Storage, biblioteka do cache service workera — potem działa offline.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

env.allowLocalModels = false;

let asr = null;
let loaded = null;

async function load(model, onProgress) {
  if (asr && loaded === model) return asr;
  if (asr) await asr.dispose?.();
  asr = null;
  asr = await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: onProgress,
  });
  loaded = model;
  return asr;
}

// ---------- test szybkości: WASM (obecny tryb) i WebGPU (karta graficzna) ----------
async function gpuInfo() {
  const adapter = await navigator.gpu?.requestAdapter?.().catch(() => null);
  if (!adapter) return { available: false };
  const info = adapter.info || {};
  return {
    available: true,
    f16: adapter.features.has('shader-f16'),
    name: [info.vendor, info.architecture, info.description].filter(Boolean).join(' '),
  };
}

// Warianty testu. `webgpu-encoder`: koder (najcięższy, zawsze okno 30 s) na karcie graficznej, dekoder jak dotąd.
async function benchOptions(config) {
  if (config === 'webgpu-q8') return { dtype: 'q8', device: 'webgpu' };
  const { f16 } = await gpuInfo();
  return {
    dtype: { encoder_model: f16 ? 'fp16' : 'q4', decoder_model_merged: 'q8' },
    device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' },
  };
}

async function bench({ model, config, audio, language }, onProgress) {
  const t0 = performance.now();
  let pipe;
  let own = false;
  if (config === 'wasm') pipe = await load(model);
  else {
    own = true;
    pipe = await pipeline('automatic-speech-recognition', model, { ...(await benchOptions(config)), progress_callback: onProgress });
  }
  const opts = { language, task: 'transcribe', max_new_tokens: 224 };
  const t1 = performance.now();
  await pipe(audio, opts); // rozgrzewka (kompilacja shaderów itp.)
  const t2 = performance.now();
  const out = await pipe(audio, opts);
  const t3 = performance.now();
  if (own) await pipe.dispose?.();
  return { load: t1 - t0, first: t2 - t1, second: t3 - t2, text: (out.text || '').trim() };
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      await load(data.model, (p) => self.postMessage({ id, type: 'progress', progress: p }));
      self.postMessage({ id, type: 'done' });
    } else if (type === 'gpu') {
      self.postMessage({ id, type: 'done', gpu: await gpuInfo() });
    } else if (type === 'bench') {
      const result = await bench(data, (p) => self.postMessage({ id, type: 'progress', progress: p }));
      self.postMessage({ id, type: 'done', result });
    } else if (type === 'transcribe') {
      const pipe = await load(data.model);
      // Fragmenty ≤ 30 s (dzieli je aplikacja); limit tokenów chroni przed zapętleniem modelu.
      const out = await pipe(data.audio, { language: data.language, task: 'transcribe', max_new_tokens: 224 });
      self.postMessage({ id, type: 'done', text: (out.text || '').trim() });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
