/* 物件1件を条件と照らして点数をつける。ブラウザ（window.Score）と Node（require）の両方で使う。
 * 分からない項目は「?」のまま（減点も加点もしない）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Score = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const known = (v) => v !== null && v !== undefined && v !== '';
  const totalRent = (l) => (known(l.rent) ? l.rent + (l.fee || 0) : null);
  const facing = (d) => (known(d) ? /南|東/.test(d) : null);
  const layoutOk = (layout, list) => {
    if (!known(layout)) return null;
    const norm = String(layout).toUpperCase().replace(/\s/g, '');
    return list.some((x) => norm === x.toUpperCase()) || /^[2-9](LDK|SLDK|DK)$/.test(norm);
  };

  // 必須条件：pass / relaxed（ゆるめた条件なら OK）/ fail / unknown
  function checkMust(l, m, climb) {
    const out = [];
    const add = (label, state, detail) => out.push({ label, state, detail });

    const rent = totalRent(l);
    add('家賃（管理費こみ）', !known(rent) ? 'unknown' : rent <= m.rentMax ? 'pass' : rent <= m.rentMaxRelaxed ? 'relaxed' : 'fail',
      known(rent) ? `${(rent / 10000).toFixed(1)}万円` : '');
    add('駅から徒歩', !known(l.walkMin) ? 'unknown' : l.walkMin <= m.walkMax ? 'pass' : l.walkMin <= m.walkMaxRelaxed ? 'relaxed' : 'fail',
      known(l.walkMin) ? `${l.station || ''}${l.walkMin}分` : '');
    add('広さ', !known(l.areaM2) ? 'unknown' : l.areaM2 >= m.areaMin ? 'pass' : l.areaM2 >= m.areaMinRelaxed ? 'relaxed' : 'fail',
      known(l.areaM2) ? `${l.areaM2}㎡` : '');
    const lay = layoutOk(l.layout, m.layouts);
    add('間取り（2人で住める）', lay === null ? 'unknown' : lay ? 'pass' : 'fail', l.layout || '');
    if (m.balcony) add('ベランダ', !known(l.balcony) ? 'unknown' : l.balcony ? 'pass' : 'fail', '');
    if (m.twoPeople) add('2人入居OK', !known(l.twoPeople) ? 'unknown' : l.twoPeople ? 'pass' : 'fail', '');
    if (known(climb)) add('駅との高低差', climb <= m.climbMax ? 'pass' : 'fail', `約${climb.toFixed(1)}m`);
    return out;
  }

  function niceFlags(l, c) {
    const year = new Date().getFullYear();
    return {
      walk3: known(l.walkMin) ? l.walkMin <= 3 : null,
      corner: known(l.corner) ? !!l.corner : null,
      windows2: known(l.windows2) ? !!l.windows2 : (l.corner ? true : null),
      southEast: facing(l.direction),
      sunny: known(l.sunny) ? !!l.sunny : null,
      living12: known(l.livingJo) ? l.livingJo >= 12 : null,
      riverside: known(l.riverside) ? !!l.riverside : null,
      floor3: known(l.floor) ? l.floor >= 3 : null,
      area45: known(l.areaM2) ? l.areaM2 >= 45 : null,
      age35: known(l.builtYear) ? year - l.builtYear <= 35 : null,
    };
  }

  function watchMatch(l, c) {
    const text = `${l.title || ''} ${l.building || ''}`;
    return (c.watchBuildings || []).find((w) => w.keys.some((k) => text.includes(k))) || null;
  }

  // climb: 駅と家の高低差（m、分かれば）。ブラウザで地理院の標高から計算して渡す
  function score(l, c, climb) {
    const must = checkMust(l, c.must, climb);
    const flags = niceFlags(l, c);
    const nice = c.nice.map((n) => ({ label: n.label, points: n.points, state: flags[n.key] === null || flags[n.key] === undefined ? 'unknown' : flags[n.key] ? 'pass' : 'fail' }));
    const watch = watchMatch(l, c);

    const fails = must.filter((x) => x.state === 'fail').length;
    const relaxed = must.filter((x) => x.state === 'relaxed').length;
    const tier = fails ? 'out' : relaxed ? 'near' : 'match';

    const max = c.nice.reduce((s, n) => s + n.points, 0) + (c.watchBonus || 0);
    let pts = nice.reduce((s, n) => s + (n.state === 'pass' ? n.points : 0), 0);
    if (watch) pts += c.watchBonus || 0;
    const points = Math.round((pts / max) * 100);
    const unknowns = must.concat(nice).filter((x) => x.state === 'unknown').length;

    return { tier, points, must, nice, watch: watch ? watch.name : null, unknowns };
  }

  const TIER_LABEL = { match: 'ぴったり', near: 'おしい', out: '条件外' };
  const TIER_ORDER = { match: 0, near: 1, out: 2 };

  return { score, totalRent, TIER_LABEL, TIER_ORDER };
});
