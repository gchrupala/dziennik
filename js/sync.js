// Kopia i synchronizacja z repozytorium GitHub (domyślnie gchrupala/app-data) przez REST API.
// Układ w repo (jak w innych aplikacjach): <profil>/dziennik.json (wszystkie wpisy, metadane),
// <profil>/dziennik.md (czytelny raport), <profil>/dziennik/<data>_<id>/<pliki> (nagrania, zdjęcia, dokumenty).
import * as db from './db.js?v=202611011130';
import { describeWeather, groupFragments } from './context.js?v=202611011130';
import { describeMethods } from './recorder.js?v=202611011130';

const K = { token: 'dziennik.gh.token', repo: 'dziennik.gh.repo', profile: 'dziennik.gh.profile', last: 'dziennik.gh.last', deleted: 'dziennik.deleted', purge: 'dziennik.gh.purge' };
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export const settings = () => ({
  token: ls.get(K.token) || '',
  repo: ls.get(K.repo) || 'gchrupala/app-data',
  profile: ls.get(K.profile) || 'grzegorz',
});
export function saveSettings({ token, repo, profile }) {
  ls.set(K.token, token?.trim());
  ls.set(K.repo, repo?.trim());
  ls.set(K.profile, profile?.trim());
}
export const configured = () => Boolean(settings().token);
export const lastSync = () => Number(ls.get(K.last)) || 0;

// Usunięte wpisy (żeby synchronizacja ich nie przywróciła).
const tombstones = () => { try { return JSON.parse(ls.get(K.deleted) || '[]'); } catch { return []; } };
export function markDeleted(id) {
  const t = new Set(tombstones());
  t.add(id);
  ls.set(K.deleted, JSON.stringify([...t]));
}

// Pliki do skasowania w repo (ścieżki względem profilu). Zapisywane przed zapisem dziennik.json, usuwane po skasowaniu —
// przerwana synchronizacja dokończy kasowanie następnym razem (zdalny JSON już tych plików nie wymienia).
const purgeList = () => { try { return JSON.parse(ls.get(K.purge) || '[]'); } catch { return []; } };
const savePurge = (paths) => ls.set(K.purge, paths.length ? JSON.stringify([...new Set(paths)]) : '');

export const events = new EventTarget();
let state = { running: false, message: '', error: false };
export const status = () => state;
function setStatus(message, extra = {}) {
  state = { ...state, message, ...extra };
  events.dispatchEvent(new Event('status'));
}

// ---------- GitHub API ----------
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function gh(path, { method = 'GET', body, raw = false } = {}) {
  const { token, repo } = settings();
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encPath(path)}`, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) {
    let msg = `GitHub ${res.status}`;
    try { msg += `: ${(await res.json()).message}`; } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return raw ? res.blob() : res.json();
}

const b64FromBlob = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const b64FromText = (text) => b64FromBlob(new Blob([text], { type: 'text/plain' }));

async function readText(path) {
  const meta = await gh(path);
  if (!meta) return { text: null, sha: null };
  const text = meta.encoding === 'base64' && meta.content
    ? new TextDecoder().decode(Uint8Array.from(atob(meta.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)))
    : await (await gh(path, { raw: true })).text();
  return { text, sha: meta.sha };
}

const stamp = () => new Date().toISOString();
const commitMsg = (what) => `Dziennik: ${what} ${stamp()}`;

// ---------- ścieżki ----------
const pad = (n) => String(n).padStart(2, '0');
function fragmentDir(f) {
  const d = new Date(f.createdAt);
  return `dziennik/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}_${f.id.slice(0, 8)}`;
}
const safeName = (name) => (name || 'plik').replace(/[\\/:*?"<>|#%]+/g, '_').slice(-80);
const filePath = (f, file) => `${fragmentDir(f)}/${file.id.slice(0, 8)}_${safeName(file.name)}`;

// Wszystkie pliki wpisu (nagranie + załączniki) jako metadane.
async function localFiles(f) {
  const out = [];
  if (f.audioId && f.status !== 'recording') {
    const a = await db.getFile(f.audioId);
    if (a) out.push({ id: a.id, kind: 'audio', name: a.name, type: a.type, size: a.size });
  }
  for (const a of f.attachments || []) {
    out.push({ id: a.id, kind: a.kind, name: a.name, type: a.type, size: a.size });
    // JPEG do wyświetlania zdjęcia HEIC (w repo obok oryginału; raport MD go pokazuje)
    if (a.preview) out.push({ ...a.preview, kind: 'preview', of: a.id });
  }
  return out;
}

// ---------- raport Markdown ----------
const dayFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' });
const mdLink = (p) => encPath(p).replace(/\(/g, '%28').replace(/\)/g, '%29');

function reportMd(fragments) {
  const lines = ['# Dziennik', ''];
  let lastDay = '';
  for (const group of groupFragments(fragments)) {
    const first = group[0];
    const day = dayFmt.format(first.createdAt);
    if (day !== lastDay) { lines.push(`## ${day[0].toUpperCase()}${day.slice(1)}`, ''); lastDay = day; }
    // Bliskie wpisy (czas i miejsce) pod jednym nagłówkiem; miejsce i pogoda z pierwszego.
    const place = group.find((f) => f.location?.place)?.location.place;
    const time = group.length > 1
      ? `${timeFmt.format(first.createdAt)}–${timeFmt.format(group.at(-1).createdAt)}`
      : timeFmt.format(first.createdAt);
    lines.push(`### ${time}${place ? ` — ${place}` : ''}`, '');
    lines.push(...metaLines(first));
    for (const f of group) {
      if (group.length > 1) lines.push(`**${timeFmt.format(f.createdAt)}**`, '');
      lines.push(...bodyLines(f));
    }
  }
  return lines.join('\n');
}

function metaLines(f) {
  const lines = [];
  const loc = f.location;
  const meta = [];
  if (loc?.lat != null) meta.push(`📍 [${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}](https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}#map=15/${loc.lat}/${loc.lon})`);
  if (f.weather?.temperature != null) {
    const w = describeWeather(f.weather);
    meta.push(`${w.icon} ${Math.round(f.weather.temperature)}°C, ${w.text.toLowerCase()}`);
  }
  if (meta.length) lines.push(meta.join(' · '), '');
  return lines;
}

function bodyLines(f) {
  const lines = [];
  if (f.transcript) {
    lines.push(...f.transcript.split('\n').map((l) => `> ${l}`), '');
    if (f.transcribedBy?.length) lines.push(`*Transkrypcja: ${describeMethods(f.transcribedBy)}*`, '');
  }
  if (f.notes) lines.push(f.notes, '');
  for (const file of f.files || []) {
    const p = mdLink(file.path);
    if (file.kind === 'preview') continue;
    const preview = f.files.find((x) => x.kind === 'preview' && x.of === file.id);
    if (file.kind === 'photo' && preview) lines.push(`[![${file.name}](${mdLink(preview.path)})](${p})`);
    else if (file.kind === 'photo') lines.push(`![${file.name}](${p})`);
    else lines.push(`- ${file.kind === 'audio' ? '🎙 nagranie' : '📄'} [${file.name}](${p})`);
  }
  if (f.files?.length) lines.push('');
  return lines;
}

// ---------- synchronizacja ----------
/**
 * Dwukierunkowa: pobiera wpisy z repo (nowsza wersja wygrywa), wysyła brakujące pliki,
 * zapisuje dziennik.json i dziennik.md (tylko gdy coś się zmieniło).
 */
let running = null;
let dirty = false; // zmiany w trakcie synchronizacji — dosynchronizuj później
export function sync() {
  if (!configured()) return Promise.reject(new Error('Brak tokenu GitHub'));
  running ??= runSync().finally(() => {
    running = null;
    if (dirty) { dirty = false; schedule(); }
  });
  return running;
}

async function runSync(attempt = 0) {
  const { profile } = settings();
  const jsonPath = `${profile}/dziennik.json`;
  setStatus('Synchronizacja…', { running: true, error: false });
  try {
    // 1. Stan zdalny
    const remoteFile = await readText(jsonPath);
    const remote = remoteFile.text ? JSON.parse(remoteFile.text) : { dziennik: 1, fragments: [], deleted: [] };
    const deleted = new Set([...(remote.deleted || []), ...tombstones()]);
    const remoteById = new Map(remote.fragments.map((f) => [f.id, f]));

    // 2. Pobranie zmian z repo
    let downloaded = 0;
    for (const rf of remote.fragments) {
      if (deleted.has(rf.id)) continue;
      const local = await db.getFragment(rf.id);
      if (!local || rf.updatedAt > local.updatedAt) {
        const { files, ...meta } = rf;
        await db.putFragment({ ...meta, attachments: meta.attachments || [], transcribing: false });
      }
      for (const file of rf.files || []) {
        if (await db.getFile(file.id)) continue;
        setStatus(`Pobieranie: ${file.name}…`);
        const blob = await gh(`${profile}/${file.path}`, { raw: true });
        if (!blob) continue;
        await db.putFile({ id: file.id, fragmentId: rf.id, kind: file.kind, name: file.name, type: file.type, size: blob.size, blob: new Blob([blob], { type: file.type }) });
        downloaded++;
      }
    }
    for (const id of deleted) if (await db.getFragment(id)) await db.deleteFragment(id);

    // 3. Wysłanie brakujących plików
    const out = [];
    const removed = []; // pliki usunięte z wpisu (zdjęcie, dokument) — do skasowania w repo
    let uploaded = 0;
    for (const f of await db.getAllFragments()) {
      if (f.status === 'recording' || deleted.has(f.id)) continue;
      const remoteFiles = remoteById.get(f.id)?.files || [];
      const already = new Map(remoteFiles.map((x) => [x.id, x]));
      // Decydują metadane wpisu, nie obecność blobu (brak pobranego pliku nie może go skasować w repo).
      const keep = new Set([f.audioId, ...(f.attachments || []).flatMap((a) => [a.id, a.preview?.id])].filter(Boolean));
      removed.push(...remoteFiles.filter((x) => !keep.has(x.id)));
      const files = [];
      for (const meta of await localFiles(f)) {
        if (already.has(meta.id)) { files.push(already.get(meta.id)); continue; }
        const file = await db.getFile(meta.id);
        if (!file) continue;
        const path = filePath(f, meta);
        setStatus(`Wysyłanie: ${meta.name}…`);
        try {
          await gh(`${profile}/${path}`, { method: 'PUT', body: { message: commitMsg(meta.name), content: await b64FromBlob(file.blob) } });
        } catch (err) {
          if (err.status !== 422) throw err; // 422 = plik już jest (np. przerwana wcześniejsza synchronizacja)
        }
        files.push({ ...meta, path });
        uploaded++;
      }
      const { transcribing, ...rest } = f;
      out.push({ ...rest, files });
    }

    // Pliki usuniętych wpisów i usunięte załączniki — zapamiętaj przed zapisem JSON (patrz purgeList).
    for (const rf of remote.fragments) if (deleted.has(rf.id)) removed.push(...(rf.files || []));
    savePurge([...purgeList(), ...removed.map((f) => f.path)]);

    // 4. dziennik.json + dziennik.md
    // Wynik testu szybkości Whispera z modelem telefonu (Ustawienia) — do diagnostyki.
    let bench = null;
    try { bench = JSON.parse(ls.get('dziennik.bench') || 'null'); } catch { /* ignore */ }
    const diagnostics = bench || remote.diagnostics;
    const next = { dziennik: 1, fragments: out.sort((a, b) => a.createdAt - b.createdAt), deleted: [...deleted], ...(diagnostics ? { diagnostics } : {}) };
    const nextText = JSON.stringify(next, null, 1);
    if (nextText !== remoteFile.text) {
      await gh(jsonPath, {
        method: 'PUT',
        body: { message: commitMsg('wpisy'), content: await b64FromText(nextText), ...(remoteFile.sha ? { sha: remoteFile.sha } : {}) },
      });
    }
    // Raport sprawdzany zawsze (nie tylko przy zmianie JSON) — przerwana synchronizacja go dokończy.
    const md = await readText(`${profile}/dziennik.md`);
    const mdText = reportMd(next.fragments);
    if (mdText !== md.text) {
      await gh(`${profile}/dziennik.md`, {
        method: 'PUT',
        body: { message: commitMsg('raport'), content: await b64FromText(mdText), ...(md.sha ? { sha: md.sha } : {}) },
      });
    }

    // 5. Kasowanie plików (po zapisaniu JSON, żeby nie wskazywał brakujących plików)
    const stillUsed = new Set(next.fragments.flatMap((f) => f.files.map((x) => x.path)));
    for (const path of purgeList()) {
      try {
        if (!stillUsed.has(path)) {
          const meta = await gh(`${profile}/${path}`);
          if (meta?.sha) await gh(`${profile}/${path}`, { method: 'DELETE', body: { message: commitMsg(`usunięto ${path.split('/').pop()}`), sha: meta.sha } });
        }
        savePurge(purgeList().filter((x) => x !== path));
      } catch { /* spróbuje przy następnej synchronizacji */ }
    }

    ls.set(K.last, String(Date.now()));
    const parts = [uploaded && `wysłano plików: ${uploaded}`, downloaded && `pobrano plików: ${downloaded}`].filter(Boolean);
    setStatus(`Zsynchronizowano${parts.length ? ` (${parts.join(', ')})` : ''}.`, { running: false });
  } catch (err) {
    // Konflikt (ktoś zapisał w międzyczasie) — spróbuj jeszcze raz od pobrania.
    if ((err.status === 409 || err.status === 422) && attempt < 2) return runSync(attempt + 1);
    const msg = err.status === 401 ? 'Nieprawidłowy token GitHub.'
      : err.status === 403 || err.status === 404 ? `Brak dostępu do repozytorium ${settings().repo} (sprawdź uprawnienia tokenu: Contents — Read and write).`
        : `Błąd synchronizacji: ${err.message}`;
    setStatus(msg, { running: false, error: true });
    throw err;
  }
}

// Automatyczna synchronizacja: po zmianach (z opóźnieniem), po odzyskaniu internetu i na starcie.
let timer = null;
export function schedule(ms = 20000) {
  if (!configured()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (navigator.onLine) sync().catch(() => {});
  }, ms);
}

export function startAuto() {
  db.changes.addEventListener('change', () => { if (running) dirty = true; else schedule(); });
  window.addEventListener('online', () => schedule(2000));
  schedule(3000);
}
