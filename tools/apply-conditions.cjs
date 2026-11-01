#!/usr/bin/env node
/* 「物件の条件えらび」ページで保存した条件（JSON）を picks/criteria.json に書き込む。
 * 使い方: node tools/apply-conditions.cjs conditions.json
 * ページの保存内容は Claude が ArtifactData で読み出して、ファイルにしてから渡す。 */
'use strict';
const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, '..', 'picks', 'criteria.json');
const cur = JSON.parse(fs.readFileSync(target, 'utf8'));
const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const d = src.data || src; // ArtifactData の返り値でも中身だけでもよい

const KEYS = ['stations', 'rentMax', 'rentSlack', 'walkMax', 'walkSlack', 'climbMax', 'areaMin', 'areaSlack', 'layouts', 'builtWithin', 'floorMin', 'memo'];
const next = { ...cur };
for (const k of KEYS) if (k in d) next[k] = d[k];
if (d.features) next.features = { ...cur.features, ...d.features };
if (Array.isArray(d.watch)) next.watchBuildings = cur.watchBuildings.map((w) => ({ ...w, on: d.watch.includes(w.name) }));
next.conditionsUpdatedAt = d.updatedAt || null;

const before = JSON.stringify(cur);
fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
console.log(JSON.stringify(next) === before ? '条件に変更はありません' : '条件を更新しました');
