/* 物件1件を条件と照らして点数をつける。ブラウザ（window.Score）と Node（require）の両方で使う。
 * 分からない項目は「?」のまま（減点も加点もしない）。
 * 条件（criteria.json）は「条件えらび」ページで決めたものをそのまま保存している。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Score = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const known = (v) => v !== null && v !== undefined && v !== '';
  const has = (l, tag) => (Array.isArray(l.features) && l.features.some((f) => String(f).includes(tag)) ? true : null);
  const bool = (v) => (known(v) ? !!v : null);
  const dir = (l, re) => (known(l.direction) ? re.test(l.direction) : null);

  // こだわり項目。key は条件えらびページと同じ。test は true / false / null（分からない）を返す
  const FEATURES = [
    { key: 'balcony', label: 'ベランダ', test: (l) => bool(l.balcony) ?? has(l, 'バルコニー') },
    { key: 'twoPeople', label: '2人入居OK', test: (l) => bool(l.twoPeople) ?? has(l, '二人入居') },
    { key: 'walk3', label: '駅まで3分以内', test: (l) => (known(l.walkMin) ? l.walkMin <= 3 : null) },
    { key: 'corner', label: '角部屋', test: (l) => bool(l.corner) ?? has(l, '角部屋') },
    { key: 'windows2', label: '窓が2方向以上', test: (l) => bool(l.windows2) ?? (l.corner ? true : null) },
    { key: 'south', label: '南向き', test: (l) => dir(l, /南/) },
    { key: 'east', label: '東向き', test: (l) => dir(l, /東/) },
    { key: 'sunny', label: '日当たり良好', test: (l) => bool(l.sunny) ?? has(l, '日当') },
    { key: 'living12', label: 'リビング12畳以上', test: (l) => (known(l.livingJo) ? l.livingJo >= 12 : null) },
    { key: 'riverside', label: '川沿い・眺望良好', test: (l) => bool(l.riverside) ?? has(l, '眺望') },
    { key: 'area45', label: '45㎡以上', test: (l) => (known(l.areaM2) ? l.areaM2 >= 45 : null) },
    { key: 'bathToilet', label: 'バス・トイレ別', test: (l) => has(l, 'バス・トイレ別') ?? has(l, 'バストイレ別') },
    { key: 'washstand', label: '独立洗面台', test: (l) => has(l, '洗面') },
    { key: 'laundry', label: '室内洗濯機置場', test: (l) => has(l, '室内洗濯') },
    { key: 'bathDryer', label: '浴室乾燥機', test: (l) => has(l, '浴室乾燥') },
    { key: 'stove2', label: 'コンロ2口以上', test: (l) => has(l, '2口') ?? has(l, '3口') },
    { key: 'elevator', label: 'エレベーター', test: (l) => has(l, 'エレベーター') },
    { key: 'autolock', label: 'オートロック', test: (l) => has(l, 'オートロック') },
    { key: 'delivery', label: '宅配ボックス', test: (l) => has(l, '宅配ボックス') },
    { key: 'internet', label: 'ネット無料', test: (l) => has(l, 'インターネット無料') ?? has(l, 'ネット無料') },
    { key: 'bike', label: '駐輪場', test: (l) => has(l, '駐輪場') },
    { key: 'soho', label: '事務所利用可（SOHO）', test: (l) => has(l, 'SOHO') ?? has(l, '事務所') },
    { key: 'pet', label: 'ペット可', test: (l) => has(l, 'ペット') },
    { key: 'rc', label: '鉄筋コンクリート', test: (l) => has(l, '鉄筋') ?? has(l, 'RC') },
    { key: 'notFirst', label: '1階以外', test: (l) => (known(l.floor) ? l.floor >= 2 : null) },
  ];
  const WEIGHT = { high: 20, nice: 10 };

  const totalRent = (l) => (known(l.rent) ? l.rent + (l.fee || 0) : null);
  const layoutOk = (layout, list) => {
    if (!known(layout)) return null;
    const norm = String(layout).toUpperCase().replace(/\s/g, '');
    return list.some((x) => norm === x.toUpperCase());
  };
  const range = (v, limit, slack, lower) => {
    if (!known(v) || !known(limit)) return known(limit) ? 'unknown' : null;
    const ok = lower ? v >= limit : v <= limit;
    const near = lower ? v >= limit - (slack || 0) : v <= limit + (slack || 0);
    return ok ? 'pass' : near && slack ? 'relaxed' : 'fail';
  };

  function checkMust(l, c, climb) {
    const out = [];
    const add = (label, state, detail) => state && out.push({ label, state, detail: detail || '' });
    const rent = totalRent(l);
    add('家賃（管理費こみ）', range(rent, c.rentMax, c.rentSlack), known(rent) ? `${(rent / 10000).toFixed(1)}万円` : '');
    add('駅から徒歩', range(l.walkMin, c.walkMax, c.walkSlack), known(l.walkMin) ? `${l.station || ''}${l.walkMin}分` : '');
    add('広さ', range(l.areaM2, c.areaMin, c.areaSlack, true), known(l.areaM2) ? `${l.areaM2}㎡` : '');
    if (c.layouts && c.layouts.length) {
      const ok = layoutOk(l.layout, c.layouts);
      add('間取り', ok === null ? 'unknown' : ok ? 'pass' : 'fail', l.layout || '');
    }
    if (c.stations && c.stations.length && known(l.station)) {
      add('駅', c.stations.includes(String(l.station).replace(/駅$/, '')) ? 'pass' : 'relaxed', l.station);
    }
    if (known(c.builtWithin)) {
      const age = known(l.builtYear) ? new Date().getFullYear() - l.builtYear : null;
      add(`築${c.builtWithin}年以内`, age === null ? 'unknown' : age <= c.builtWithin ? 'pass' : age <= c.builtWithin + 5 ? 'relaxed' : 'fail', age === null ? '' : `築${age}年`);
    }
    if (known(c.floorMin)) add(`${c.floorMin}階以上`, range(l.floor, c.floorMin, 0, true), known(l.floor) ? `${l.floor}階` : '');
    if (known(c.climbMax) && known(climb)) add('駅との高低差', climb <= c.climbMax ? 'pass' : 'fail', `約${climb.toFixed(1)}m`);
    for (const f of FEATURES) {
      if ((c.features || {})[f.key] !== 'must') continue;
      const v = f.test(l);
      add(f.label, v === null ? 'unknown' : v ? 'pass' : 'fail');
    }
    return out;
  }

  function watchMatch(l, c) {
    const text = `${l.title || ''} ${l.building || ''}`;
    return (c.watchBuildings || []).find((w) => w.on !== false && (w.keys || [w.name]).some((k) => text.includes(k))) || null;
  }

  // climb: 駅と家の高低差（m、分かれば）。ブラウザで地理院の標高から計算して渡す
  function score(l, c, climb) {
    const must = checkMust(l, c, climb);
    const prefs = FEATURES.filter((f) => WEIGHT[(c.features || {})[f.key]]);
    const nice = prefs.map((f) => {
      const v = f.test(l);
      return { label: f.label, points: WEIGHT[c.features[f.key]], high: c.features[f.key] === 'high', state: v === null ? 'unknown' : v ? 'pass' : 'fail' };
    });
    const watch = watchMatch(l, c);

    const tier = must.some((x) => x.state === 'fail') ? 'out' : must.some((x) => x.state === 'relaxed') ? 'near' : 'match';
    const max = nice.reduce((s, n) => s + n.points, 0) + (c.watchBonus || 0);
    const pts = nice.reduce((s, n) => s + (n.state === 'pass' ? n.points : 0), 0) + (watch ? c.watchBonus || 0 : 0);
    const points = max ? Math.round((pts / max) * 100) : 0;
    const unknowns = must.concat(nice).filter((x) => x.state === 'unknown').length;
    return { tier, points, must, nice, watch: watch ? watch.name : null, unknowns };
  }

  const TIER_LABEL = { match: 'ぴったり', near: 'おしい', out: '条件外' };
  const TIER_ORDER = { match: 0, near: 1, out: 2 };

  return { score, totalRent, FEATURES, TIER_LABEL, TIER_ORDER };
});
