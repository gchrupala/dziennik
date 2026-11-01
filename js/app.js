import * as db from './db.js?v=202611011130';
import { RecordingSession, LANGS, speechSupported, offlineSpeech, isAndroid, METHOD, describeMethods, addMethod } from './recorder.js?v=202611011130';
import { captureContext, backfillContext, describeWeather, windDir, isBusy, groupFragments, distanceM, GROUP_DIST_M } from './context.js?v=202611011130';
import * as whisper from './whisper.js?v=202611011130';
import * as sync from './sync.js?v=202611011130';
import * as pics from './photos.js?v=202611011130';
import * as share from './share.js?v=202611011130';
import { mapHtml, renderMaps } from './map.js?v=202611011130';

const APP_VERSION = '202611011130'; // podbijaj skryptem tools/bump-version.sh

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
// `action`: { label, fn } — przycisk w komunikacie (np. „Cofnij”).
function toast(msg, ms = 4500, action = null) {
  const el = $('#toast');
  el.textContent = msg;
  if (action) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'toast-action', textContent: action.label });
    btn.addEventListener('click', () => {
      el.hidden = true;
      action.fn();
    });
    el.append(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- język transkrypcji ----------
const LANG_KEY = 'dziennik.lang';

// Urządzenie (zapisywane we wpisach i w wyniku testu szybkości). Chrome ukrywa model telefonu w zwykłym
// userAgent — prawdziwy podaje userAgentData.getHighEntropyValues.
let deviceInfo = null;
async function getDevice() {
  if (deviceInfo) return deviceInfo;
  const ua = navigator.userAgentData;
  let v = {};
  try { v = (await ua?.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList'])) || {}; } catch { /* brak */ }
  const brand = v.fullVersionList?.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand));
  deviceInfo = {
    model: v.model || null,
    platform: ua?.platform || navigator.platform || null,
    platformVersion: v.platformVersion || null,
    browser: brand ? `${brand.brand} ${brand.version}` : null,
    userAgent: navigator.userAgent,
  };
  return deviceInfo;
}
getDevice();
// Automatyczne zakończenie nagrania po tylu sekundach ciszy (0 = wyłączone).
const AUTOSTOP_KEY = 'dziennik.autoStop';
const AUTOSTOP_OPTIONS = [[0, 'nie kończ'], [30, 'po 30 s'], [60, 'po 1 min'], [120, 'po 2 min']];
const autoStopSec = () => {
  const v = Number(localStorage.getItem(AUTOSTOP_KEY) ?? 60);
  return Number.isFinite(v) ? v : 60;
};
const SILENCE_WARN_MS = 10000;
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
let reloadPending = false; // nowa wersja czeka, aż skończy się nagrywanie
const reloadIfPending = () => { if (reloadPending && !rec && !busyRec) location.reload(); };

function setRecordingUI(on) {
  document.body.classList.toggle('recording', on);
  $('#rec-btn').setAttribute('aria-label', on ? 'Zakończ nagrywanie' : 'Nagrywaj');
  for (const sel of ['#rec-meta', '#rec-chips', '#live']) $(sel).hidden = !on;
  for (const sel of ['#rec-hint', '#text-entry', '#list']) $(sel).hidden = on;
  if (!on) $('#speech-status').hidden = true;
  if (!on) $('#silence-note').hidden = true;
}

function renderHint() {
  const hint = $('#rec-hint');
  hint.innerHTML = speechSupported || whisper.ready()
    ? 'Naciśnij, aby nagrać fragment. Dźwięk, transkrypcja, lokalizacja i pogoda zapiszą się same.'
    : 'Ta przeglądarka nie obsługuje transkrypcji na żywo — pobierz model offline w Ustawieniach.';
  if (whisper.supported && !whisper.ready()) {
    hint.innerHTML += '<br><button type="button" class="link-btn warn" data-open-settings>⚠ Transkrypcja bez internetu wymaga jednorazowego pobrania modelu — Ustawienia</button>';
  }
}

$('#rec-hint').addEventListener('click', (e) => { if (e.target.closest('[data-open-settings]')) openSettings(); });

function renderLive({ text, interim, pending }) {
  const el = $('#live');
  el.innerHTML = text || interim
    ? `${esc(text)} <span class="interim">${esc(interim)}</span>`
    : '<span class="interim">Mów…</span>';
  if (pending) el.innerHTML += ` <span class="interim">⏳ (przetwarzam ${pending})</span>`;
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
      appVersion: APP_VERSION, autoStopSec: autoStopSec(), device: await getDevice(),
    });
  } catch (err) {
    if (rec) await session.stop().catch(() => {});
    rec = null;
    busyRec = false;
    $('#rec-btn').disabled = false;
    toast(micErrorMessage(err));
    reloadIfPending();
    return;
  }
  setRecordingUI(true);
  renderLive({ text: '', interim: '' });
  const t0 = performance.now();
  $('#timer').textContent = '0:00';
  rec.timer = setInterval(() => {
    $('#timer').textContent = fmtDuration(performance.now() - t0);
    checkSilence(session);
  }, 500);
  captureContext(id);
  renderRecChips();
  acquireWakeLock();
  navigator.storage?.persist?.().catch(() => {});
  busyRec = false;
  $('#rec-btn').disabled = false;
}

// Długa cisza → nagranie kończy się samo (ostatnie 10 s z odliczaniem; odezwanie się je przerywa).
function checkSilence(session) {
  const limit = autoStopSec() * 1000;
  const note = $('#silence-note');
  const left = limit - session.silentMs();
  if (!limit || !rec || rec.session !== session || left > SILENCE_WARN_MS) {
    note.hidden = true;
    return;
  }
  if (left <= 0) {
    note.hidden = true;
    toast(`Nagranie zakończone po ${autoStopSec()} s ciszy.`);
    stopRecording();
    return;
  }
  note.textContent = `Cisza — nagranie zakończy się za ${Math.ceil(left / 1000)} s. Powiedz coś, żeby nagrywać dalej.`;
  note.hidden = false;
}

function scheduleTranscriptSave() {
  if (!rec) return;
  clearTimeout(rec.saveTimer);
  const { id, session } = rec;
  rec.saveTimer = setTimeout(() => {
    db.patchFragment(id, { transcript: session.transcript, langs: session.langs, transcribedBy: [...session.methods] }).catch(() => {});
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
    await db.patchFragment(id, {
      status: 'done', durationMs: Math.round(r.durationMs), transcript: r.transcript, langs: r.langs, transcribing: r.pending > 0,
      transcribedBy: [...r.methods],
    });
    // Whisper kończy ostatnie fragmenty w tle — zapisz pełny tekst, gdy skończy.
    // Rozpoznawanie nic nie dało albo nie dostawało dźwięku — przepisz całe nagranie Whisperem.
    const redo = (r.stalled || !r.transcript.trim()) && r.blob.size && whisper.ready();
    if (r.pending > 0) {
      r.done.then((transcript) => db.patchFragment(id, { transcript, transcribing: false, transcribedBy: [...r.methods] }))
        .then(() => { if (redo) transcribeFragment(id); });
    } else if (redo) transcribeFragment(id);
  } catch (err) {
    toast(`Błąd zapisu nagrania: ${err.message}`);
  }
  rec.wakeLock?.release?.().catch(() => {});
  rec = null;
  busyRec = false;
  $('#rec-btn').disabled = false;
  setRecordingUI(false);
  navigate(`#/f/${id}`);
  reloadIfPending();
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
    appVersion: APP_VERSION, device: await getDevice(),
  });
  captureContext(id);
  focusNotes = true;
  navigate(`#/f/${id}`);
});

// ---------- lista ----------
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const entriesLabel = (n) => {
  const few = n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14);
  return `${n} ${n === 1 ? 'wpis' : few ? 'wpisy' : 'wpisów'}`;
};

// ---------- zaznaczanie (długie przytrzymanie karty lub nagłówka grupy) i usuwanie z „Cofnij” ----------
const selected = new Set();
const hiddenIds = new Set(); // usunięte, ale jeszcze do cofnięcia
let pendingDelete = null; // { ids, timer }
const UNDO_MS = 6000;
const LONG_PRESS_MS = 500;

function updateSelectionUI() {
  for (const el of document.querySelectorAll('#list [data-id]')) el.classList.toggle('selected', selected.has(el.dataset.id));
  for (const el of document.querySelectorAll('#list [data-ids]')) {
    el.classList.toggle('selected', el.dataset.ids.split(',').every((id) => selected.has(id)));
  }
  $('#select-bar').hidden = !selected.size;
  $('#select-count').textContent = `Zaznaczono: ${selected.size}`;
  document.body.classList.toggle('selecting', selected.size > 0);
}

function toggleSelect(el) {
  const ids = el.dataset.ids ? el.dataset.ids.split(',') : [el.dataset.id];
  const all = ids.every((id) => selected.has(id));
  for (const id of ids) {
    if (all) selected.delete(id);
    else selected.add(id);
  }
  updateSelectionUI();
}

function clearSelection() {
  selected.clear();
  updateSelectionUI();
}

// Usunięcie naprawdę (z IndexedDB i — przy synchronizacji — z repo) dopiero po czasie na „Cofnij”.
async function commitDelete() {
  if (!pendingDelete) return;
  const { ids, timer } = pendingDelete;
  pendingDelete = null;
  clearTimeout(timer);
  for (const id of ids) {
    sync.markDeleted(id);
    await db.deleteFragment(id);
    hiddenIds.delete(id);
  }
}

async function deleteSelected() {
  const ids = [...selected].filter((id) => id !== rec?.id);
  clearSelection();
  if (!ids.length) return;
  await commitDelete(); // poprzednie usunięcie przestaje być do cofnięcia
  ids.forEach((id) => hiddenIds.add(id));
  renderList();
  pendingDelete = { ids, timer: setTimeout(commitDelete, UNDO_MS) };
  toast(`Usunięto ${entriesLabel(ids.length)}.`, UNDO_MS, {
    label: 'Cofnij',
    fn: () => {
      if (pendingDelete?.ids !== ids) return;
      clearTimeout(pendingDelete.timer);
      pendingDelete = null;
      ids.forEach((id) => hiddenIds.delete(id));
      renderList();
    },
  });
}

{
  const list = $('#list');
  let timer = null;
  let start = null;
  let suppressClick = false; // po długim przytrzymaniu nie otwieraj karty
  const target = (e) => e.target.closest('.card, .group-head');
  list.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    const t = target(e);
    if (!t) return;
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      navigator.vibrate?.(15);
      toggleSelect(t);
    }, LONG_PRESS_MS);
  });
  const cancel = () => { clearTimeout(timer); timer = null; };
  list.addEventListener('pointerup', cancel);
  list.addEventListener('pointercancel', cancel);
  list.addEventListener('pointermove', (e) => {
    if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  // Długie przytrzymanie odnośnika otwiera menu przeglądarki — nie na kartach.
  list.addEventListener('contextmenu', (e) => { if (target(e)) e.preventDefault(); });
  list.addEventListener('click', (e) => {
    const t = target(e);
    if (!t) return;
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
    } else if (selected.size) {
      e.preventDefault();
      toggleSelect(t);
    }
  }, true);
  $('#select-cancel').addEventListener('click', clearSelection);
  $('#select-delete').addEventListener('click', deleteSelected);
  // Zamknięcie aplikacji kończy czas na „Cofnij”.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') commitDelete(); });
}

// `groupHref`: karta w grupie prowadzi do widoku grupy (przewiniętego do tego wpisu).
function cardHtml(f, groupHref = null) {
  const inGroup = Boolean(groupHref);
  const photos = f.attachments.filter((a) => a.kind === 'photo').length;
  const docs = f.attachments.filter((a) => a.kind === 'document').length;
  const meta = [
    timeFmt.format(f.createdAt),
    !inGroup && placeShort(f.location), // w grupie miejsce i pogoda są w nagłówku
    !inGroup && weatherShort(f.weather),
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
  return `<a class="card${selected.has(f.id) ? ' selected' : ''}" data-id="${esc(f.id)}" href="${groupHref || `#/f/${encodeURIComponent(f.id)}`}">
    <div class="card-meta">${meta.map(esc).join('<span class="sep">·</span>')}</div>
    <p class="card-text${text ? '' : ' muted'}">${text ? esc(text) : '(bez tekstu)'}</p>
    ${badges.length ? `<div class="card-badges">${badges.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
  </a>`;
}

async function renderList() {
  const items = (await db.getAllFragments()).filter((f) => !hiddenIds.has(f.id));
  const list = $('#list');
  if (!items.length) {
    list.innerHTML = '<p class="empty">Nie ma jeszcze żadnych wpisów.</p>';
    return;
  }
  let html = '';
  let lastDay = '';
  // Najnowsze na górze; bliskie w czasie i miejscu wpisy razem (wewnątrz grupy chronologicznie).
  for (const group of groupFragments(items).reverse()) {
    const first = group[0];
    const day = dayFmt.format(first.createdAt);
    if (day !== lastDay) {
      html += `<h2 class="day"><a href="#/d/${dayKey(first.createdAt)}">${esc(day)}<span class="read-day">czytaj cały dzień ›</span></a></h2>`;
      lastDay = day;
    }
    if (group.length === 1) {
      html += cardHtml(first);
      continue;
    }
    const placed = group.find((f) => f.location?.lat != null);
    const head = [
      `${timeFmt.format(first.createdAt)}–${timeFmt.format(group.at(-1).createdAt)}`,
      placed && placeShort(placed.location),
      weatherShort(group.find((f) => hasWeather(f.weather))?.weather),
      entriesLabel(group.length),
    ].filter(Boolean);
    const g = encodeURIComponent(first.id);
    const allSel = group.every((f) => selected.has(f.id));
    html += `<div class="group"><a class="group-head${allSel ? ' selected' : ''}" data-ids="${esc(group.map((f) => f.id).join(','))}" href="#/g/${g}">${head.map(esc).join('<span class="sep">·</span>')}</a>
      ${group.map((f) => cardHtml(f, `#/g/${g}/${encodeURIComponent(f.id)}`)).join('')}</div>`;
  }
  list.innerHTML = html;
}

// ---------- szczegóły wpisu ----------
let currentId = null;
let editing = false; // szczegóły: domyślnie tylko do czytania; edycja (zmiany, usuwanie) po „Edytuj”
let openEditing = false; // następne otwarcie wpisu od razu w edycji („Edytuj” w widoku grupy/dnia)
let returnAfterEdit = false; // „Gotowe” wraca do widoku grupy/dnia
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

const para = (h) => (h ? `<p>${h}</p>` : '');
const contextHtml = (f) => para(locationHtml(f)) + mapHtml(f.location) + para(weatherHtml(f));

async function refreshContext(id) {
  const f = await db.getFragment(id);
  const el = $('#context');
  if (f && el && currentId === id) {
    // Tylko przy zmianie (np. doszła pogoda) — inaczej mapka migałaby przy każdym zapisie.
    const html = contextHtml(f);
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
      renderMaps(el);
    }
    refreshTranscript(f);
    const ph = $('#photos');
    if (ph && ph.dataset.key !== attachmentsKey(f)) renderAttachments(f);
  }
}

// Gdy Whisper pracuje w tle, pole transkrypcji jest tylko do odczytu i aktualizuje się samo.
function refreshTranscript(f) {
  if (currentId !== f.id) return;
  const busy = Boolean(f.transcribing);
  const read = $('#transcript-read');
  if (read) read.innerHTML = readHtml(f.transcript, 'Brak transkrypcji.');
  const ta = $('#transcript');
  if (!ta && !read) return;
  if (ta && (busy || ta.readOnly)) {
    ta.value = f.transcript;
    autosize(ta);
  }
  if (ta) ta.readOnly = busy;
  const by = $('#transcribed-by');
  if (by) {
    by.textContent = `Transkrypcja: ${describeMethods(f.transcribedBy)}`;
    by.hidden = !f.transcribedBy?.length;
  }
  $('#transcribing').hidden = !busy;
  const btn = $('#whisper-btn');
  if (btn) btn.hidden = busy;
}

// Transkrypcja całego zapisanego nagrania Whisperem (np. nagranie bez internetu, przerwane, zły język).
const transcribingNow = new Set();
async function transcribeFragment(id) {
  if (transcribingNow.has(id) || !whisper.ready()) return;
  transcribingNow.add(id);
  try {
    const f = await db.getFragment(id);
    const file = f?.audioId && await db.getFile(f.audioId);
    if (!file) return;
    await db.patchFragment(id, { transcribing: true });
    const audio = await whisper.decodeBlob(file.blob);
    const text = await whisper.transcribeLong(audio, f.langs?.[0] || lang);
    // Tekst z całego nagrania zastępuje poprzedni, więc i sposób jest tylko ten jeden.
    await db.patchFragment(id, { transcript: text, transcribing: false, transcribedBy: text ? [METHOD.afterWhisper()] : [] });
  } catch (err) {
    await db.patchFragment(id, { transcribing: false });
    toast(`Transkrypcja offline nie powiodła się: ${err.message}`);
  } finally {
    transcribingNow.delete(id);
  }
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

async function renderDetail(id) {
  const view = $('#view-detail');
  const f = await db.getFragment(id);
  revokeUrls();
  // Nowy wpis bez nagrania i „Edytuj” z widoku grupy/dnia otwierają się od razu do edycji.
  if (currentId !== id) {
    editing = focusNotes || openEditing;
    returnAfterEdit = openEditing;
    openEditing = false;
  }
  currentId = id;
  if (!f) {
    view.innerHTML = '<p class="empty">Nie znaleziono wpisu.</p>';
    return;
  }
  if (!editing) return renderReading(f);
  const langs = (f.langs || []).map(langLabel).join(', ');
  view.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="detail-date">${esc(dayFmt.format(f.createdAt))}</div>
        <div class="detail-time">${esc(timeFmt.format(f.createdAt))}${f.durationMs ? ` · 🎙 ${fmtDuration(f.durationMs)}` : ''}</div>
        ${f.status === 'interrupted' ? '<span class="badge warn">Nagranie przerwane — zapisano to, co się udało</span>' : ''}
      </div>
      <div class="detail-actions">
        <button type="button" class="icon-btn danger" id="delete" aria-label="Usuń wpis" title="Usuń wpis">🗑</button>
        <button type="button" class="btn small primary" id="done">✓ Gotowe</button>
      </div>
    </div>
    <p class="edit-note">Tryb edycji — zmiany zapisują się same.</p>
    <section class="context" id="context">${contextHtml(f)}</section>
    ${f.audioId ? '<section class="block"><h3>Nagranie</h3><div id="audio-slot" class="muted">Wczytuję…</div></section>' : ''}
    ${f.kind === 'audio' ? `<section class="block">
      <h3>Transkrypcja ${langs ? `<span class="muted">(${esc(langs)})</span>` : ''}</h3>
      <textarea id="transcript" rows="4" placeholder="Brak transkrypcji — możesz ją wpisać ręcznie.">${esc(f.transcript)}</textarea>
      <p class="muted small" id="transcribed-by"${f.transcribedBy?.length ? '' : ' hidden'}>Transkrypcja: ${esc(describeMethods(f.transcribedBy))}</p>
      <p class="transcribing muted" id="transcribing" hidden>⏳ Transkrypcja offline (Whisper) w toku…</p>
      ${f.audioId && whisper.ready() ? '<button type="button" class="link-btn" id="whisper-btn">🎧 Transkrybuj nagranie offline (Whisper)</button>' : ''}
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
    sync.markDeleted(id);
    await db.deleteFragment(id);
    goBack();
  });
  $('#done', view).addEventListener('click', async () => {
    await flushSaves();
    editing = false;
    if (returnAfterEdit) {
      scrollTarget = id;
      history.back();
    } else renderDetail(id);
  });
  $('#add-photo', view).addEventListener('change', (e) => addFiles(id, e.target, 'photo'));
  $('#add-doc', view).addEventListener('change', (e) => addFiles(id, e.target, 'document'));

  $('#whisper-btn', view)?.addEventListener('click', async () => {
    const cur = await db.getFragment(id);
    if (cur?.transcript.trim() && !confirm('Zastąpić obecną transkrypcję wynikiem z Whispera?')) return;
    transcribeFragment(id);
  });

  $('#context').dataset.html = contextHtml(f);
  renderMaps($('#context'));
  if (f.audioId) renderAudio(f);
  renderAttachments(f);
  refreshTranscript(f);
  if (focusNotes) {
    focusNotes = false;
    $('#notes', view).focus();
  }
}

// Tekst do czytania: akapity z podziałów wierszy.
const readHtml = (text, empty) => (text?.trim()
  ? text.trim().split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
  : `<p class="muted">${esc(empty)}</p>`);

// Widok do czytania: bez pól edycji, bez usuwania.
function renderReading(f) {
  const view = $('#view-detail');
  const id = f.id;
  const langs = (f.langs || []).map(langLabel).join(', ');
  view.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="detail-date">${esc(dayFmt.format(f.createdAt))}</div>
        <div class="detail-time">${esc(timeFmt.format(f.createdAt))}${f.durationMs ? ` · 🎙 ${fmtDuration(f.durationMs)}` : ''}</div>
        ${f.status === 'interrupted' ? '<span class="badge warn">Nagranie przerwane — zapisano to, co się udało</span>' : ''}
      </div>
      <div class="detail-actions">${shareBtn()}<button type="button" class="btn small" id="edit">✎ Edytuj</button></div>
    </div>
    <section class="context" id="context">${contextHtml(f)}</section>
    ${f.audioId ? '<section class="block"><div id="audio-slot" class="muted">Wczytuję…</div></section>' : ''}
    ${f.kind === 'audio' ? `<section class="block">
      <h3>Transkrypcja ${langs ? `<span class="muted">(${esc(langs)})</span>` : ''}</h3>
      <div class="read-text" id="transcript-read">${readHtml(f.transcript, 'Brak transkrypcji.')}</div>
      <p class="muted small" id="transcribed-by"${f.transcribedBy?.length ? '' : ' hidden'}>Transkrypcja: ${esc(describeMethods(f.transcribedBy))}</p>
      <p class="transcribing muted" id="transcribing" hidden>⏳ Transkrypcja offline (Whisper) w toku…</p>
    </section>` : ''}
    ${f.notes?.trim() || f.kind !== 'audio' ? `<section class="block">
      <h3>Notatki</h3>
      <div class="read-text">${readHtml(f.notes, 'Brak notatki.')}</div>
    </section>` : ''}
    <section class="block" id="photos-block" hidden><h3>Zdjęcia</h3><div class="photos" id="photos"></div></section>
    <section class="block" id="docs-block" hidden><h3>Dokumenty</h3><ul class="docs" id="docs"></ul></section>`;
  $('#edit', view).addEventListener('click', () => {
    editing = true;
    renderDetail(id);
  });
  $('#share', view).addEventListener('click', async () => {
    const cur = await db.getFragment(id);
    if (cur) shareGroups([[cur]]);
  });
  $('#context').dataset.html = contextHtml(f);
  renderMaps($('#context'));
  if (f.audioId) renderAudio(f);
  renderAttachments(f);
  refreshTranscript(f);
}

// ---------- udostępnianie (widoki do czytania): jeden plik HTML, js/share.js ----------
const SHARE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7c0 .3 0 .5.1.8L8.4 11.2a3 3 0 1 0 0 3.6l6.7 3.4A3 3 0 1 0 18 16z"/></svg>';
const shareBtn = () => `<button type="button" class="icon-btn" id="share" aria-label="Udostępnij" title="Udostępnij">${SHARE_ICON}</button>`;
const shareGroups = (groups) => share.shareGroups(groups, toast);

// ---------- czytanie grupy i całego dnia ----------
let scrollTarget = null; // wpis, do którego przewinąć widok grupy/dnia
let seqObserver = null;
let seqIds = new Set(); // wpisy pokazane w widoku grupy/dnia (odświeżanie transkrypcji)

const groupMapHtml = (group) => mapHtml(group.find((f) => f.location?.lat != null)?.location);

function groupHeadHtml(group) {
  const first = group[0];
  const placed = group.find((f) => f.location?.lat != null);
  const time = group.length > 1
    ? `${timeFmt.format(first.createdAt)}–${timeFmt.format(group.at(-1).createdAt)}`
    : timeFmt.format(first.createdAt);
  const w = group.find((f) => hasWeather(f.weather))?.weather;
  return [time, placed && placeShort(placed.location), w && `${weatherShort(w)}, ${describeWeather(w).text.toLowerCase()}`]
    .filter(Boolean).map(esc).join('<span class="sep">·</span>');
}

function entryHtml(f) {
  const photos = f.attachments.filter((a) => a.kind === 'photo');
  const docs = f.attachments.filter((a) => a.kind === 'document');
  const head = [timeFmt.format(f.createdAt), f.durationMs ? `🎙 ${fmtDuration(f.durationMs)}` : '',
    f.status === 'interrupted' ? '⚠ przerwane' : '', f.status === 'recording' ? '● nagrywanie' : ''].filter(Boolean);
  return `<article class="entry" id="e-${esc(f.id)}">
    <div class="entry-head"><span>${head.map(esc).join(' · ')}</span>
      ${f.status === 'recording' ? '' : `<button type="button" class="btn small" data-edit="${esc(f.id)}">✎ Edytuj</button>`}</div>
    ${f.audioId ? `<div class="entry-audio muted" data-lazy="audio" data-file="${esc(f.audioId)}">🎙 nagranie…</div>` : ''}
    ${f.kind === 'audio' ? `<div class="read-text transcript-read">${readHtml(f.transcript, f.transcribing ? '⏳ Transkrypcja w toku…' : 'Brak transkrypcji.')}</div>` : ''}
    ${f.notes?.trim() ? `<div class="read-text entry-notes">${readHtml(f.notes, '')}</div>` : ''}
    ${!f.transcript?.trim() && !f.notes?.trim() && !f.attachments.length && f.kind !== 'audio' ? '<p class="muted">(pusty wpis)</p>' : ''}
    ${photos.length ? `<div class="photos">${photos.map((a) => `<figure class="photo" data-lazy="photo" data-file="${esc(a.preview?.id || a.id)}" data-name="${esc(a.name)}"${!a.preview && pics.isHeic(a) ? ` data-heic="${esc(a.id)}"` : ''}></figure>`).join('')}</div>` : ''}
    ${docs.length ? `<ul class="docs">${docs.map((a) => `<li data-lazy="doc" data-file="${esc(a.id)}">📄 ${esc(a.name)} <span class="muted">${fmtSize(a.size)}</span></li>`).join('')}</ul>` : ''}
  </article>`;
}

// Grupa (`#/g/<id pierwszego wpisu>[/<id wpisu>]`) albo dzień (`#/d/RRRR-MM-DD`): wszystkie wpisy po kolei, do czytania.
async function renderSequence(r) {
  const view = $('#view-detail');
  revokeUrls();
  seqObserver?.disconnect();
  const groups = groupFragments(await db.getAllFragments());
  let shown;
  let title;
  if (r.view === 'group') {
    const g = groups.find((gr) => gr.some((f) => f.id === r.id));
    shown = g ? [g] : [];
    if (g) title = dayFmt.format(g[0].createdAt);
    if (r.at) scrollTarget ??= r.at;
  } else {
    shown = groups.filter((gr) => dayKey(gr[0].createdAt) === r.day);
    title = shown.length ? dayFmt.format(shown[0][0].createdAt) : r.day;
  }
  if (!shown.length) {
    view.innerHTML = '<p class="empty">Nie znaleziono wpisów.</p>';
    return;
  }
  seqIds = new Set(shown.flat().map((f) => f.id));
  // W widoku dnia mapka tylko przy zmianie miejsca (dalej niż 200 m od ostatniej pokazanej).
  let lastMap = null;
  const dayMap = (g) => {
    const loc = g.find((f) => f.location?.lat != null)?.location;
    if (!loc || (lastMap && distanceM(lastMap, loc) <= GROUP_DIST_M)) return '';
    lastMap = loc;
    return mapHtml(loc);
  };
  const ids = [...seqIds];
  const count = shown.flat().length;
  view.innerHTML = `
    <div class="detail-head"><div>
      <div class="detail-date">${esc(title)}</div>
      <div class="detail-time">${r.view === 'group' ? groupHeadHtml(shown[0]) : esc(entriesLabel(count))}</div>
    </div>${shareBtn()}</div>
    ${r.view === 'group' ? groupMapHtml(shown[0]) : ''}
    ${shown.map((g) => `<section class="seq-group">
      ${r.view === 'day' ? `<h3 class="seq-group-head">${groupHeadHtml(g)}</h3>${dayMap(g)}` : ''}
      ${g.map(entryHtml).join('')}
    </section>`).join('')}`;
  seqObserver = new IntersectionObserver((items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      seqObserver.unobserve(it.target);
      loadLazy(it.target);
    }
  }, { rootMargin: '600px 0px' });
  view.querySelectorAll('[data-lazy]').forEach((el) => seqObserver.observe(el));
  renderMaps(view);
  $('#share', view).addEventListener('click', async () => {
    // Aktualne dane (np. transkrypcja dokończona w tle), z zachowaniem podziału na grupy.
    const fresh = new Map((await Promise.all(ids.map((i) => db.getFragment(i)))).filter(Boolean).map((f) => [f.id, f]));
    const groupsNow = shown.map((g) => g.map((f) => fresh.get(f.id)).filter(Boolean)).filter((g) => g.length);
    if (groupsNow.length) shareGroups(groupsNow);
  });
  const target = scrollTarget && document.getElementById(`e-${scrollTarget}`);
  scrollTarget = null;
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
}

// Nagrania i zdjęcia wczytują się dopiero przy przewinięciu do nich.
async function loadLazy(el) {
  const file = await db.getFile(el.dataset.file);
  if (!el.isConnected) return;
  if (!file) {
    if (el.dataset.lazy === 'audio') el.textContent = 'Brak pliku nagrania.';
    return;
  }
  const url = URL.createObjectURL(file.blob);
  attachmentUrls.push(url);
  if (el.dataset.lazy === 'audio') {
    el.classList.remove('muted');
    el.innerHTML = `<audio controls preload="metadata" src="${url}"></audio>`;
    fixDuration($('audio', el));
  } else if (el.dataset.lazy === 'photo') {
    el.innerHTML = `<button type="button" class="photo-open" data-url="${url}" aria-label="Powiększ ${esc(el.dataset.name)}"><img src="${url}" alt="${esc(el.dataset.name)}"></button>`;
  } else {
    el.innerHTML = `<a href="${url}" download="${esc(file.name)}">📄 ${esc(file.name)}</a> <span class="muted">${fmtSize(file.size)}</span>`;
  }
}

// Whisper skończył w tle — uaktualnij tekst w widoku grupy/dnia.
async function refreshSeqEntry(id) {
  const entry = document.getElementById(`e-${id}`);
  const f = entry && await db.getFragment(id);
  if (!f) return;
  // Powstał podgląd JPEG zdjęcia HEIC — pokaż go.
  for (const fig of entry.querySelectorAll('[data-heic]')) {
    const a = f.attachments.find((x) => x.id === fig.dataset.heic);
    if (!a?.preview) continue;
    fig.removeAttribute('data-heic');
    fig.dataset.file = a.preview.id;
    loadLazy(fig);
  }
  const el = entry.querySelector('.transcript-read');
  if (el?.isConnected) el.innerHTML = readHtml(f.transcript, f.transcribing ? '⏳ Transkrypcja w toku…' : 'Brak transkrypcji.');
}

$('#view-detail').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edit]');
  if (!btn) return;
  openEditing = true;
  navigate(`#/f/${encodeURIComponent(btn.dataset.edit)}`);
});

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
  fixDuration($('audio', slot));
}

// Nagrania webm z MediaRecorder nie mają długości w nagłówku — wymuś jej wyliczenie.
function fixDuration(audio) {
  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration !== Infinity && !Number.isNaN(audio.duration)) return;
    audio.currentTime = 1e101;
    audio.addEventListener('timeupdate', () => { audio.currentTime = 0; }, { once: true });
  }, { once: true });
}

// Zmienia się, gdy dojdzie/zniknie załącznik albo powstanie podgląd JPEG zdjęcia HEIC.
const attachmentsKey = (f) => f.attachments.map((a) => `${a.id}:${a.preview?.id || ''}`).join(',');

async function renderAttachments(f) {
  const photosEl = $('#photos');
  const docsEl = $('#docs');
  if (!photosEl || currentId !== f.id) return;
  attachmentUrls.forEach((u) => URL.revokeObjectURL(u));
  attachmentUrls = [];
  const items = [];
  for (const a of f.attachments) {
    const file = a.kind === 'photo' ? await pics.displayFile(a) : await db.getFile(a.id);
    if (file) items.push({ ...a, url: URL.createObjectURL(file.blob) });
  }
  photosEl.dataset.key = attachmentsKey(f);
  if (currentId !== f.id) return items.forEach((i) => URL.revokeObjectURL(i.url));
  attachmentUrls = items.map((i) => i.url);
  photosEl.innerHTML = items.filter((i) => i.kind === 'photo').map((i) => `
    <figure class="photo">
      <button type="button" class="photo-open" data-url="${i.url}" aria-label="Powiększ ${esc(i.name)}"><img src="${i.url}" alt="${esc(i.name)}" loading="lazy"></button>
      ${editing ? `<button type="button" class="remove" data-remove="${esc(i.id)}" aria-label="Usuń zdjęcie">✕</button>` : ''}
    </figure>`).join('');
  docsEl.innerHTML = items.filter((i) => i.kind === 'document').map((i) => `
    <li>
      <a href="${i.url}" download="${esc(i.name)}">📄 ${esc(i.name)}</a>
      <span class="muted">${fmtSize(i.size)}</span>
      ${editing ? `<button type="button" class="remove" data-remove="${esc(i.id)}" aria-label="Usuń dokument">✕</button>` : ''}
    </li>`).join('');
  const pb = $('#photos-block');
  if (pb) pb.hidden = !items.some((i) => i.kind === 'photo');
  const docsBlock = $('#docs-block');
  if (docsBlock) docsBlock.hidden = !items.some((i) => i.kind === 'document');
}

$('#view-detail').addEventListener('click', async (e) => {
  const open = e.target.closest('.photo-open');
  if (open) {
    $('#lightbox img').src = open.dataset.url;
    $('#lightbox').showModal();
    return;
  }
  const remove = e.target.closest('[data-remove]');
  if (remove && currentId && editing) {
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
  pics.ensurePreviews();
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
      await db.patchFragment(id, field === 'transcript'
        ? (cur) => ({ transcript: value, transcribedBy: addMethod(cur.transcribedBy, METHOD.manual) })
        : { [field]: value });
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
  const h = location.hash;
  let m = h.match(/^#\/f\/(.+)$/);
  if (m) return { view: 'detail', id: decodeURIComponent(m[1]) };
  m = h.match(/^#\/g\/([^/]+)(?:\/(.+))?$/);
  if (m) return { view: 'group', id: decodeURIComponent(m[1]), at: m[2] && decodeURIComponent(m[2]) };
  m = h.match(/^#\/d\/(\d{4}-\d{2}-\d{2})$/);
  if (m) return { view: 'day', day: m[1] };
  return { view: 'list' };
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function goBack() {
  if (prevView) history.back(); // wróć tam, skąd przyszliśmy (lista, grupa, dzień)
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
    if (r.view === 'group' || r.view === 'day') scrollTarget ??= leaving; // powrót do miejsca w grupie/dniu
    await flushSaves();
    currentId = null;
    editing = false;
    revokeUrls();
    await dropIfEmpty(leaving);
  }
  if (r.view !== 'list' && selected.size) clearSelection();
  if (r.view !== 'group' && r.view !== 'day') {
    seqObserver?.disconnect();
    seqIds = new Set();
  }
  $('#view-list').hidden = r.view !== 'list';
  $('#view-detail').hidden = r.view === 'list';
  $('#back').hidden = r.view === 'list';
  if (r.view === 'list') {
    $('#view-detail').innerHTML = '';
    revokeUrls();
    await renderList();
  } else if (r.view === 'group' || r.view === 'day') {
    await renderSequence(r);
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
  if (seqIds.has(id)) refreshSeqEntry(id);
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

// Whisper: pobieranie modelu, wybór, usuwanie.
let installing = null;
async function renderWhisperSettings() {
  const box = $('#whisper-settings');
  if (!box) return;
  if (!whisper.supported) {
    box.innerHTML = '<p class="muted">Ta przeglądarka nie obsługuje transkrypcji offline.</p>';
    return;
  }
  const rows = await Promise.all(whisper.MODELS.map(async (m) => {
    const cached = await whisper.isCached(m.id);
    const active = whisper.installedModel() === m.id;
    let action;
    if (installing?.model === m.id) action = `<span class="muted" id="whisper-progress">pobieranie… ${Math.round(installing.progress * 100)}%</span>`;
    else if (active) action = '<span>✓ używany</span> <button type="button" class="btn small" data-whisper-remove="' + m.id + '">Usuń</button>';
    else if (cached) action = `<button type="button" class="btn small" data-whisper-install="${m.id}">Używaj</button>`;
    else action = `<button type="button" class="btn small" data-whisper-install="${m.id}" ${installing ? 'disabled' : ''}>Pobierz</button>`;
    return `<li><span><strong>${esc(m.name)}</strong> <span class="muted">${esc(m.size)}</span><br><small class="muted">${esc(m.note)}</small></span><span>${action}</span></li>`;
  }));
  box.innerHTML = `
    <p>${whisper.ready()
      ? '✓ Transkrypcja bez internetu jest gotowa.'
      : '<strong>Pobierz model (raz, przy internecie, najlepiej przez Wi-Fi)</strong>, żeby transkrypcja działała bez sieci.'}</p>
    <ul class="offline-list">${rows.join('')}</ul>
    <label class="check"><input type="checkbox" id="whisper-always" ${whisper.mode() === 'always' ? 'checked' : ''} ${whisper.ready() ? '' : 'disabled'}>
      Zawsze używaj modelu offline (także z internetem — prywatnie, ale tekst pojawia się z opóźnieniem)</label>
    ${isAndroid ? '<p class="muted small">Na Androidzie model offline jest używany zawsze: rozpoznawanie mowy przeglądarki nie słyszy mikrofonu w trakcie nagrania i pipa przy każdym starcie.</p>' : ''}
    ${whisper.ready() ? `<button type="button" class="btn small" id="bench-btn">⏱ Test szybkości (procesor / karta graficzna)</button>
      <div class="bench-out muted small" id="bench-out">${benchSummaryHtml()}</div>` : ''}`;
}

// ---------- test szybkości Whispera: WASM (procesor) i WebGPU (karta graficzna) ----------
const BENCH_KEY = 'dziennik.bench';
const BENCH_SEC = 20;
const BENCH_LABEL = { wasm: 'Procesor (obecny tryb)', 'webgpu-q8': 'Karta graficzna, ten sam model', 'webgpu-encoder': 'Karta graficzna, koder fp16/q4' };
const sec = (ms) => (ms / 1000).toFixed(1).replace('.', ',');

function benchLine(cfg, r, audioSec) {
  if (!r) return `${BENCH_LABEL[cfg]}: czeka`;
  if (r.running) return `${BENCH_LABEL[cfg]}: ${r.progress != null ? `pobieranie ${r.progress}%` : 'trwa'}…`;
  if (r.error) return `${BENCH_LABEL[cfg]}: błąd — ${r.error}`;
  if (r.skipped) return `${BENCH_LABEL[cfg]}: pominięto`;
  return `${BENCH_LABEL[cfg]}: ${audioSec} s nagrania w ${sec(r.second)} s (pierwszy raz ${sec(r.first)} s, wczytanie ${sec(r.load)} s)`;
}

function benchSummaryHtml(b = JSON.parse(localStorage.getItem(BENCH_KEY) || 'null')) {
  if (!b) return '';
  const lines = [
    `${b.device?.model || '?'} · ${new Date(b.at).toLocaleString('pl-PL')}`,
    b.gpu?.available ? `Karta graficzna: ${b.gpu.name || '?'} (fp16: ${b.gpu.f16 ? 'tak' : 'nie'})` : 'Karta graficzna (WebGPU): niedostępna',
    ...Object.keys(b.results).map((cfg) => benchLine(cfg, b.results[cfg], b.audioSec)),
  ];
  return lines.map((l) => `<p>${esc(l)}</p>`).join('');
}

async function runBench() {
  const out = $('#bench-out');
  const btn = $('#bench-btn');
  let audio = null;
  let lang = 'pl-PL';
  for (const f of (await db.getAllFragments()).filter((x) => x.audioId && x.status !== 'recording')) {
    const file = await db.getFile(f.audioId);
    if (!file) continue;
    try {
      audio = await whisper.decodeBlob(file.blob);
      lang = f.langs?.[0] || lang;
      break;
    } catch { /* następne */ }
  }
  if (!audio) return toast('Brak nagrania do testu — nagraj coś najpierw.');
  audio = audio.slice(0, BENCH_SEC * whisper.SAMPLE_RATE);
  const b = { at: Date.now(), appVersion: APP_VERSION, device: await getDevice(), audioSec: Math.round(audio.length / whisper.SAMPLE_RATE), model: whisper.installedModel(), results: {} };
  btn.disabled = true;
  try {
    b.gpu = await whisper.gpuInfo();
    const configs = ['wasm', ...(b.gpu.available ? ['webgpu-q8', 'webgpu-encoder'] : [])];
    for (const cfg of configs) b.results[cfg] = null;
    for (const cfg of configs) {
      if (cfg === 'webgpu-encoder' && !confirm(`Ostatni wariant wymaga pobrania ok. ${b.gpu.f16 ? 177 : 66} MB (koder dla karty graficznej). Pobrać i sprawdzić?`)) {
        b.results[cfg] = { skipped: true };
        continue;
      }
      b.results[cfg] = { running: true };
      const show = () => { if (out.isConnected) out.innerHTML = benchSummaryHtml(b); };
      show();
      try {
        const r = await whisper.benchmark(cfg, audio.slice(), lang, (p) => {
          if (p.status !== 'progress' || !p.total) return;
          b.results[cfg] = { running: true, progress: Math.round((p.loaded / p.total) * 100) };
          show();
        });
        b.results[cfg] = { load: Math.round(r.load), first: Math.round(r.first), second: Math.round(r.second), text: r.text.slice(0, 200) };
      } catch (err) {
        b.results[cfg] = { error: err.message };
      }
      localStorage.setItem(BENCH_KEY, JSON.stringify(b)); // po każdym wariancie (przetrwa np. zamknięcie karty)
    }
  } finally {
    btn.disabled = false;
  }
  localStorage.setItem(BENCH_KEY, JSON.stringify(b));
  if (out.isConnected) out.innerHTML = benchSummaryHtml(b);
  sync.schedule(2000); // wynik trafia do dziennik.json (pole diagnostics)
}

$('#settings-body').addEventListener('click', async (e) => {
  if (e.target.closest('#bench-btn')) return runBench();
  const inst = e.target.closest('[data-whisper-install]');
  const rem = e.target.closest('[data-whisper-remove]');
  if (inst && !installing) {
    const model = inst.dataset.whisperInstall;
    if (!navigator.onLine && !(await whisper.isCached(model))) return toast('Do pobrania modelu potrzebny jest internet.');
    installing = { model, progress: 0 };
    renderWhisperSettings();
    try {
      await whisper.install(model, (p) => {
        installing.progress = p;
        const el = $('#whisper-progress');
        if (el) el.textContent = `pobieranie… ${Math.round(p * 100)}%`;
      });
      toast('Model pobrany — transkrypcja działa teraz bez internetu.');
    } catch (err) {
      toast(`Nie udało się pobrać modelu: ${err.message}`);
    }
    installing = null;
    renderWhisperSettings();
    renderHint();
  } else if (rem) {
    if (!confirm('Usunąć model? Transkrypcja bez internetu przestanie działać.')) return;
    await whisper.remove(rem.dataset.whisperRemove);
    renderWhisperSettings();
    renderHint();
  }
});

$('#settings-body').addEventListener('change', (e) => {
  if (e.target.id === 'auto-stop') localStorage.setItem(AUTOSTOP_KEY, e.target.value);
  if (e.target.id === 'whisper-always') whisper.setMode(e.target.checked ? 'always' : 'auto');
});

async function openSettings() {
  const stopSec = autoStopSec();
  let html = `<h3>Nagrywanie</h3><label>Zakończ nagranie po ciszy:
    <select id="auto-stop">${AUTOSTOP_OPTIONS.map(([v, l]) => `<option value="${v}"${v === stopSec ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  html += '<h3>Transkrypcja bez internetu</h3><div id="whisper-settings"><p class="muted">…</p></div>';
  html += '<h3>Transkrypcja z internetem</h3>';
  html += speechSupported
    ? '<p>Najpierw używane jest rozpoznawanie mowy przeglądarki — tekst pojawia się na żywo. Na Androidzie działa ono też bez internetu, jeśli w telefonie są pobrane języki offline (Ustawienia Androida → rozpoznawanie mowy / Mowa Google → języki offline: polski, hiszpański, angielski). Gdy rozpoznawanie zgłosi brak sieci, aplikacja sama przełącza się na model offline powyżej.</p>'
    : '<p class="muted">Ta przeglądarka nie ma rozpoznawania mowy na żywo — używany jest tylko model offline.</p>';
  html += '<div id="chrome-offline"></div>';
  html += `<h3>Kopia w GitHub</h3><div id="sync-settings">${syncSettingsHtml()}</div>`;
  html += '<h3>Dane</h3><p id="storage-info" class="muted">…</p>';
  $('#settings-body').innerHTML = html;
  if (!$('#settings').open) $('#settings').showModal();
  renderWhisperSettings();
  renderChromeOffline();

  const count = (await db.getAllFragments()).length;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('#storage-info').textContent = [
    `Wpisów: ${count}.`,
    est ? `Zajęte miejsce (z modelem): ${fmtSize(est.usage || 0)}.` : '',
    'Wszystko jest zapisane tylko na tym urządzeniu.',
    persisted ? 'Przeglądarka nie usunie danych automatycznie.' : 'Zainstaluj aplikację na ekranie głównym, żeby przeglądarka nie usunęła danych przy braku miejsca.',
    `Wersja aplikacji: ${APP_VERSION}.`,
  ].filter(Boolean).join(' ');
}

$('#settings-btn').addEventListener('click', openSettings);

// Rozpoznawanie na urządzeniu wbudowane w Chrome — pokazuj tylko, gdy jest choć jeden język do użycia/pobrania.
async function renderChromeOffline() {
  const box = $('#chrome-offline');
  if (!box || !speechSupported || !offlineSpeech.supported) return;
  const statuses = await Promise.all(LANGS.map((l) => offlineSpeech.status(l.code)));
  if (statuses.every((st) => st === 'unavailable')) return;
  box.innerHTML = `<p class="muted">Chrome oferuje też własne rozpoznawanie na urządzeniu (opcjonalnie):</p><ul class="offline-list">${LANGS.map((l) =>
    `<li data-lang="${l.code}"><span>${esc(l.name)}</span><span class="status muted">sprawdzam…</span></li>`).join('')}</ul>`;
  LANGS.forEach((l) => updateOfflineRow(l.code));
}

// ---------- kopia w GitHub ----------
function syncStatusText() {
  const st = sync.status();
  if (st.message) return st.message;
  const last = sync.lastSync();
  return last ? `Ostatnia synchronizacja: ${dayFmt.format(last)}, ${timeFmt.format(last)}.` : 'Jeszcze nie synchronizowano.';
}

function syncSettingsHtml() {
  const s = sync.settings();
  return `
    <p class="muted">Wpisy, nagrania i załączniki trafiają do prywatnego repozytorium (plik <code>${esc(s.profile)}/dziennik.json</code>,
      raport <code>dziennik.md</code> i folder <code>dziennik/</code>). Synchronizacja działa sama, gdy jest internet; na innym urządzeniu
      wystarczy wpisać ten sam token, a wpisy się pobiorą.</p>
    <label class="field">Repozytorium<input id="gh-repo" value="${esc(s.repo)}" autocomplete="off" spellcheck="false"></label>
    <label class="field">Profil (folder w repozytorium)<input id="gh-profile" value="${esc(s.profile)}" autocomplete="off" spellcheck="false"></label>
    <label class="field">Token GitHub<input id="gh-token" class="mono" type="text" value="${esc(s.token)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="github_pat_…"></label>
    <p class="muted small">Fine-grained token (github.com → Settings → Developer settings) z dostępem tylko do tego repozytorium,
      uprawnienie <em>Contents: Read and write</em>. Token zostaje tylko na tym urządzeniu.</p>
    <div class="row"><button type="button" class="btn small" id="gh-save">Zapisz i synchronizuj</button></div>
    <p class="muted small" id="sync-status" data-error="${sync.status().error}">${esc(syncStatusText())}</p>`;
}

$('#settings-body').addEventListener('click', async (e) => {
  if (e.target.id !== 'gh-save') return;
  sync.saveSettings({ token: $('#gh-token').value, repo: $('#gh-repo').value, profile: $('#gh-profile').value });
  if (!sync.configured()) return toast('Podaj token GitHub.');
  sync.sync().then(() => renderList()).catch(() => {});
});

sync.events.addEventListener('status', () => {
  const el = $('#sync-status');
  if (el) {
    el.textContent = syncStatusText();
    el.dataset.error = sync.status().error;
  }
  if (!sync.status().running && sync.status().error && !$('#settings').open) toast(sync.status().message);
});

// ---------- start ----------
async function init() {
  renderLangs();
  renderHint();
  if (!window.isSecureContext) toast('Mikrofon i lokalizacja działają tylko przez HTTPS (lub na localhost).', 10000);
  // Nagrania przerwane (np. zamknięta karta) — audio zapisane do ostatnich 10 s zostaje.
  // Transkrypcja Whispera przerwana zamknięciem aplikacji — powtórz dla całego nagrania.
  const redo = [];
  for (const f of await db.getAllFragments()) {
    if (f.status === 'recording') await db.patchFragment(f.id, { status: 'interrupted' });
    if (f.transcribing) {
      await db.patchFragment(f.id, { transcribing: false });
      if (f.audioId) redo.push(f.id);
    }
  }
  redo.forEach((id) => transcribeFragment(id));
  sync.startAuto();
  await render();
  backfillContext();
  pics.ensurePreviews(); // podglądy JPEG zdjęć HEIC (biblioteka pobiera się raz, potem z cache)
  window.addEventListener('online', () => { backfillContext(); pics.ensurePreviews(); });
  if ('serviceWorker' in navigator) {
    // Nowa wersja aplikacji przejęła stronę — przeładuj (chyba że trwa nagrywanie).
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      // `busyRec`: nagranie właśnie startuje (mikrofon, moduły), a `rec` nie jest jeszcze ustawione.
      reloadPending = true;
      reloadIfPending();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}

init();
