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

// Kafelki pokrywające ramkę w×h, której lewy górny róg to (left, top) w pikselach świata przy przybliżeniu z.
function tilesHtml(left, top, w, h, z) {
  const max = 2 ** z;
  const tiles = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
      if (ty < 0 || ty >= max) continue;
      const x = ((tx % max) + max) % max;
      tiles.push(`<img src="https://tile.openstreetmap.org/${z}/${x}/${ty}.png" alt="" draggable="false"
        style="left:${Math.round(tx * TILE - left)}px;top:${Math.round(ty * TILE - top)}px">`);
    }
  }
  return tiles;
}

// Wszystkie kafelki zawiodły (np. offline bez cache) — schowaj mapkę.
function hideOnFailure(el, box, count) {
  let failed = 0;
  for (const img of box.querySelectorAll('img')) {
    img.addEventListener('error', () => { if (++failed === count) el.hidden = true; }, { once: true });
  }
}

function fill(el) {
  if (el.dataset.route) return fillRoute(el);
  const lat = Number(el.dataset.lat);
  const lon = Number(el.dataset.lon);
  const acc = Number(el.dataset.acc);
  const w = el.clientWidth || 360;
  const h = HEIGHT;
  const p = worldPx(lat, lon, ZOOM);
  const left = p.x - w / 2; // lewy górny róg ramki w pikselach świata
  const top = p.y - h / 2;
  const tiles = tilesHtml(left, top, w, h, ZOOM);
  // Kółko dokładności GPS (metry → piksele przy tej szerokości geograficznej).
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** ZOOM;
  const r = acc ? Math.min(Math.max(acc / mPerPx, 6), h) : 0;
  const box = el.querySelector('.map-tiles');
  box.innerHTML = tiles.join('')
    + (r ? `<span class="map-acc" style="width:${2 * r}px;height:${2 * r}px"></span>` : '')
    + '<span class="map-pin"></span>';
  el.style.height = `${h}px`;
  hideOnFailure(el, box, tiles.length);
}

// ---------- trasa dnia: kilka miejsc na jednej mapce, połączonych linią ----------
const ROUTE_HEIGHT = 230;
const ROUTE_PAD = 28; // margines wokół punktów (px)

/** Mapka z trasą: `points` — różne miejsca ([{ lat, lon }], numerowane od 1), `order` — kolejność odwiedzin (indeksy). */
export function routeMapHtml(points, order = points.map((_, i) => i)) {
  if (points.length < 2) return '';
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const link = `https://www.openstreetmap.org/?bbox=${Math.min(...lons)},${Math.min(...lats)},${Math.max(...lons)},${Math.max(...lats)}`;
  return `<div class="map route" data-route="${esc(JSON.stringify(points.map((p) => [p.lat, p.lon])))}" data-order="${esc(JSON.stringify(order))}">
    <a class="map-tiles" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Otwórz mapę trasy"></a>
    <a class="map-attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>
  </div>`;
}

function fillRoute(el) {
  const pts = JSON.parse(el.dataset.route);
  const order = JSON.parse(el.dataset.order || 'null') || pts.map((_, i) => i);
  const w = el.clientWidth || 360;
  const h = ROUTE_HEIGHT;
  // Największe przybliżenie, przy którym wszystkie punkty mieszczą się w ramce z marginesem.
  let z = 17;
  let px;
  for (; z > 2; z--) {
    px = pts.map(([lat, lon]) => worldPx(lat, lon, z));
    const xs = px.map((p) => p.x);
    const ys = px.map((p) => p.y);
    if (Math.max(...xs) - Math.min(...xs) <= w - 2 * ROUTE_PAD && Math.max(...ys) - Math.min(...ys) <= h - 2 * ROUTE_PAD) break;
  }
  px = pts.map(([lat, lon]) => worldPx(lat, lon, z));
  const xs = px.map((p) => p.x);
  const ys = px.map((p) => p.y);
  const left = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2;
  const top = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles = tilesHtml(left, top, w, h, z);
  const xy = px.map((p) => [Math.round(p.x - left), Math.round(p.y - top)]);
  const first = order[0];
  const last = order.at(-1);
  const dots = xy.map(([x, y], i) => `<g transform="translate(${x} ${y})"><circle r="9" class="${i === first ? 'start' : i === last ? 'end' : ''}"/>`
    + `<text text-anchor="middle" dy="3.5">${i + 1}</text></g>`).join('');
  const box = el.querySelector('.map-tiles');
  box.innerHTML = tiles.join('') + `<svg class="map-route" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline points="${order.map((i) => xy[i].join(',')).join(' ')}"/>${dots}</svg>`;
  el.style.height = `${h}px`;
  hideOnFailure(el, box, tiles.length);
}

/** Wypełnia mapki w `root` (po wstawieniu HTML do strony, gdy znana jest szerokość). */
export function renderMaps(root) {
  root.querySelectorAll('.map:not([data-done])').forEach((el) => {
    el.dataset.done = '1';
    fill(el);
  });
}
