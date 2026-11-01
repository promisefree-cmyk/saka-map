#!/usr/bin/env node
/* 新しく見つけた物件（JSON配列）を picks/listings.json に足す。
 * 使い方: node tools/add-listings.cjs new.json
 * - 同じ物件（URL か、建物名+部屋+家賃 が同じ）は重ねず、新しい情報で上書き
 * - 初めて見た日を firstSeen に記録
 * - 最後に、今回新しく入った「ぴったり」「おしい」物件を表示する */
'use strict';
const fs = require('fs');
const path = require('path');
const Score = require('../picks/score.js');

const root = path.join(__dirname, '..');
const listPath = path.join(root, 'picks', 'listings.json');
const criteria = JSON.parse(fs.readFileSync(path.join(root, 'picks', 'criteria.json'), 'utf8'));

const FIELDS = ['source', 'url', 'title', 'room', 'address', 'station', 'walkMin', 'rent', 'fee', 'deposit', 'keyMoney',
  'layout', 'areaM2', 'livingJo', 'floor', 'floors', 'builtYear', 'direction', 'corner', 'balcony', 'windows2',
  'sunny', 'riverside', 'twoPeople', 'features', 'notes', 'mailDate', 'mailUrl'];
const NUMS = ['walkMin', 'rent', 'fee', 'deposit', 'keyMoney', 'areaM2', 'livingJo', 'floor', 'floors', 'builtYear'];
const BOOLS = ['corner', 'balcony', 'windows2', 'sunny', 'riverside', 'twoPeople'];

function clean(raw) {
  const o = {};
  for (const k of FIELDS) {
    let v = raw[k];
    if (v === undefined || v === '') v = null;
    if (v !== null && NUMS.includes(k)) { v = Number(String(v).replace(/[^\d.]/g, '')); if (!Number.isFinite(v)) v = null; }
    if (v !== null && BOOLS.includes(k)) v = v === true || v === 'true' || v === 'あり' || v === 'はい';
    if (v !== null && k === 'features') v = (Array.isArray(v) ? v : String(v).split(/[、,／/]/)).map((x) => String(x).trim()).filter(Boolean);
    o[k] = v;
  }
  if (o.rent !== null && o.rent < 1000) o.rent = Math.round(o.rent * 10000); // 「14.5」万円の書き方を円に直す
  if (o.fee !== null && o.fee < 100) o.fee = Math.round(o.fee * 10000);
  return o;
}

const norm = (s) => String(s || '').replace(/[\s　]/g, '').toLowerCase();
const keyOf = (l) => (l.url ? 'u:' + l.url.split('?')[0] : 'b:' + norm(l.title) + '|' + norm(l.room) + '|' + l.rent);

const file = process.argv[2];
if (!file) { console.error('使い方: node tools/add-listings.cjs new.json'); process.exit(1); }
const incoming = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(incoming)) { console.error('JSON は配列にしてください'); process.exit(1); }

const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
const byKey = new Map(list.map((l) => [keyOf(l), l]));
const today = new Date().toISOString().slice(0, 10);
const added = [];

for (const raw of incoming) {
  const l = clean(raw);
  if (!l.title && !l.address) continue;
  const k = keyOf(l);
  const old = byKey.get(k);
  if (old) {
    for (const f of FIELDS) if (l[f] !== null) old[f] = l[f];
    old.lastSeen = today;
  } else {
    l.id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    l.firstSeen = today; l.lastSeen = today;
    list.push(l); byKey.set(k, l); added.push(l);
  }
}

list.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '') || (b.firstSeen || '').localeCompare(a.firstSeen || ''));
fs.writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n');

const good = added.map((l) => ({ l, s: Score.score(l, criteria) })).filter((x) => x.s.tier !== 'out')
  .sort((a, b) => Score.TIER_ORDER[a.s.tier] - Score.TIER_ORDER[b.s.tier] || b.s.points - a.s.points);
console.log(`読み込み ${incoming.length}件 / 新しい物件 ${added.length}件 / うち候補 ${good.length}件 / 合計 ${list.length}件`);
for (const { l, s } of good) {
  const rent = Score.totalRent(l);
  console.log(`- [${Score.TIER_LABEL[s.tier]} ${s.points}点] ${l.title || l.address} ${l.room || ''} ` +
    `${rent ? (rent / 10000).toFixed(1) + '万円' : '家賃?'} ${l.layout || ''} ${l.areaM2 || '?'}㎡ ` +
    `${l.station || ''}徒歩${l.walkMin ?? '?'}分${s.watch ? '（気になる建物）' : ''} ${l.url || ''}`);
}
