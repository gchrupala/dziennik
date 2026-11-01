// Zdjęcia HEIC/HEIF: oryginał zostaje, obok powstaje JPEG do wyświetlania (attachment.preview → plik w `files`).
import * as db from './db.js?v=202611011537';

const MAX_SIDE = 2048; // px, dłuższy bok podglądu
const QUALITY = 0.85;

export const isHeic = (a) => /image\/hei[cf]/i.test(a.type || '') || /\.hei[cf]$/i.test(a.name || '');

let worker = null;
let seq = 0;
const waiters = new Map();
function convert(blob) {
  if (!worker) {
    worker = new Worker(new URL('./heic-worker.js?v=202611011537', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const w = waiters.get(data.id);
      waiters.delete(data.id);
      if (data.error) w?.reject(new Error(data.error));
      else w?.resolve(data.jpeg);
    };
    worker.onerror = (e) => {
      for (const w of waiters.values()) w.reject(new Error(e.message || 'Błąd dekodowania HEIC'));
      waiters.clear();
      worker = null;
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    worker.postMessage({ id, blob, max: MAX_SIDE, quality: QUALITY });
  });
}

const jpegName = (name) => `${(name || 'zdjecie').replace(/\.[^.]+$/, '')}.jpg`;

/** Tworzy brakujące podglądy JPEG dla zdjęć HEIC (po kolei; błędy — np. brak internetu przy pierwszym użyciu — pomija). */
let running = null;
let again = false; // nowe zdjęcia w trakcie — przejdź jeszcze raz
export function ensurePreviews() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    for (const f of await db.getAllFragments()) {
      for (const a of f.attachments || []) {
        if (a.kind !== 'photo' || a.preview || !isHeic(a)) continue;
        const file = await db.getFile(a.id);
        if (!file) continue;
        try {
          const jpeg = await convert(file.blob);
          const preview = { id: crypto.randomUUID(), name: jpegName(a.name), type: 'image/jpeg', size: jpeg.size };
          await db.putFile({ ...preview, kind: 'preview', fragmentId: f.id, blob: jpeg });
          await db.patchFragment(f.id, (cur) => ({
            attachments: (cur.attachments || []).map((x) => (x.id === a.id ? { ...x, preview } : x)),
          }));
        } catch (err) {
          console.warn('Podgląd HEIC:', err);
        }
      }
    }
  })().finally(() => {
    running = null;
    if (again) {
      again = false;
      ensurePreviews();
    }
  });
  return running;
}

/** Plik do wyświetlenia zdjęcia: podgląd JPEG, jeśli jest, inaczej oryginał. */
export async function displayFile(a) {
  return (a.preview && await db.getFile(a.preview.id)) || db.getFile(a.id);
}
