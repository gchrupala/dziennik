import * as db from './db.js';
import { RecordingSession, LANGS, speechSupported, offlineSpeech } from './recorder.js';
import { captureContext, backfillContext, describeWeather, windDir, isBusy } from './context.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- formatowanie ----------
const dayFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' });
const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} kB` : `${(b / 1048576).toFixed(1)} MB`);
const langLabel = (code) => LANGS.find((l) => l.code === code)?.label ?? code;
const coords = (loc, digits = 5) => `${loc.lat.toFixed(digits)}, ${loc.lon.toFixed(digits)}`;
const placeShort = (loc) => (loc?.lat == null ? '' : loc.place || coords(loc, 3));
const hasWeather = (w) => w && w.temperature != null;
const weatherShort = (w) => (hasWeather(w) ? `${describeWeather(w).icon} ${Math.round(w.temperature)}°C` : '');
function fileStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
const audioExt = (mime) => (/mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm');

let toastTimer;
function toast(msg, ms = 4500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- język transkrypcji ----------
const LANG_KEY = 'dziennik.lang';
let lang = (() => { try { return localStorage.getItem(LANG_KEY); } catch { return null; } })();
if (!LANGS.some((l) => l.code === lang)) lang = 'pl-PL';

function renderLangs() {
  $('#langs').innerHTML = LANGS.map((l) =>
    `<button type="button" role="radio" aria-checked="${l.code === lang}" data-lang="${l.code}" title="${esc(l.name)}">${l.label}</button>`,
  ).join('');
}

$('#langs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lang]');
  if (!btn) return;
  lang = btn.dataset.lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
  renderLangs();
  rec?.session.setLang(lang);
});

// ---------- nagrywanie ----------
let rec = null; // { id, audioId, session, createdAt, timer, saveTimer, wakeLock }
let busyRec = false;

function setRecordingUI(on) {
  document.body.classList.toggle('recording', on);
  $('#rec-btn').setAttribute('aria-label', on ? 'Zakończ nagrywanie' : 'Nagrywaj');
  for (const sel of ['#rec-meta', '#rec-chips', '#live']) $(sel).hidden = !on;
  for (const sel of ['#rec-hint', '#text-entry', '#list']) $(sel).hidden = on;
  if (!on) $('#speech-status').hidden = true;
}

function renderHint() {
  $('#rec-hint').textContent = speechSupported
    ? 'Naciśnij, aby nagrać fragment. Dźwięk, transkrypcja, lokalizacja i pogoda zapiszą się same.'
    : 'Ta przeglądarka nie obsługuje transkrypcji — nagra się sam dźwięk (użyj Chrome lub Safari).';
}

function renderLive({ text, interim }) {
  const el = $('#live');
  el.innerHTML = text || interim
    ? `${esc(text)} <span class="interim">${esc(interim)}</span>`
    : '<span class="interim">Mów…</span>';
  el.scrollTop = el.scrollHeight;
}

function renderSpeechStatus(state, message) {
  const el = $('#speech-status');
  el.textContent = message;
  el.hidden = !message;
  el.dataset.state = state;
}

async function renderRecChips() {
  if (!rec) return;
  const f = await db.getFragment(rec.id);
  if (!f || !rec || rec.id !== f.id) return;
  const busy = isBusy(f.id);
  const loc = f.location;
  const chips = [];
  if (!loc) chips.push(busy ? '📍 ustalam lokalizację…' : '📍 brak lokalizacji');
  else if (loc.error) chips.push(`📍 ${loc.error}`);
  else chips.push(`📍 ${placeShort(loc)}`);
  if (hasWeather(f.weather)) chips.push(`${weatherShort(f.weather)}, ${describeWeather(f.weather).text.toLowerCase()}`);
  else if (loc?.lat != null && !f.weather) chips.push(busy && navigator.onLine ? '⏳ pogoda…' : 'pogoda: uzupełni się z internetem');
  $('#rec-chips').innerHTML = chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
}

function micErrorMessage(err) {
  if (err?.name === 'NotAllowedError') return 'Brak zgody na mikrofon. Zezwól na dostęp w ustawieniach przeglądarki.';
  if (err?.name === 'NotFoundError') return 'Nie znaleziono mikrofonu.';
  return `Nie udało się rozpocząć nagrywania: ${err?.message || err}`;
}

async function acquireWakeLock() {
  if (!rec || !navigator.wakeLock || (rec.wakeLock && !rec.wakeLock.released)) return;
  try { rec.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* opcjonalne */ }
}

function saveAudio(fragmentId, audioId, blob, mime, createdAt) {
  return db.putFile({
    id: audioId, fragmentId, kind: 'audio', type: mime, size: blob.size, blob,
    name: `nagranie_${fileStamp(createdAt)}.${audioExt(mime)}`,
  });
}

async function startRecording() {
  if (rec || busyRec) return;
  busyRec = true;
  $('#rec-btn').disabled = true;
  const id = newId();
  const audioId = newId();
  const createdAt = Date.now();
  const session = new RecordingSession({
    lang,
    onTranscript: (t) => { renderLive(t); scheduleTranscriptSave(); },
    onSpeechStatus: renderSpeechStatus,
    onLevel: (v) => { $('#level-bar').style.width = `${Math.round(v * 100)}%`; },
    onChunk: (blob) => saveAudio(id, audioId, blob, session.mimeType, createdAt).catch(() => {}),
  });
  try {
    await session.start();
    rec = { id, audioId, session, createdAt };
    await db.putFragment({
      id, createdAt, updatedAt: createdAt, status: 'recording', kind: 'audio', langs: [lang],
      transcript: '', notes: '', audioId, durationMs: 0, location: null, weather: null, attachments: [],
    });
  } catch (err) {
    if (rec) await session.stop().catch(() => {});
    rec = null;
    busyRec = false;
    $('#rec-btn').disabled = false;
    toast(micErrorMessage(err));
    return;
  }
  setRecordingUI(true);
  renderLive({ text: '', interim: '' });
  const t0 = performance.now();
  $('#timer').textContent = '0:00';
  rec.timer = setInterval(() => { $('#timer').textContent = fmtDuration(performance.now() - t0); }, 500);
  captureContext(id);
  renderRecChips();
  acquireWakeLock();
  navigator.storage?.persist?.().catch(() => {});
  busyRec = false;
  $('#rec-btn').disabled = false;
}

function scheduleTranscriptSave() {
  if (!rec) return;
  clearTimeout(rec.saveTimer);
  const { id, session } = rec;
  rec.saveTimer = setTimeout(() => {
    db.patchFragment(id, { transcript: session.transcript, langs: session.langs }).catch(() => {});
  }, 2000);
}

async function stopRecording() {
  if (!rec || busyRec) return;
  busyRec = true;
  $('#rec-btn').disabled = true;
  const { id, audioId, session, createdAt } = rec;
  clearInterval(rec.timer);
  clearTimeout(rec.saveTimer);
  try {
    const r = await session.stop();
    clearTimeout(rec.saveTimer);
    await saveAudio(id, audioId, r.blob, r.mimeType, createdAt);
    await db.patchFragment(id, { status: 'done', durationMs: Math.round(r.durationMs), transcript: r.transcript, langs: r.langs });
  } catch (err) {
    toast(`Błąd zapisu nagrania: ${err.message}`);
  }
  rec.wakeLock?.release?.().catch(() => {});
  rec = null;
  busyRec = false;
  $('#rec-btn').disabled = false;
  setRecordingUI(false);
  navigate(`#/f/${id}`);
}

$('#rec-btn').addEventListener('click', () => (rec ? stopRecording() : startRecording()));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
  else flushSaves();
});
window.addEventListener('pagehide', () => flushSaves());

// ---------- wpis bez nagrania ----------
let focusNotes = false;
$('#text-entry').addEventListener('click', async () => {
  const id = newId();
  const now = Date.now();
  await db.putFragment({
    id, createdAt: now, updatedAt: now, status: 'done', kind: 'text', langs: [],
    transcript: '', notes: '', audioId: null, durationMs: 0, location: null, weather: null, attachments: [],
  });
  captureContext(id);
  focusNotes = true;
  navigate(`#/f/${id}`);
});

// ---------- lista ----------
function cardHtml(f) {
  const photos = f.attachments.filter((a) => a.kind === 'photo').length;
  const docs = f.attachments.filter((a) => a.kind === 'document').length;
  const meta = [
    timeFmt.format(f.createdAt),
    placeShort(f.location),
    weatherShort(f.weather),
    f.kind === 'audio' && f.durationMs ? `🎙 ${fmtDuration(f.durationMs)}` : '',
  ].filter(Boolean);
  const text = f.transcript || f.notes;
  const badges = [
    photos && `📷 ${photos}`,
    docs && `📄 ${docs}`,
    f.transcript && f.notes && '✎ notatka',
    f.status === 'interrupted' && '⚠ przerwane',
    f.status === 'recording' && '● nagrywanie',
  ].filter(Boolean);
  return `<a class="card" href="#/f/${encodeURIComponent(f.id)}">
    <div class="card-meta">${meta.map(esc).join('<span class="sep">·</span>')}</div>
    <p class="card-text${text ? '' : ' muted'}">${text ? esc(text) : '(bez tekstu)'}</p>
    ${badges.length ? `<div class="card-badges">${badges.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
  </a>`;
}

async function renderList() {
  const items = await db.getAllFragments();
  const list = $('#list');
  if (!items.length) {
    list.innerHTML = '<p class="empty">Nie ma jeszcze żadnych wpisów.</p>';
    return;
  }
  let html = '';
  let lastDay = '';
  for (const f of items) {
    const day = dayFmt.format(f.createdAt);
    if (day !== lastDay) {
      html += `<h2 class="day">${esc(day)}</h2>`;
      lastDay = day;
    }
    html += cardHtml(f);
  }
  list.innerHTML = html;
}

// ---------- szczegóły wpisu ----------
let currentId = null;
let audioUrl = null;
let attachmentUrls = [];

function revokeUrls() {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
  attachmentUrls.forEach((u) => URL.revokeObjectURL(u));
  attachmentUrls = [];
}

function locationHtml(f) {
  const loc = f.location;
  if (!loc) return isBusy(f.id) ? '📍 Ustalam lokalizację…' : '📍 Brak lokalizacji';
  if (loc.error) return `📍 ${esc(loc.error)}`;
  const map = `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}#map=15/${loc.lat}/${loc.lon}`;
  const extra = [`±${loc.accuracy} m`, loc.altitude != null ? `${loc.altitude} m n.p.m.` : ''].filter(Boolean).join(', ');
  return `📍 ${loc.place ? `<strong>${esc(loc.place)}</strong><br>` : ''}`
    + `<a href="${map}" target="_blank" rel="noopener">${coords(loc)}</a> <span class="muted">${esc(extra)}</span>`;
}

function weatherHtml(f) {
  const w = f.weather;
  if (f.location?.lat == null) return '';
  if (!w) return isBusy(f.id) && navigator.onLine ? '⏳ Pobieram pogodę…' : '<span class="muted">Pogoda: brak danych — uzupełni się po połączeniu z internetem.</span>';
  if (!hasWeather(w)) return '<span class="muted">Pogoda: niedostępna.</span>';
  const d = describeWeather(w);
  const details = [
    w.apparentTemperature != null && `odczuwalna ${Math.round(w.apparentTemperature)}°C`,
    w.windSpeed != null && `wiatr ${Math.round(w.windSpeed)} km/h ${windDir(w.windDirection)}`,
    w.humidity != null && `wilgotność ${w.humidity}%`,
    w.precipitation ? `opad ${w.precipitation} mm` : '',
    w.backfilled && 'dane uzupełnione później',
  ].filter(Boolean);
  return `${d.icon} <strong>${Math.round(w.temperature)}°C</strong>, ${esc(d.text.toLowerCase())}<br><span class="muted">${esc(details.join(' · '))}</span>`;
}

const contextHtml = (f) => [locationHtml(f), weatherHtml(f)].filter(Boolean).map((h) => `<p>${h}</p>`).join('');

async function refreshContext(id) {
  const f = await db.getFragment(id);
  const el = $('#context');
  if (f && el && currentId === id) el.innerHTML = contextHtml(f);
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

async function renderDetail(id) {
  const view = $('#view-detail');
  const f = await db.getFragment(id);
  revokeUrls();
  currentId = id;
  if (!f) {
    view.innerHTML = '<p class="empty">Nie znaleziono wpisu.</p>';
    return;
  }
  const langs = (f.langs || []).map(langLabel).join(', ');
  view.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="detail-date">${esc(dayFmt.format(f.createdAt))}</div>
        <div class="detail-time">${esc(timeFmt.format(f.createdAt))}${f.durationMs ? ` · 🎙 ${fmtDuration(f.durationMs)}` : ''}</div>
        ${f.status === 'interrupted' ? '<span class="badge warn">Nagranie przerwane — zapisano to, co się udało</span>' : ''}
      </div>
      <button type="button" class="icon-btn danger" id="delete" aria-label="Usuń wpis" title="Usuń wpis">🗑</button>
    </div>
    <section class="context" id="context">${contextHtml(f)}</section>
    ${f.audioId ? '<section class="block"><h3>Nagranie</h3><div id="audio-slot" class="muted">Wczytuję…</div></section>' : ''}
    ${f.kind === 'audio' ? `<section class="block">
      <h3>Transkrypcja ${langs ? `<span class="muted">(${esc(langs)})</span>` : ''}</h3>
      <textarea id="transcript" rows="4" placeholder="Brak transkrypcji — możesz ją wpisać ręcznie.">${esc(f.transcript)}</textarea>
    </section>` : ''}
    <section class="block">
      <h3>Notatki</h3>
      <textarea id="notes" rows="3" placeholder="Dopisz coś od siebie…">${esc(f.notes)}</textarea>
    </section>
    <section class="block">
      <h3>Zdjęcia</h3>
      <div class="photos" id="photos"></div>
      <label class="btn"><input type="file" id="add-photo" accept="image/*" multiple hidden>📷 Dodaj zdjęcie</label>
    </section>
    <section class="block">
      <h3>Dokumenty</h3>
      <ul class="docs" id="docs"></ul>
      <label class="btn"><input type="file" id="add-doc" multiple hidden>📄 Dodaj dokument</label>
    </section>
    <p class="save-state" id="save-state" aria-live="polite"></p>`;

  for (const field of ['transcript', 'notes']) {
    const ta = $(`#${field}`, view);
    if (!ta) continue;
    autosize(ta);
    ta.addEventListener('input', () => { autosize(ta); scheduleSave(id, field, ta.value); });
    ta.addEventListener('blur', flushSaves);
  }
  $('#delete', view).addEventListener('click', async () => {
    if (!confirm('Usunąć ten wpis razem z nagraniem i załącznikami?')) return;
    await db.deleteFragment(id);
    goBack();
  });
  $('#add-photo', view).addEventListener('change', (e) => addFiles(id, e.target, 'photo'));
  $('#add-doc', view).addEventListener('change', (e) => addFiles(id, e.target, 'document'));

  if (f.audioId) renderAudio(f);
  renderAttachments(f);
  if (focusNotes) {
    focusNotes = false;
    $('#notes', view).focus();
  }
}

async function renderAudio(f) {
  const slot = $('#audio-slot');
  const file = await db.getFile(f.audioId);
  if (!slot || currentId !== f.id) return;
  if (!file) {
    slot.textContent = 'Brak pliku nagrania.';
    return;
  }
  audioUrl = URL.createObjectURL(file.blob);
  slot.classList.remove('muted');
  slot.innerHTML = `<audio controls preload="metadata" src="${audioUrl}"></audio>
    <a class="small-link" href="${audioUrl}" download="${esc(file.name)}">⬇ Pobierz nagranie (${fmtSize(file.size)})</a>`;
  // Nagrania webm z MediaRecorder nie mają długości w nagłówku — wymuś jej wyliczenie.
  const audio = $('audio', slot);
  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration !== Infinity && !Number.isNaN(audio.duration)) return;
    audio.currentTime = 1e101;
    audio.addEventListener('timeupdate', () => { audio.currentTime = 0; }, { once: true });
  }, { once: true });
}

async function renderAttachments(f) {
  const photosEl = $('#photos');
  const docsEl = $('#docs');
  if (!photosEl || currentId !== f.id) return;
  attachmentUrls.forEach((u) => URL.revokeObjectURL(u));
  attachmentUrls = [];
  const items = [];
  for (const a of f.attachments) {
    const file = await db.getFile(a.id);
    if (file) items.push({ ...a, url: URL.createObjectURL(file.blob) });
  }
  if (currentId !== f.id) return items.forEach((i) => URL.revokeObjectURL(i.url));
  attachmentUrls = items.map((i) => i.url);
  photosEl.innerHTML = items.filter((i) => i.kind === 'photo').map((i) => `
    <figure class="photo">
      <button type="button" class="photo-open" data-url="${i.url}" aria-label="Powiększ ${esc(i.name)}"><img src="${i.url}" alt="${esc(i.name)}" loading="lazy"></button>
      <button type="button" class="remove" data-remove="${esc(i.id)}" aria-label="Usuń zdjęcie">✕</button>
    </figure>`).join('');
  docsEl.innerHTML = items.filter((i) => i.kind === 'document').map((i) => `
    <li>
      <a href="${i.url}" download="${esc(i.name)}">📄 ${esc(i.name)}</a>
      <span class="muted">${fmtSize(i.size)}</span>
      <button type="button" class="remove" data-remove="${esc(i.id)}" aria-label="Usuń dokument">✕</button>
    </li>`).join('');
}

$('#view-detail').addEventListener('click', async (e) => {
  const open = e.target.closest('.photo-open');
  if (open) {
    $('#lightbox img').src = open.dataset.url;
    $('#lightbox').showModal();
    return;
  }
  const remove = e.target.closest('[data-remove]');
  if (remove && currentId) {
    if (!confirm('Usunąć ten załącznik?')) return;
    const id = currentId;
    await db.removeAttachment(id, remove.dataset.remove);
    const f = await db.getFragment(id);
    if (f) renderAttachments(f);
  }
});

async function addFiles(id, input, kind) {
  const files = [...input.files];
  input.value = '';
  for (const file of files) {
    try {
      // Kopia w pamięci — pliki z pickera (np. z chmury) nie zawsze dają się później odczytać.
      const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'application/octet-stream' });
      await db.addAttachment(id, {
        id: newId(), kind, blob, type: blob.type, size: blob.size,
        name: file.name || (kind === 'photo' ? `zdjecie_${fileStamp(Date.now())}.jpg` : 'dokument'),
      });
    } catch (err) {
      toast(err?.name === 'QuotaExceededError' ? 'Brak miejsca w pamięci przeglądarki.' : `Nie udało się dodać pliku: ${err.message}`);
    }
  }
  const f = await db.getFragment(id);
  if (f) renderAttachments(f);
}

// ---------- autozapis pól tekstowych ----------
const pendingSaves = new Map();

function setSaveState(text) {
  const el = $('#save-state');
  if (el) el.textContent = text;
}

function scheduleSave(id, field, value) {
  const key = `${id}:${field}`;
  clearTimeout(pendingSaves.get(key)?.timer);
  const run = async () => {
    pendingSaves.delete(key);
    try {
      await db.patchFragment(id, { [field]: value });
      if (!pendingSaves.size) setSaveState('Zapisano ✓');
    } catch (err) {
      setSaveState(`Błąd zapisu: ${err.message}`);
    }
  };
  pendingSaves.set(key, { run, timer: setTimeout(run, 600) });
  setSaveState('Zapisywanie…');
}

function flushSaves() {
  return Promise.all([...pendingSaves.values()].map(({ run, timer }) => {
    clearTimeout(timer);
    return run();
  }));
}

// Pusty wpis tekstowy (bez notatki i załączników) nie zostaje na liście.
async function dropIfEmpty(id) {
  const f = await db.getFragment(id);
  if (f && f.kind === 'text' && !f.notes.trim() && !f.attachments.length) await db.deleteFragment(id);
}

// ---------- routing ----------
let prevView = null;

function route() {
  const m = location.hash.match(/^#\/f\/(.+)$/);
  return m ? { view: 'detail', id: decodeURIComponent(m[1]) } : { view: 'list' };
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function goBack() {
  if (prevView === 'list') history.back();
  else navigate('#/');
}

async function render() {
  const r = route();
  if (rec && r.view !== 'list') {
    history.replaceState(null, '', '#/');
    return render();
  }
  if (currentId && (r.view !== 'detail' || r.id !== currentId)) {
    const leaving = currentId;
    await flushSaves();
    currentId = null;
    revokeUrls();
    await dropIfEmpty(leaving);
  }
  $('#view-list').hidden = r.view !== 'list';
  $('#view-detail').hidden = r.view !== 'detail';
  $('#back').hidden = r.view === 'list';
  if (r.view === 'list') {
    $('#view-detail').innerHTML = '';
    await renderList();
  } else {
    await renderDetail(r.id);
    window.scrollTo(0, 0);
  }
  prevView = r.view;
}

window.addEventListener('hashchange', render);
$('#back').addEventListener('click', (e) => {
  e.preventDefault();
  goBack();
});

// Odśwież widok, gdy w tle dojdzie lokalizacja/pogoda.
let listTimer;
db.changes.addEventListener('change', (e) => {
  const { id } = e.detail;
  if (rec?.id === id) renderRecChips();
  if (currentId === id) refreshContext(id);
  if (!rec && route().view === 'list') {
    clearTimeout(listTimer);
    listTimer = setTimeout(renderList, 150);
  }
});

// ---------- ustawienia ----------
async function updateOfflineRow(code) {
  const status = $(`#settings li[data-lang="${code}"] .status`);
  if (!status) return;
  const st = await offlineSpeech.status(code);
  if (st === 'downloadable') {
    status.innerHTML = '<button type="button" class="btn small">Pobierz</button>';
    $('button', status).addEventListener('click', async () => {
      status.textContent = 'pobieranie…';
      const ok = await offlineSpeech.install(code);
      if (!ok) toast('Nie udało się pobrać modelu rozpoznawania mowy.');
      updateOfflineRow(code);
    });
  } else {
    status.textContent = { available: '✓ pobrany', downloading: 'pobieranie…', unavailable: 'niedostępny' }[st] ?? st;
  }
}

$('#settings-btn').addEventListener('click', async () => {
  let html = '<h3>Transkrypcja</h3>';
  if (!speechSupported) {
    html += '<p>Ta przeglądarka nie obsługuje rozpoznawania mowy — nagrywany jest sam dźwięk. Użyj Chrome (Android) lub Safari (iPhone).</p>';
  } else {
    html += '<p>Transkrypcja działa na żywo w trakcie nagrania. Język możesz zmienić także w trakcie. Zwykle wymaga internetu.</p>';
    html += offlineSpeech.supported
      ? `<p>Rozpoznawanie offline (na urządzeniu):</p><ul class="offline-list">${LANGS.map((l) =>
        `<li data-lang="${l.code}"><span>${esc(l.name)}</span><span class="status muted">sprawdzam…</span></li>`).join('')}</ul>`
      : '<p class="muted">Ta przeglądarka nie oferuje rozpoznawania mowy offline — bez internetu zapisze się sam dźwięk.</p>';
  }
  html += '<h3>Dane</h3><p id="storage-info" class="muted">…</p>';
  $('#settings-body').innerHTML = html;
  $('#settings').showModal();
  if (speechSupported && offlineSpeech.supported) LANGS.forEach((l) => updateOfflineRow(l.code));

  const count = (await db.getAllFragments()).length;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('#storage-info').textContent = [
    `Wpisów: ${count}.`,
    est ? `Zajęte miejsce: ${fmtSize(est.usage || 0)}.` : '',
    'Wszystko jest zapisane tylko na tym urządzeniu.',
    persisted ? 'Przeglądarka nie usunie danych automatycznie.' : 'Zainstaluj aplikację na ekranie głównym, żeby przeglądarka nie usunęła danych przy braku miejsca.',
  ].filter(Boolean).join(' ');
});

// ---------- start ----------
async function init() {
  renderLangs();
  renderHint();
  if (!window.isSecureContext) toast('Mikrofon i lokalizacja działają tylko przez HTTPS (lub na localhost).', 10000);
  // Nagrania przerwane (np. zamknięta karta) — audio zapisane do ostatnich 10 s zostaje.
  for (const f of await db.getAllFragments()) {
    if (f.status === 'recording') await db.patchFragment(f.id, { status: 'interrupted' });
  }
  await render();
  backfillContext();
  window.addEventListener('online', () => backfillContext());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
