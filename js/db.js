// Warstwa nad IndexedDB: `fragments` (metadane wpisów) i `files` (bloby: audio, zdjęcia, dokumenty).
const DB_NAME = 'dziennik';
const VERSION = 1;

export const changes = new EventTarget();
export const notify = (id) => changes.dispatchEvent(new CustomEvent('change', { detail: { id } }));

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('fragments')) {
        db.createObjectStore('fragments', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' }).createIndex('fragmentId', 'fragmentId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Uruchamia `body` w jednej transakcji; wynik przekazuje się przez `out.value`.
async function run(storeNames, mode, body) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = Object.fromEntries([].concat(storeNames).map((n) => [n, t.objectStore(n)]));
    const out = {};
    body(stores, out);
    t.oncomplete = () => resolve(out.value);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transakcja przerwana'));
  });
}

export const getAllFragments = () =>
  run('fragments', 'readonly', (s, out) => {
    s.fragments.getAll().onsuccess = (e) => {
      out.value = e.target.result.sort((a, b) => b.createdAt - a.createdAt);
    };
  });

export const getFragment = (id) =>
  run('fragments', 'readonly', (s, out) => {
    s.fragments.get(id).onsuccess = (e) => { out.value = e.target.result; };
  });

export async function putFragment(fragment) {
  await run('fragments', 'readwrite', (s) => { s.fragments.put(fragment); });
  notify(fragment.id);
}

// patch: obiekt albo funkcja (aktualny fragment) => obiekt. Odczyt i zapis w jednej transakcji.
export async function patchFragment(id, patch) {
  const next = await run('fragments', 'readwrite', (s, out) => {
    s.fragments.get(id).onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return;
      const changes = typeof patch === 'function' ? patch(cur) : patch;
      out.value = { ...cur, ...changes, updatedAt: Date.now() };
      s.fragments.put(out.value);
    };
  });
  if (next) notify(id);
  return next;
}

export async function deleteFragment(id) {
  await run(['fragments', 'files'], 'readwrite', (s) => {
    s.fragments.delete(id);
    s.files.index('fragmentId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      s.files.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
  notify(id);
}

export const getFile = (id) =>
  run('files', 'readonly', (s, out) => {
    s.files.get(id).onsuccess = (e) => { out.value = e.target.result; };
  });

export const putFile = (file) => run('files', 'readwrite', (s) => { s.files.put(file); });

// file: { id, kind: 'photo'|'document', name, type, size, blob }
export async function addAttachment(fragmentId, file) {
  const meta = { id: file.id, kind: file.kind, name: file.name, type: file.type, size: file.size, addedAt: Date.now() };
  await run(['fragments', 'files'], 'readwrite', (s) => {
    s.fragments.get(fragmentId).onsuccess = (e) => {
      const f = e.target.result;
      if (!f) return;
      s.files.put({ ...file, fragmentId });
      s.fragments.put({ ...f, attachments: [...(f.attachments || []), meta], updatedAt: Date.now() });
    };
  });
  notify(fragmentId);
}

export async function removeAttachment(fragmentId, fileId) {
  await run(['fragments', 'files'], 'readwrite', (s) => {
    s.files.delete(fileId);
    s.fragments.get(fragmentId).onsuccess = (e) => {
      const f = e.target.result;
      if (!f) return;
      s.fragments.put({ ...f, attachments: (f.attachments || []).filter((a) => a.id !== fileId), updatedAt: Date.now() });
    };
  });
  notify(fragmentId);
}
