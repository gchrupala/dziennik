// Udostępnianie widoków do czytania jako jeden plik HTML: nagłówki (data, godziny, miejsce, pogoda), tekst,
// notatki i zdjęcia wbudowane w plik (JPEG zmniejszone do 1280 px). Bez nagrań. Ten sam plik dochodzi
// tak samo przez Signala, WhatsAppa czy e-mail (Signal przy zdjęciach pomijał zwykły tekst).
import { describeWeather } from './context.js?v=202611011059';
import * as pics from './photos.js?v=202611011059';

const MAX_SIDE = 1280;
const QUALITY = 0.82;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dayFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' });
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
const pad = (n) => String(n).padStart(2, '0');
const paras = (text) => text.trim().split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

const CSS = `
:root { color-scheme: light dark; --muted: #6b6860; --line: #e2dfd6; --accent: #0f766e; }
@media (prefers-color-scheme: dark) { :root { --muted: #a19e95; --line: #34322e; --accent: #2dd4bf; } }
body { max-width: 720px; margin: 0 auto; padding: 16px; font: 17px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1 { font-size: 22px; margin: 4px 0 0; }
.sub { color: var(--muted); margin: 2px 0 8px; font-size: 15px; }
section { margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--line); }
h2 { font-size: 18px; margin: 0; }
.meta { color: var(--muted); font-size: 15px; margin: 2px 0 6px; }
.meta a { color: var(--accent); }
h3 { font-size: 15px; color: var(--muted); margin: 18px 0 4px; }
p { margin: 0 0 10px; }
.notes { padding-left: 10px; border-left: 3px solid var(--line); }
img { display: block; width: 100%; height: auto; margin: 10px 0; border-radius: 8px; }
.docs { color: var(--muted); font-size: 15px; }
footer { margin-top: 30px; color: var(--muted); font-size: 13px; }
`;

// Zdjęcie jako data URL (JPEG, dłuższy bok ≤ 1280 px). HEIC bez podglądu (przeglądarka go nie odczyta) — pomijane.
async function photoDataUrl(a) {
  const file = await pics.displayFile(a);
  if (!file) return null;
  try {
    const bmp = await createImageBitmap(file.blob);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return canvas.toDataURL('image/jpeg', QUALITY);
  } catch {
    return null;
  }
}

function groupMeta(g) {
  const placed = g.find((f) => f.location?.lat != null);
  const w = g.find((f) => f.weather?.temperature != null)?.weather;
  const parts = [];
  if (placed) {
    const { lat, lon } = placed.location;
    parts.push(`📍 <a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lon}#map=15/${lat}/${lon}">${esc(placed.location.address || placed.location.place || `${lat.toFixed(5)}, ${lon.toFixed(5)}`)}</a>`);
  }
  if (w) {
    const d = describeWeather(w);
    parts.push(esc(`${d.icon} ${Math.round(w.temperature)}°C, ${d.text.toLowerCase()}`));
  }
  return parts.join('<br>');
}

async function entryHtml(f, withTime) {
  const out = [];
  if (withTime) out.push(`<h3>${esc(timeFmt.format(f.createdAt))}</h3>`);
  if (f.transcript?.trim()) out.push(paras(f.transcript));
  if (f.notes?.trim()) out.push(`<div class="notes">${paras(f.notes)}</div>`);
  for (const a of f.attachments.filter((x) => x.kind === 'photo')) {
    const src = await photoDataUrl(a);
    if (src) out.push(`<img src="${src}" alt="${esc(a.name)}">`);
  }
  const docs = f.attachments.filter((x) => x.kind === 'document');
  if (docs.length) out.push(`<p class="docs">📄 ${docs.map((d) => esc(d.name)).join(', ')}</p>`);
  // Wpis bez tekstu i zdjęć (np. samo nagranie) w pliku nic nie wnosi poza godziną — pomijamy go.
  return out.length > (withTime ? 1 : 0) ? out.join('\n') : '';
}

/** Grupy wpisów (jak w widoku dnia/grupy) → plik HTML. */
export async function buildHtml(groups) {
  const first = groups[0][0];
  const last = groups.at(-1).at(-1);
  const day = cap(dayFmt.format(first.createdAt));
  const span = first === last ? timeFmt.format(first.createdAt) : `${timeFmt.format(first.createdAt)}–${timeFmt.format(last.createdAt)}`;
  const sections = [];
  for (const g of groups) {
    const time = g.length > 1 ? `${timeFmt.format(g[0].createdAt)}–${timeFmt.format(g.at(-1).createdAt)}` : timeFmt.format(g[0].createdAt);
    const place = g.find((f) => f.location?.place)?.location.place;
    const body = (await Promise.all(g.map((f) => entryHtml(f, g.length > 1)))).filter(Boolean).join('\n');
    if (!body && groups.length > 1) continue; // grupa bez tekstu i zdjęć (np. same nagrania)
    sections.push(`<section><h2>${esc(time)}${place ? ` — ${esc(place)}` : ''}</h2><p class="meta">${groupMeta(g)}</p>${body}</section>`);
  }
  const html = `<!DOCTYPE html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dziennik — ${esc(day)}</title><style>${CSS}</style></head>
<body><h1>${esc(day)}</h1><p class="sub">${esc(span)}</p>
${sections.join('\n')}
<footer>Dziennik</footer></body></html>`;
  const d = new Date(first.createdAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const name = groups.length === 1 ? `Dziennik ${stamp} ${pad(d.getHours())}-${pad(d.getMinutes())}.html` : `Dziennik ${stamp}.html`;
  return new File([html], name, { type: 'text/html' });
}

// Przygotowanie pliku (zdjęcia) może trwać dłużej niż przeglądarka pozwala czekać po dotknięciu.
// Wtedy plik czeka gotowy i drugie dotknięcie wysyła go od razu.
let prepared = null; // { key, file }

/** Udostępnia grupy jako plik HTML; bez Web Share z plikami — pobiera plik. `notify(msg)` pokazuje komunikat. */
export async function shareGroups(groups, notify) {
  const key = groups.flat().map((f) => `${f.id}:${f.updatedAt}`).join(',');
  let file = prepared?.key === key ? prepared.file : null;
  if (!file) {
    notify('Przygotowuję plik…');
    file = await buildHtml(groups);
    prepared = { key, file };
  }
  if (!navigator.canShare?.({ files: [file] })) {
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify(`Zapisano plik ${file.name}.`);
    return;
  }
  try {
    await navigator.share({ files: [file], title: file.name.replace(/\.html$/, '') });
    prepared = null;
  } catch (err) {
    if (err?.name === 'NotAllowedError') notify('Plik gotowy — dotknij ikony jeszcze raz, żeby go wysłać.');
    else if (err?.name !== 'AbortError') notify(`Nie udało się udostępnić: ${err.message}`);
  }
}
