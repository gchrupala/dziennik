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

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      await load(data.model, (p) => self.postMessage({ id, type: 'progress', progress: p }));
      self.postMessage({ id, type: 'done' });
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
