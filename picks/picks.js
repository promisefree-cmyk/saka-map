'use strict';

const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const man = (yen) => (yen == null ? '?' : `${(yen / 10000).toFixed(1)}万`);

/* ---------- 見る人ごとの小さな記録（見送り・場所のキャッシュ） ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};
const skipped = new Set(store.get('picks.skipped', []));
const geoCache = store.get('picks.geo', {});

/* ---------- 地図 ---------- */
const map = L.map('map', { preferCanvas: true }).setView([35.6765, 139.778], 15);
L.tileLayer(`${GSI}/pale/{z}/{x}/{y}.png`, { maxZoom: 19, maxNativeZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>' }).addTo(map);
L.tileLayer(`${GSI}/hillshademap/{z}/{x}/{y}.png`, { maxZoom: 19, maxNativeZoom: 16, opacity: 0.3 }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
const pinLayer = L.layerGroup().addTo(map);
const markers = new Map();

/* ---------- 場所と標高（国土地理院） ---------- */
async function geocode(addr) {
  if (!addr) return null;
  if (geoCache[addr]) return geoCache[addr];
  try {
    const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(addr)}`);
    const list = await res.json();
    if (!list.length) return null;
    const [lon, lat] = list[0].geometry.coordinates;
    geoCache[addr] = [lat, lon];
    store.set('picks.geo', geoCache);
    return geoCache[addr];
  } catch { return null; }
}

const tiles = new Map();
function demTile(layer, z, x, y) {
  const key = `${layer}/${z}/${x}/${y}`;
  if (!tiles.has(key)) {
    tiles.set(key, fetch(`${GSI}/${key}.png`).then(async (r) => {
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, 256, 256).data;
    }).catch(() => null));
  }
  return tiles.get(key);
}
async function elevation([lat, lon]) {
  for (const [layer, z] of [['dem5a_png', 15], ['dem5b_png', 15], ['dem_png', 14]]) {
    const n = 256 * 2 ** z, s = Math.sin(lat * Math.PI / 180);
    const px = (lon + 180) / 360 * n, py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
    const d = await demTile(layer, z, Math.floor(px / 256), Math.floor(py / 256));
    if (!d) continue;
    const i = ((Math.floor(py) % 256) * 256 + (Math.floor(px) % 256)) * 4;
    const v = d[i] * 65536 + d[i + 1] * 256 + d[i + 2];
    if (v === 8388608) continue;
    return (v < 8388608 ? v : v - 16777216) * 0.01;
  }
  return null;
}
const distM = (a, b) => {
  const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r), y = (b[0] - a[0]) * r;
  return Math.hypot(x, y) * 6371000;
};

/* ---------- 表示 ---------- */
let criteria, listings, filter = 'good';
const extra = new Map(); // id → { pos, climb }

function sakaUrl(addr, station) {
  const u = new URL('../', location.href);
  if (addr) u.searchParams.set('addr', addr);
  if (station) u.searchParams.set('st', station.replace(/駅$/, ''));
  return u.href;
}

function renderCriteria() {
  const c = criteria, f = c.features || {};
  const by = (lv) => Score.FEATURES.filter((x) => f[x.key] === lv).map((x) => esc(x.label)).join('、') || 'なし';
  $('criteriaBody').innerHTML = `<ul>
    <li><b>駅</b>：${esc((c.stations || []).join('・'))}</li>
    <li><b>家賃</b>：管理費こみ ${man(c.rentMax)}円まで${c.rentSlack ? `（+${man(c.rentSlack)}円までは「おしい」）` : ''}</li>
    <li><b>駅から</b>：徒歩${c.walkMax}分まで${c.walkSlack ? `（+${c.walkSlack}分までは「おしい」）` : ''}${c.climbMax != null ? `、高低差${c.climbMax}m以内` : ''}</li>
    <li><b>部屋</b>：${c.areaMin}㎡以上、${esc((c.layouts || []).join('・'))}${c.builtWithin != null ? `、築${c.builtWithin}年以内` : ''}${c.floorMin != null ? `、${c.floorMin}階以上` : ''}</li>
    <li><b>必須</b>：${by('must')}</li>
    <li><b>大事</b>：${by('high')}</li>
    <li><b>あれば</b>：${by('nice')}</li>
    ${c.memo ? `<li><b>メモ</b>：${esc(c.memo)}</li>` : ''}
  </ul>`;
}

function card(l, s, isNew) {
  const ex = extra.get(l.id) || {};
  const rent = Score.totalRent(l);
  const checks = (arr, cls) => `<ul class="checks ${cls}">${arr.map((c) => `<li class="${c.state}${c.high ? ' high' : ''}">${esc(c.label)}${c.detail ? ` <small>${esc(c.detail)}</small>` : ''}</li>`).join('')}</ul>`;
  const li = document.createElement('li');
  li.className = `card${skipped.has(l.id) ? ' skipped' : ''}`;
  li.id = `c-${l.id}`;
  li.innerHTML = `
    <div class="card-head">
      <div class="tier ${s.tier}">${Score.TIER_LABEL[s.tier]}<b>${s.points}</b></div>
      <div>
        <h3>${esc(l.title || '建物名なし')}${l.room ? ` ${esc(l.room)}` : ''}${isNew ? '<span class="new">NEW</span>' : ''}${s.watch ? '<span class="watchmark">気になる建物</span>' : ''}</h3>
        <p class="addr">${esc(l.address || '住所不明')} ・ ${esc(l.source || '')} ・ ${esc(l.firstSeen || '')}に発見</p>
      </div>
    </div>
    <dl class="facts">
      <div><dt>家賃（管理費こみ）</dt><dd>${man(rent)}円</dd></div>
      <div><dt>間取り・広さ</dt><dd>${esc(l.layout || '?')} ${l.areaM2 ?? '?'}㎡</dd></div>
      <div><dt>駅から</dt><dd>${esc(l.station || '')}${l.walkMin ?? '?'}分</dd></div>
      <div><dt>駅との高低差</dt><dd>${ex.climb == null ? '…' : `約${ex.climb.toFixed(1)}m`}</dd></div>
    </dl>
    ${checks(s.must, 'must')}
    ${checks(s.nice, 'nice')}
    ${l.notes ? `<p class="note">${esc(l.notes)}</p>` : ''}
    <div class="actions">
      ${l.url ? `<a class="primary" href="${esc(l.url)}" target="_blank" rel="noopener">物件ページを開く</a>` : ''}
      <a href="${esc(sakaUrl(l.address, l.station))}" target="_blank" rel="noopener">坂道を見る</a>
      ${l.mailUrl ? `<a href="${esc(l.mailUrl)}" target="_blank" rel="noopener">元のメール</a>` : ''}
      <button type="button" data-skip="${esc(l.id)}">${skipped.has(l.id) ? '見送りをやめる' : '見送り'}</button>
    </div>`;
  li.addEventListener('mouseenter', () => markers.get(l.id)?.openTooltip());
  return li;
}

function scored() {
  return listings.map((l) => ({ l, s: Score.score(l, criteria, extra.get(l.id)?.climb ?? null) }))
    .sort((a, b) => Score.TIER_ORDER[a.s.tier] - Score.TIER_ORDER[b.s.tier] || b.s.points - a.s.points || (b.l.firstSeen || '').localeCompare(a.l.firstSeen || ''));
}

function render() {
  const latest = listings.reduce((m, l) => (l.firstSeen > m ? l.firstSeen : m), '');
  const all = scored();
  const shown = all.filter(({ l, s }) =>
    filter === 'skipped' ? skipped.has(l.id) : !skipped.has(l.id) && (filter === 'all' || s.tier !== 'out'));

  const ol = $('cards');
  ol.replaceChildren(...shown.map(({ l, s }) => card(l, s, l.firstSeen === latest)));

  const empty = $('empty');
  empty.hidden = shown.length > 0;
  if (!listings.length) {
    empty.innerHTML = '<b>まだ物件がありません。</b>物件サイトの「新着お知らせメール」が届き始めると、毎朝ここに並びます。下の「気になる建物」から坂の様子は先に見られます。';
  } else if (!shown.length) {
    const outN = all.filter(({ l, s }) => s.tier === 'out' && !skipped.has(l.id)).length;
    empty.innerHTML = filter === 'skipped' ? '見送りにした物件はありません。'
      : `条件に合う物件はまだありません（条件外 ${outN}件）。「条件外もすべて」で見られます。`;
  }

  pinLayer.clearLayers(); markers.clear();
  const pts = [];
  shown.forEach(({ l, s }, i) => {
    const pos = extra.get(l.id)?.pos;
    if (!pos) return;
    pts.push(pos);
    const m = L.marker(pos, { icon: L.divIcon({ className: '', html: `<div class="ppin ${s.tier}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindTooltip(`${esc(l.title || '')} ${man(Score.totalRent(l))}円`)
      .on('click', () => {
        document.querySelectorAll('.card.focus').forEach((c) => c.classList.remove('focus'));
        const c = $(`c-${l.id}`); c?.classList.add('focus'); c?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    m.addTo(pinLayer); markers.set(l.id, m);
  });
  Object.entries(criteria.stationCoords).filter(([n]) => (criteria.stations || []).includes(n)).forEach(([name, pos]) => {
    L.marker(pos, { icon: L.divIcon({ className: '', html: '<div class="spin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) })
      .bindTooltip(`${esc(name)}駅`, { direction: 'top', offset: [0, -6] }).addTo(pinLayer);
  });
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 16 });
}

function renderWatch() {
  $('watchList').innerHTML = criteria.watchBuildings.filter((w) => w.on !== false).map((w) =>
    `<li>${esc(w.name)}<a href="${esc(sakaUrl(w.address, w.station))}" target="_blank" rel="noopener">坂道を見る</a></li>`).join('');
}

// 住所→位置→標高を順に調べて、分かったら描き直す
async function enrich() {
  const st = criteria.stationCoords;
  const stElev = new Map();
  for (const l of listings) {
    const pos = await geocode(l.address);
    if (!pos) continue;
    const name = (l.station || '').replace(/駅$/, '');
    const sPos = st[name] || Object.values(st).sort((a, b) => distM(pos, a) - distM(pos, b))[0];
    if (!stElev.has(sPos)) stElev.set(sPos, await elevation(sPos));
    const h = await elevation(pos), hs = stElev.get(sPos);
    extra.set(l.id, { pos, climb: h == null || hs == null ? null : Math.abs(h - hs) });
  }
  render();
}

document.querySelector('.filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('.filters .chip').forEach((c) => c.classList.toggle('on', c === b));
  render();
});
$('cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-skip]');
  if (!b) return;
  const id = b.dataset.skip;
  if (skipped.has(id)) skipped.delete(id); else skipped.add(id);
  store.set('picks.skipped', [...skipped]);
  render();
});

(async function init() {
  try {
    const [c, l] = await Promise.all([
      fetch('criteria.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('listings.json', { cache: 'no-cache' }).then((r) => r.json()),
    ]);
    criteria = c; listings = l;
  } catch {
    $('empty').hidden = false;
    $('empty').textContent = '物件データを読み込めませんでした。少し待ってから再読み込みしてください。';
    return;
  }
  const last = listings.reduce((m, l) => ((l.lastSeen || '') > m ? l.lastSeen : m), '');
  $('updated').textContent = last ? `最終更新 ${last}（全${listings.length}件）` : 'まだ物件は届いていません';
  renderCriteria(); renderWatch(); render();
  enrich();
})();
