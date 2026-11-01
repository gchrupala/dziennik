// Udostępnianie widoków do czytania: tekst (data, godziny, miejsce, pogoda, transkrypcje, notatki) i zdjęcia (JPEG)
// jednym dotknięciem. Tekst trafia też do schowka — niektóre aplikacje (np. Signal) przy zdjęciach go pomijają.
import { describeWeather } from './context.js?v=202611011140';
import * as pics from './photos.js?v=202611011140';

const MAX_FILES = 20;
const dayFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' });
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());

function groupHead(g) {
  const time = g.length > 1 ? `${timeFmt.format(g[0].createdAt)}–${timeFmt.format(g.at(-1).createdAt)}` : timeFmt.format(g[0].createdAt);
  const loc = g.find((f) => f.location?.lat != null)?.location;
  const place = loc && (loc.place || `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`);
  const w = g.find((f) => f.weather?.temperature != null)?.weather;
  const d = w && describeWeather(w);
  return [[time, place].filter(Boolean).join(' — '), w && `${d.icon} ${Math.round(w.temperature)}°C, ${d.text.toLowerCase()}`]
    .filter(Boolean).join('\n');
}

function entryText(f, withTime) {
  if (!f.transcript?.trim() && !f.notes?.trim()) return ''; // sama godzina nic nie mówi
  return [withTime && timeFmt.format(f.createdAt), f.transcript?.trim(), f.notes?.trim()].filter(Boolean).join('\n');
}

/** Grupy wpisów → tekst: dzień, potem każda grupa (godziny, miejsce, pogoda) i jej wpisy. */
export function shareText(groups) {
  const parts = [cap(dayFmt.format(groups[0][0].createdAt))];
  for (const g of groups) {
    const texts = g.map((f) => entryText(f, g.length > 1)).filter(Boolean);
    if (!texts.length && groups.length > 1) continue; // grupa bez tekstu (np. same nagrania)
    parts.push(groupHead(g), ...texts);
  }
  return parts.join('\n\n');
}

/** Udostępnia tekst i zdjęcia; tekst kopiuje też do schowka. `notify(msg)` pokazuje komunikat. */
export async function shareGroups(groups, notify) {
  const text = shareText(groups);
  const copied = navigator.clipboard?.writeText(text).then(() => true, () => false) ?? Promise.resolve(false);
  if (!navigator.share) {
    notify(await copied ? 'Skopiowano tekst do schowka.' : 'Udostępnianie nie jest dostępne w tej przeglądarce.');
    return;
  }
  const files = [];
  for (const a of groups.flat().flatMap((f) => f.attachments).filter((x) => x.kind === 'photo').slice(0, MAX_FILES)) {
    const file = await pics.displayFile(a);
    if (file) files.push(new File([file.blob], file.name || a.name, { type: file.type || file.blob.type }));
  }
  try {
    if (files.length && navigator.canShare?.({ files, text })) await navigator.share({ text, files });
    else await navigator.share({ text });
    if (await copied) notify('Tekst jest też w schowku.');
  } catch (err) {
    if (err?.name !== 'AbortError') notify(`Nie udało się udostępnić: ${err.message}`);
  }
}
