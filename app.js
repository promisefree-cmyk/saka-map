'use strict';

const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';
const WALK_M_PER_MIN = 80;        // 不動産の表示に関する公正競争規約：徒歩1分=80m
const SAMPLE_STEP = 10;           // 標高を取る間隔（m）
const EXAMPLE = { addr: '東京都港区元麻布3丁目', station: '' };

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- 地図 ---------- */

const gsiAttr = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const base = {
  '淡色地図': L.tileLayer(`${GSI}/pale/{z}/{x}/{y}.png`, { maxZoom: 19, maxNativeZoom: 18, attribution: gsiAttr }),
  '標準地図': L.tileLayer(`${GSI}/std/{z}/{x}/{y}.png`, { maxZoom: 19, maxNativeZoom: 18, attribution: gsiAttr }),
  '航空写真': L.tileLayer(`${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`, { maxZoom: 19, maxNativeZoom: 18, attribution: gsiAttr }),
};
const contourLayer = L.layerGroup();
const overlays = {
  '等高線': contourLayer,
  '陰影起伏図': L.tileLayer(`${GSI}/hillshademap/{z}/{x}/{y}.png`, { maxZoom: 19, maxNativeZoom: 16, opacity: 0.35, attribution: gsiAttr }),
  '色別標高図': L.tileLayer(`${GSI}/relief/{z}/{x}/{y}.png`, { maxZoom: 19, maxNativeZoom: 15, opacity: 0.45, attribution: gsiAttr }),
};

const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([35.6545, 139.7300], 15);
base['淡色地図'].addTo(map);
overlays['陰影起伏図'].addTo(map);
contourLayer.addTo(map);
L.control.layers(base, overlays, { collapsed: true }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const pinIcon = (cls, text) => L.divIcon({ className: '', html: `<div class="pin ${cls}"><span>${text}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34] });
let homeMarker = null, staMarker = null;
const routeLayer = L.layerGroup().addTo(map);
const cursor = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 3, fillColor: '#1d2721', fillOpacity: 1 });

/* ---------- 標高タイル（国土地理院 標高PNG） ---------- */

// 標高PNG: x = R*2^16 + G*2^8 + B; x<2^23 → x*0.01m, x=2^23 → 無効値, x>2^23 → (x-2^24)*0.01m
const DEM_LAYERS = [
  { id: 'dem5a_png', z: 15 },  // 5mメッシュ（航空レーザ）
  { id: 'dem5b_png', z: 15 },  // 5mメッシュ（写真測量）
  { id: 'dem_png', z: 14 },    // 10mメッシュ
];
const tileCache = new Map();

function loadDemTile(layer, z, x, y) {
  const key = `${layer}/${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, (async () => {
      const res = await fetch(`${GSI}/${key}.png`);
      if (!res.ok) return null; // 海や範囲外は404
      const bmp = await createImageBitmap(await res.blob());
      const c = document.createElement('canvas');
      c.width = 256; c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const out = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) {
        const v = px[i * 4] * 65536 + px[i * 4 + 1] * 256 + px[i * 4 + 2];
        out[i] = v === 8388608 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
      }
      return out;
    })().catch(() => null));
  }
  return tileCache.get(key);
}

const toPixel = (lat, lon, z) => {
  const n = 256 * 2 ** z;
  const s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};
const fromPixel = (px, py, z) => {
  const n = 256 * 2 ** z;
  const lon = px / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * py / n))) * 180 / Math.PI;
  return [lat, lon];
};

async function preloadTiles(layer, z, pixels) {
  const keys = new Set(pixels.map(([px, py]) => `${Math.floor(px / 256)}/${Math.floor(py / 256)}`));
  const loaded = new Map();
  await Promise.all([...keys].map(async (k) => {
    const [x, y] = k.split('/').map(Number);
    loaded.set(k, await loadDemTile(layer, z, x, y));
  }));
  return (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const t = loaded.get(`${tx}/${ty}`);
    if (!t) return NaN;
    return t[(Math.floor(py) - ty * 256) * 256 + (Math.floor(px) - tx * 256)];
  };
}

// 緯度経度の配列 → 標高の配列（5m→10mの順にフォールバック）
async function elevations(points) {
  const result = new Array(points.length).fill(NaN);
  for (const { id, z } of DEM_LAYERS) {
    const todo = result.map((v, i) => (Number.isNaN(v) ? i : -1)).filter((i) => i >= 0);
    if (!todo.length) break;
    const pix = todo.map((i) => toPixel(points[i][0], points[i][1], z));
    const lookup = await preloadTiles(id, z, pix.flatMap(([px, py]) => [[px - 1, py - 1], [px + 1, py + 1], [px - 1, py + 1], [px + 1, py - 1]]));
    todo.forEach((i, k) => {
      // 双一次補間
      const [px, py] = pix[k];
      const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5);
      const fx = px - 0.5 - x0, fy = py - 0.5 - y0;
      const a = lookup(x0, y0), b = lookup(x0 + 1, y0), c = lookup(x0, y0 + 1), d = lookup(x0 + 1, y0 + 1);
      const v = [a, b, c, d].some(Number.isNaN)
        ? lookup(px, py)
        : a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
      result[i] = v;
    });
  }
  return result;
}

/* ---------- 住所・駅・ルート ---------- */

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function geocodeAddress(q) {
  const list = await getJSON(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
  if (!list.length) throw new UserError(`「${q}」の場所が見つかりませんでした。都道府県から入力してみてください。`);
  const [lon, lat] = list[0].geometry.coordinates;
  return { lat, lon, label: list[0].properties.title || q };
}

const dist = (a, b) => {
  const R = 6371008, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function geocodeStation(name, near) {
  const q = name.endsWith('駅') ? name : `${name}駅`;
  const d = 0.15;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=jp&accept-language=ja&limit=10`
    + `&viewbox=${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}&q=${encodeURIComponent(q)}`;
  let hits = [];
  try {
    hits = (await getJSON(url)).filter((h) => h.category === 'railway' || h.type === 'station' || /駅/.test(h.name || ''));
  } catch { /* 下の国土地理院検索へ */ }
  let cands = hits.map((h) => ({ lat: +h.lat, lon: +h.lon, label: h.name ? (h.name.endsWith('駅') ? h.name : `${h.name}駅`) : q }));
  if (!cands.length) {
    const list = await getJSON(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
    cands = list.map((f) => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties.title }));
  }
  if (!cands.length) throw new UserError(`「${q}」が見つかりませんでした。駅名を確認してください。`);
  cands.sort((a, b) => dist([a.lat, a.lon], [near.lat, near.lon]) - dist([b.lat, b.lon], [near.lat, near.lon]));
  const best = cands[0];
  if (dist([best.lat, best.lon], [near.lat, near.lon]) > 10000) {
    throw new UserError(`「${q}」は物件から10km以上離れた場所しか見つかりませんでした。駅名を確認してください。`);
  }
  return best;
}

// JSONP（CORS非対応のAPI用）
function jsonp(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const cb = `__jsonp${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const el = document.createElement('script');
    const done = () => { clearTimeout(timer); delete window[cb]; el.remove(); };
    const timer = setTimeout(() => { done(); reject(new Error('timeout')); }, timeout);
    window[cb] = (data) => { done(); resolve(data); };
    el.onerror = () => { done(); reject(new Error('jsonp')); };
    el.src = `${url}&jsonp=${cb}`;
    document.head.appendChild(el);
  });
}

const stationKey = (label) => label.replace(/駅$/, '').trim();

// 物件の近くの駅を、近い順に最大6駅（同じ名前の駅は路線をまとめる）
async function nearbyStations(near) {
  const byName = new Map();
  const add = (name, lat, lon, line) => {
    const key = stationKey(name);
    const e = byName.get(key) || { lat, lon, label: `${key}駅`, lines: [] };
    if (line && !e.lines.includes(line)) e.lines.push(line);
    byName.set(key, e);
  };
  try {
    const d = await jsonp(`https://express.heartrails.com/api/json?method=getStations&x=${near.lon}&y=${near.lat}`);
    for (const st of (d.response && d.response.station) || []) add(st.name, +st.y, +st.x, st.line);
  } catch { /* 下の OpenStreetMap へ */ }
  if (byName.size < 2) {
    const query = `[out:json][timeout:15];(node["railway"~"^(station|halt)$"](around:2000,${near.lat},${near.lon}););out body;`;
    for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']) {
      try {
        const data = await getJSON(`${host}?data=${encodeURIComponent(query)}`);
        for (const e of data.elements) if (e.tags && e.tags.name) add(e.tags.name, e.lat, e.lon, e.tags.operator);
        break;
      } catch { /* 次のサーバーへ */ }
    }
  }
  return [...byName.values()]
    .map((s) => ({ ...s, dist: dist([s.lat, s.lon], [near.lat, near.lon]) }))
    .filter((s) => s.dist <= 3000)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6);
}

// 徒歩ルート（OSRM foot）。失敗したら直線で代用
async function walkingRoute(from, to) {
  try {
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
    const data = await getJSON(url);
    if (data.code !== 'Ok' || !data.routes.length) throw new Error(data.code);
    return { line: data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]), approx: false };
  } catch {
    return { line: [[from.lat, from.lon], [to.lat, to.lon]], approx: true };
  }
}

// 線をSAMPLE_STEPごとに区切って点にする
function resample(line) {
  const pts = [line[0]], ds = [0];
  let total = 0, carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], seg = dist(a, b);
    let t = SAMPLE_STEP - carry;
    while (t < seg) {
      const f = t / seg;
      pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      ds.push(total + t);
      t += SAMPLE_STEP;
    }
    carry = seg - (t - SAMPLE_STEP);
    total += seg;
  }
  const last = line[line.length - 1];
  if (total - ds[ds.length - 1] > 0.5) { pts.push(last); ds.push(total); }
  return { pts, ds, total };
}

/* ---------- 坂の計算 ---------- */

function smooth(arr, half) {
  return arr.map((_, i) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(arr.length - 1, i + half); k++) {
      if (!Number.isNaN(arr[k])) { s += arr[k]; n++; }
    }
    return n ? s / n : NaN;
  });
}

const LEVELS = [
  { word: 'ほぼ平ら', badge: 'ラク', feel: 'ほぼ平らで、自転車でもラクな道です。' },
  { word: 'ゆるい坂', badge: 'ややラク', feel: 'ゆるい坂があります。自転車でもこいで登れる程度です。' },
  { word: '坂', badge: '坂あり', feel: 'はっきりした坂があります。自転車だと立ちこぎか、押して歩きたくなる程度です。' },
  { word: '急な坂', badge: 'きつい', feel: '急な坂があります。歩いても息が上がり、自転車は押して歩くことになりそうです。' },
];
const gradeClass = (g) => { const a = Math.abs(g); return a < 3 ? 0 : a < 6 ? 1 : a < 10 ? 2 : 3; };
const tobler = (g) => 6 * Math.exp(-3.5 * Math.abs(g / 100 + 0.05)); // km/h

// 向きつきの断面を作る（d: 起点からの距離, h: 標高, g: その先の勾配%）
function buildProfile(ds, hs) {
  const n = hs.length;
  const g = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    // 前後20mで勾配を取る（DEMの細かなノイズを抑える）
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    const run = ds[b] - ds[a];
    g[i] = run > 0 ? (hs[b] - hs[a]) / run * 100 : 0;
  }
  let climb = 0, descent = 0, maxGrade = 0, steepUp = 0, slopeMin = 0;
  const flat = tobler(0);
  for (let i = 1; i < n; i++) {
    const dh = hs[i] - hs[i - 1], run = ds[i] - ds[i - 1];
    if (dh > 0) climb += dh; else descent -= dh;
    const gr = run > 0 ? dh / run * 100 : 0;
    if (g[i - 1] >= 5) steepUp += run;
    slopeMin += run / (WALK_M_PER_MIN * tobler(gr) / flat);
  }
  for (let i = 0; i < n; i++) if (g[i] > maxGrade) maxGrade = g[i];
  return { d: ds, h: hs, g, climb, descent, maxGrade, steepUp, slopeMin, total: ds[n - 1] };
}

function reverseProfile(p) {
  const T = p.total;
  const ds = p.d.map((x) => T - x).reverse();
  return buildProfile(ds, [...p.h].reverse());
}

/* ---------- 等高線 ---------- */

async function drawContours(bounds) {
  contourLayer.clearLayers();
  const z = 15;
  const pad = 0.0035;
  const [x0, y0] = toPixel(bounds.getNorth() + pad, bounds.getWest() - pad, z).map(Math.floor);
  const [x1, y1] = toPixel(bounds.getSouth() - pad, bounds.getEast() + pad, z).map(Math.ceil);
  const W = x1 - x0, H = y1 - y0;
  if (W * H > 1600 * 1600) return; // 広すぎるときは描かない
  const corners = [];
  for (let y = y0; y <= y1; y += 128) for (let x = x0; x <= x1; x += 128) corners.push([x, y]);
  corners.push([x1, y1], [x1, y0], [x0, y1]);
  const fine = await preloadTiles('dem5a_png', z, corners);
  const fine2 = await preloadTiles('dem5b_png', z, corners);
  const coarseCorners = corners.map(([x, y]) => [x / 2, y / 2]);
  const coarse = await preloadTiles('dem_png', 14, coarseCorners);

  const grid = new Float64Array(W * H);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let v = fine(x0 + i, y0 + j);
      if (Number.isNaN(v)) v = fine2(x0 + i, y0 + j);
      if (Number.isNaN(v)) v = coarse((x0 + i) / 2, (y0 + j) / 2);
      grid[j * W + i] = v;
      if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  if (!Number.isFinite(lo)) return;
  for (let k = 0; k < grid.length; k++) if (Number.isNaN(grid[k])) grid[k] = lo - 1;

  const range = hi - lo;
  const step = range < 12 ? 1 : range < 30 ? 2 : range < 80 ? 5 : 10;
  const thresholds = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) thresholds.push(t);

  const contour = d3.contours().size([W, H]).smooth(true).thresholds(thresholds);
  const brown = '#8a4f22';
  for (const c of contour(grid)) {
    const major = Math.round(c.value) % (step * 5) === 0;
    const lines = [];
    for (const poly of c.coordinates) for (const ring of poly) {
      // 外周の枠に沿った線は描かない
      const pts = [];
      for (const [x, y] of ring) {
        const edge = x <= 0.5 || y <= 0.5 || x >= W - 0.5 || y >= H - 0.5;
        if (edge) { if (pts.length > 1) lines.push(pts.splice(0)); else pts.length = 0; continue; }
        pts.push(fromPixel(x0 + x, y0 + y, z));
      }
      if (pts.length > 1) lines.push(pts);
    }
    if (!lines.length) continue;
    const pl = L.polyline(lines, { color: brown, weight: major ? 1.6 : 0.8, opacity: major ? 0.85 : 0.55, interactive: true });
    pl.bindTooltip(`標高 ${c.value}m`, { sticky: true });
    contourLayer.addLayer(pl);
  }
  contourLayer.contourStep = step;
}

/* ---------- 画面 ---------- */

class UserError extends Error {}
let state = null;          // { home, sta, toHome: profile, toSta: profile, line }
let dirToHome = true;
let chart = null;

function showMessage(text, info = false) {
  const m = $('message');
  m.textContent = text; m.hidden = !text; m.className = info ? 'message info' : 'message';
}
function setBusy(on) { $('busy').hidden = !on; $('go').disabled = on; }

function gradeColors() { return [cssVar('--g0'), cssVar('--g1'), cssVar('--g2'), cssVar('--g3')]; }

function render() {
  const p = dirToHome ? state.toHome : state.toSta;
  const fmt = (v, k = 0) => (Number.isFinite(v) ? v.toFixed(k) : '-');
  $('fromLabel').textContent = dirToHome ? state.sta.label : '物件';
  $('toLabel').textContent = dirToHome ? '物件' : state.sta.label;
  renderStations();
  $('sDist').textContent = Math.round(p.total).toLocaleString();
  $('sMin').textContent = Math.max(1, Math.ceil(p.total / WALK_M_PER_MIN));
  $('sMinSlope').textContent = Math.max(1, Math.round(p.slopeMin));
  $('sClimb').textContent = fmt(p.climb);
    $('sSteep').textContent = Math.round(p.steepUp / 10) * 10;
  $('eHome').textContent = fmt(state.toSta.h[0], 1);
  $('eSta').textContent = fmt(state.toHome.h[0], 1);

  const other = dirToHome ? state.toSta : state.toHome;
  const lv = gradeClass(p.maxGrade);
  const floors = Math.round(p.climb / 3);
  $('sFloors').textContent = floors >= 1 ? `ビル${floors}階分` : '登りはほぼなし';
  $('sGradeWord').textContent = LEVELS[lv].word;
  $('sGrade').textContent = `100mで${fmt(Math.max(0, p.maxGrade), 1)}m上がる`;
  $('levelBadge').textContent = LEVELS[lv].badge;
  $('levelBadge').className = `badge lv${lv}`;
  const way = dirToHome ? '帰り道' : '行き道';
  $('verdict').textContent = `${way}は${LEVELS[lv].feel}`
    + (floors >= 1 ? `途中で登る高さは合わせてビル${floors}階分（${fmt(p.climb)}m）です。` : '登りはほとんどありません。')
    + `逆向きの${dirToHome ? '行き道' : '帰り道'}は${fmt(other.climb)}m登ります。`
    + (state.approx ? ' ※徒歩ルートが取れなかったため、まっすぐ歩いたとして計算しています。' : '');

  $('dirHome').classList.toggle('on', dirToHome); $('dirHome').setAttribute('aria-pressed', dirToHome);
  $('dirStation').classList.toggle('on', !dirToHome); $('dirStation').setAttribute('aria-pressed', !dirToHome);

  drawRoute(p);
  drawChart(p);
}

function drawRoute(p) {
  routeLayer.clearLayers();
  const cols = gradeColors();
  const pts = dirToHome ? [...state.pts].reverse() : state.pts;
  L.polyline(pts, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
  let start = 0;
  for (let i = 1; i <= pts.length; i++) {
    if (i === pts.length || gradeClass(p.g[i]) !== gradeClass(p.g[start])) {
      L.polyline(pts.slice(start, Math.min(i + 1, pts.length)), { color: cols[gradeClass(p.g[start])], weight: 5, opacity: 1, interactive: false }).addTo(routeLayer);
      start = i;
    }
  }
  state.cursorPts = pts;
}

function drawChart(p) {
  const cols = gradeColors();
  const ink = cssVar('--muted'), line = cssVar('--line');
  const data = p.d.map((d, i) => ({ x: Math.round(d), y: +p.h[i].toFixed(1), g: p.g[i] }));
  const ys = p.h.filter(Number.isFinite);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = Math.max(10, hi - lo); // 平らな道で坂が大げさに見えないよう最低10m幅
  const mid = (hi + lo) / 2;
  const cfg = {
    type: 'line',
    data: { datasets: [{
      data, parsing: false, pointRadius: 0, borderWidth: 3, tension: 0.2,
      fill: 'start', backgroundColor: 'rgba(154,90,44,0.12)',
      segment: { borderColor: (ctx) => cols[gradeClass(data[ctx.p0DataIndex].g)] },
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'linear', min: 0, max: Math.round(p.total), title: { display: true, text: dirToHome ? '駅からの距離' : '物件からの距離', color: ink }, ticks: { color: ink, callback: (v) => `${v}m`, maxTicksLimit: 6, includeBounds: false }, grid: { color: line } },
        y: { min: Math.floor(mid - span * 0.6), max: Math.ceil(mid + span * 0.6), ticks: { color: ink, callback: (v) => `${v}m`, maxTicksLimit: 5, includeBounds: false }, grid: { color: line } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => `${items[0].raw.x}m地点`,
            label: (item) => [`標高 ${item.raw.y}m`, `勾配 ${item.raw.g >= 0 ? '+' : ''}${item.raw.g.toFixed(1)}%`],
          },
        },
      },
      onHover: (_e, els) => {
        if (els.length && state.cursorPts) cursor.setLatLng(state.cursorPts[els[0].index]).addTo(map);
        else cursor.remove();
      },
    },
  };
  if (chart) chart.destroy();
  chart = new Chart($('profile'), cfg);
  $('profile').onmouseleave = () => cursor.remove();
}

function placeMarkers() {
  if (homeMarker) homeMarker.remove();
  if (staMarker) staMarker.remove();
  homeMarker = L.marker([state.home.lat, state.home.lon], { icon: pinIcon('home', '家'), draggable: true, title: '物件（ドラッグで位置を直せます）' }).addTo(map);
  staMarker = L.marker([state.sta.lat, state.sta.lon], { icon: pinIcon('sta', '駅'), draggable: true, title: `${state.sta.label}（ドラッグで位置を直せます）` }).addTo(map);
  homeMarker.on('dragend', () => { const ll = homeMarker.getLatLng(); recompute({ ...state.home, lat: ll.lat, lon: ll.lng }, state.sta); });
  staMarker.on('dragend', () => { const ll = staMarker.getLatLng(); recompute(state.home, { ...state.sta, lat: ll.lat, lon: ll.lng }); });
}

async function recompute(home, sta) {
  setBusy(true);
  try {
    const route = await walkingRoute(home, sta);
    // ルート端点を物件・駅の位置につなぐ
    const line = [[home.lat, home.lon], ...route.line, [sta.lat, sta.lon]];
    const { pts, ds } = resample(line);
    const raw = await elevations(pts);
    if (raw.every(Number.isNaN)) throw new UserError('この場所の標高データが取れませんでした。');
    const hs = smooth(raw, 2);
    const toSta = buildProfile(ds, hs);
    state = { home, sta, pts, approx: route.approx, toSta, toHome: reverseProfile(toSta) };
    placeMarkers();
    $('result').hidden = false;
    render();
    const b = L.latLngBounds(pts);
    map.fitBounds(b, { padding: [40, 40], maxZoom: 17 });
    $('gsiLink').href = `https://maps.gsi.go.jp/#16/${b.getCenter().lat.toFixed(6)}/${b.getCenter().lng.toFixed(6)}/&base=std&ls=std%7Crelief&disp=11`;
    await drawContours(b).catch(() => {});
  } finally {
    setBusy(false);
  }
}

let candidates = [];

function renderStations() {
  const box = $('stationList');
  box.textContent = '';
  $('stationPick').hidden = candidates.length < 2;
  for (const c of candidates) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (state && stationKey(state.sta.label) === stationKey(c.label) ? ' on' : '');
    const name = document.createElement('b'); name.textContent = c.label;
    const info = document.createElement('small');
    info.textContent = [c.lines.slice(0, 3).join('・'), Number.isFinite(c.dist) ? `直線${Math.round(c.dist / 10) * 10}m` : ''].filter(Boolean).join(' ／ ');
    b.append(name, info);
    b.addEventListener('click', () => pickStation(c));
    box.append(b);
  }
}

async function pickStation(c) {
  if (!state || stationKey(state.sta.label) === stationKey(c.label)) return;
  showMessage('');
  $('station').value = stationKey(c.label);
  try {
    await recompute(state.home, c);
    updateUrl($('addr').value.trim(), stationKey(c.label));
  } catch (e) {
    console.error(e);
    showMessage('データの取得に失敗しました。通信状況を確認して、もう一度お試しください。');
  }
}

function updateUrl(addr, st) {
  const u = new URL(location.href);
  u.searchParams.set('addr', addr);
  if (st) u.searchParams.set('st', st); else u.searchParams.delete('st');
  history.replaceState(null, '', u);
}

async function search(addr, stationName) {
  showMessage('');
  setBusy(true);
  try {
    const typed = stationName.trim();
    const home = await geocodeAddress(addr);
    home.label = addr;
    candidates = await nearbyStations(home).catch(() => []);
    let sta;
    if (typed) {
      sta = candidates.find((c) => stationKey(c.label) === stationKey(typed));
      if (!sta) {
        sta = { lines: [], ...(await geocodeStation(typed, home)) };
        sta.dist = dist([sta.lat, sta.lon], [home.lat, home.lon]);
        candidates = [sta, ...candidates.filter((c) => stationKey(c.label) !== stationKey(sta.label))].slice(0, 6);
      }
    } else {
      if (!candidates.length) throw new UserError('近くの駅が見つかりませんでした。最寄り駅の名前を入れてください。');
      sta = candidates[0];
      $('station').value = stationKey(sta.label);
    }
    await recompute(home, sta);
    updateUrl(addr, typed);
    if (!typed && candidates.length > 1) showMessage(`一番近い${sta.label}で計算しました。ほかの駅は下の一覧から選べます。`, true);
  } catch (e) {
    console.error(e);
    showMessage(e instanceof UserError ? e.message : 'データの取得に失敗しました。通信状況を確認して、もう一度お試しください。');
  } finally {
    setBusy(false);
  }
}

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  search($('addr').value.trim(), $('station').value);
});
$('dirHome').addEventListener('click', () => { if (state) { dirToHome = true; render(); } });
$('dirStation').addEventListener('click', () => { if (state) { dirToHome = false; render(); } });

// 起動時：URLの指定、なければ例を表示
(() => {
  const q = new URLSearchParams(location.search);
  const addr = q.get('addr'), st = q.get('st');
  if (addr) {
    $('addr').value = addr; $('station').value = st || '';
    search(addr, st || '');
  } else {
    $('addr').value = EXAMPLE.addr; $('station').value = EXAMPLE.station;
    search(EXAMPLE.addr, EXAMPLE.station).then(() => {
      if (state) showMessage('例として元麻布の物件を表示しています。調べたい物件の住所を入れてください。', true);
    });
  }
})();
