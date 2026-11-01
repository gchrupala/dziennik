// Mapka okolicy wpisu: kafelki OpenStreetMap ułożone tak, żeby punkt był na środku, bez bibliotek.
// Kafelki idą z pominięciem service workera (zwykły cache HTTP przeglądarki, zgodnie z zasadami OSM).
// Bez internetu i bez kafelków w cache mapka się chowa.
const TILE = 256;
const ZOOM = 15; // okolica: kilka ulic w każdą stronę
const HEIGHT = 170;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Miejsce na mapkę (wypełnia ją `renderMaps` po wstawieniu do strony). `loc`: { lat, lon, accuracy? }. */
export function mapHtml(loc) {
  if (loc?.lat == null) return '';
  const link = `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}#map=16/${loc.lat}/${loc.lon}`;
  return `<div class="map" data-lat="${loc.lat}" data-lon="${loc.lon}" data-acc="${loc.accuracy || 0}">
    <a class="map-tiles" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Otwórz mapę"></a>
    <a class="map-attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>
  </div>`;
}

// Współrzędne „świata” w pikselach przy danym przybliżeniu (Web Mercator).
function worldPx(lat, lon, z) {
  const n = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

function fill(el) {
  const lat = Number(el.dataset.lat);
  const lon = Number(el.dataset.lon);
  const acc = Number(el.dataset.acc);
  const w = el.clientWidth || 360;
  const h = HEIGHT;
  const p = worldPx(lat, lon, ZOOM);
  const left = p.x - w / 2; // lewy górny róg ramki w pikselach świata
  const top = p.y - h / 2;
  const max = 2 ** ZOOM;
  const tiles = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
      if (ty < 0 || ty >= max) continue;
      const x = ((tx % max) + max) % max;
      tiles.push(`<img src="https://tile.openstreetmap.org/${ZOOM}/${x}/${ty}.png" alt="" draggable="false"
        style="left:${Math.round(tx * TILE - left)}px;top:${Math.round(ty * TILE - top)}px">`);
    }
  }
  // Kółko dokładności GPS (metry → piksele przy tej szerokości geograficznej).
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** ZOOM;
  const r = acc ? Math.min(Math.max(acc / mPerPx, 6), h) : 0;
  const box = el.querySelector('.map-tiles');
  box.innerHTML = tiles.join('')
    + (r ? `<span class="map-acc" style="width:${2 * r}px;height:${2 * r}px"></span>` : '')
    + '<span class="map-pin"></span>';
  el.style.height = `${h}px`;
  // Wszystkie kafelki zawiodły (np. offline bez cache) — schowaj mapkę.
  let failed = 0;
  for (const img of box.querySelectorAll('img')) {
    img.addEventListener('error', () => { if (++failed === tiles.length) el.hidden = true; }, { once: true });
  }
}

/** Wypełnia mapki w `root` (po wstawieniu HTML do strony, gdy znana jest szerokość). */
export function renderMaps(root) {
  root.querySelectorAll('.map:not([data-done])').forEach((el) => {
    el.dataset.done = '1';
    fill(el);
  });
}
