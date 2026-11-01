// Kontekst wpisu: lokalizacja (GPS), nazwa miejsca (Nominatim/OSM) i pogoda (Open-Meteo).
import { getFragment, getAllFragments, patchFragment, notify } from './db.js?v=202611011106';

const busy = new Set();
export const isBusy = (id) => busy.has(id);

const WMO = {
  0: ['Bezchmurnie', '☀️', '🌙'],
  1: ['Przeważnie bezchmurnie', '🌤️', '🌙'],
  2: ['Częściowe zachmurzenie', '⛅'],
  3: ['Pochmurno', '☁️'],
  45: ['Mgła', '🌫️'],
  48: ['Mgła z szadzią', '🌫️'],
  51: ['Lekka mżawka', '🌦️'],
  53: ['Mżawka', '🌦️'],
  55: ['Gęsta mżawka', '🌧️'],
  56: ['Marznąca mżawka', '🌧️'],
  57: ['Gęsta marznąca mżawka', '🌧️'],
  61: ['Słaby deszcz', '🌦️'],
  63: ['Deszcz', '🌧️'],
  65: ['Ulewny deszcz', '🌧️'],
  66: ['Marznący deszcz', '🌧️'],
  67: ['Silny marznący deszcz', '🌧️'],
  71: ['Słaby śnieg', '🌨️'],
  73: ['Śnieg', '🌨️'],
  75: ['Intensywny śnieg', '❄️'],
  77: ['Śnieg ziarnisty', '🌨️'],
  80: ['Przelotny deszcz', '🌦️'],
  81: ['Przelotne opady deszczu', '🌧️'],
  82: ['Gwałtowne ulewy', '⛈️'],
  85: ['Przelotny śnieg', '🌨️'],
  86: ['Intensywne opady śniegu', '❄️'],
  95: ['Burza', '⛈️'],
  96: ['Burza z gradem', '⛈️'],
  99: ['Burza z silnym gradem', '⛈️'],
};

export function describeWeather(w) {
  const [text, icon, nightIcon] = WMO[w.code] || ['Nieznane warunki', '🌡️'];
  return { text, icon: w.isDay === false && nightIcon ? nightIcon : icon };
}

export function windDir(deg) {
  if (deg == null) return '';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

async function fetchJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- lokalizacja ----------
const position = (opts) => new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, opts));

async function getLocation() {
  if (!('geolocation' in navigator)) throw new Error('Urządzenie nie udostępnia lokalizacji');
  let p;
  try {
    p = await position({ enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  } catch (err) {
    if (err.code === 1) throw err; // brak zgody — nie ponawiaj
    p = await position({ enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  }
  const c = p.coords;
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracy: Math.round(c.accuracy),
    altitude: c.altitude != null ? Math.round(c.altitude) : null,
    at: p.timestamp,
  };
}

function geoError(err) {
  switch (err?.code) {
    case 1: return 'Brak zgody na lokalizację';
    case 2: return 'Lokalizacja niedostępna';
    case 3: return 'Nie udało się ustalić lokalizacji';
    default: return err?.message || 'Błąd lokalizacji';
  }
}

async function reverseGeocode(lat, lon) {
  const j = await fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&accept-language=pl`);
  const a = j.address || {};
  const locality = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || a.state;
  return { place: [locality, a.country].filter(Boolean).join(', ') || j.display_name || '', address: j.display_name || '' };
}

// ---------- pogoda ----------
const VARS = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day';

function normalizeWeather(c, backfilled) {
  if (!c || c.temperature_2m == null) return null;
  return {
    temperature: c.temperature_2m,
    apparentTemperature: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    precipitation: c.precipitation,
    code: c.weather_code,
    cloudCover: c.cloud_cover,
    windSpeed: c.wind_speed_10m,
    windDirection: c.wind_direction_10m,
    isDay: c.is_day === 1,
    time: c.time,
    backfilled,
    source: 'Open-Meteo',
  };
}

// Pogoda bieżąca, a dla starszych wpisów — dane godzinowe z chwili nagrania (do ~3 miesięcy wstecz).
async function fetchWeather(lat, lon, at) {
  const base = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&wind_speed_unit=kmh&timezone=GMT`;
  if (Date.now() - at < 45 * 60e3) {
    const j = await fetchJson(`${base}&current=${VARS}`);
    return normalizeWeather(j.current, false);
  }
  const hour = new Date(Math.round(at / 3600e3) * 3600e3).toISOString().slice(0, 16);
  const j = await fetchJson(`${base}&hourly=${VARS}&start_hour=${hour}&end_hour=${hour}`);
  const h = j.hourly;
  if (!h?.time?.length) return null;
  return normalizeWeather(Object.fromEntries(Object.keys(h).map((k) => [k, h[k][0]])), true);
}

const clientError = (err) => err?.status >= 400 && err.status < 500 && err.status !== 429;

async function enrich(id) {
  if (!navigator.onLine) return;
  const f = await getFragment(id);
  const loc = f?.location;
  if (loc?.lat == null) return;
  if (!f.weather) {
    try {
      const weather = await fetchWeather(loc.lat, loc.lon, f.createdAt);
      await patchFragment(id, { weather: weather ?? { unavailable: true } });
    } catch (err) {
      if (clientError(err)) await patchFragment(id, { weather: { unavailable: true } });
    }
  }
  if (loc.place === undefined) {
    try {
      const p = await reverseGeocode(loc.lat, loc.lon);
      await patchFragment(id, (cur) => ({ location: { ...cur.location, ...p } }));
    } catch (err) {
      if (clientError(err)) await patchFragment(id, (cur) => ({ location: { ...cur.location, place: '' } }));
    }
  }
}

async function withBusy(id, fn) {
  if (busy.has(id)) return;
  busy.add(id);
  notify(id);
  try { await fn(); } catch (err) { console.warn('Kontekst wpisu:', err); } finally {
    busy.delete(id);
    notify(id);
  }
}

// Wywoływane przy tworzeniu wpisu: lokalizacja, potem (jeśli jest internet) miejsce i pogoda.
export function captureContext(id) {
  return withBusy(id, async () => {
    let loc;
    try {
      loc = await getLocation();
    } catch (err) {
      await patchFragment(id, { location: { error: geoError(err) } });
      return;
    }
    await patchFragment(id, { location: loc });
    await enrich(id);
  });
}

// Uzupełnia brakujące miejsce/pogodę w starszych wpisach (np. nagranych bez internetu).
let backfilling = false;
export async function backfillContext() {
  if (backfilling || !navigator.onLine) return;
  backfilling = true;
  try {
    for (const f of await getAllFragments()) {
      if (!navigator.onLine) break;
      if (f.status === 'recording' || busy.has(f.id) || f.location?.lat == null) continue;
      if (f.weather && f.location.place !== undefined) continue;
      await withBusy(f.id, () => enrich(f.id));
      await sleep(1100); // Nominatim: maks. 1 zapytanie na sekundę
    }
  } finally {
    backfilling = false;
  }
}

// ---------- grupowanie bliskich wpisów (tylko widok i raport; dane się nie zmieniają) ----------
export const GROUP_GAP_MS = 10 * 60 * 1000; // przerwa między końcem jednego a początkiem następnego
export const GROUP_DIST_M = 200;            // dokładność GPS w telefonie to zwykle 20–40 m

export function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

// Następny wpis zaczął się niedługo po końcu poprzedniego, tego samego dnia i w pobliżu
// (bez lokalizacji w którymś z nich decyduje sam czas).
function follows(prev, next) {
  const gap = next.createdAt - (prev.createdAt + (prev.durationMs || 0));
  if (gap > GROUP_GAP_MS || !sameDay(prev.createdAt, next.createdAt)) return false;
  const a = prev.location;
  const b = next.location;
  if (a?.lat == null || b?.lat == null) return true;
  return distanceM(a, b) <= GROUP_DIST_M;
}

/** Wpisy (dowolna kolejność) → grupy kolejnych bliskich wpisów, chronologicznie (także wewnątrz grup). */
export function groupFragments(fragments) {
  const groups = [];
  for (const f of [...fragments].sort((a, b) => a.createdAt - b.createdAt)) {
    const last = groups.at(-1);
    if (last && follows(last.at(-1), f)) last.push(f);
    else groups.push([f]);
  }
  return groups;
}
