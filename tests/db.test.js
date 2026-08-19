'use strict';
const { grabFunction, evalBlock, makeExpect } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('db');
  const code = ['  const DB_VERSION = 7;', grabFunction('migrateDB'), grabFunction('mergeReport')].join('\n');
  const fns = evalBlock(code, { TAG: '[t]', console: { log() {} }, nowSec: () => 1000 }, ['migrateDB', 'mergeReport']);
  const d = fns.migrateDB({ entries: { 2000000001: { id: 2000000001, media: { title: 'plain string' }, entry: {} } } });
  expect('migrate fills fields + version', [d.version, d.seq, Object.keys(d.deleted).length, d.entries[2000000001].staff, d.entries[2000000001].media.externalLinks, d.entries[2000000001].media.title.userPreferred], [7, 0, 0, [], [], 'plain string']);
  const before = { entries: { 1: { id: 1, media: { title: { userPreferred: 'A' } } }, 2: { id: 2, media: { title: { userPreferred: 'B' } } } }, activities: { 9: {} } };
  const after = { entries: { 1: before.entries[1], 2: { id: 2, media: { title: { userPreferred: 'B2' } } }, 3: { id: 3, media: { title: { userPreferred: 'C' } } } }, activities: { 9: before.activities[9], 10: {} } };
  const rep = fns.mergeReport(before, after);
  expect('merge report', [rep.items.map((i) => [i.kind, i.title]), rep.activities], [[['updated', 'B2'], ['new', 'C']], 1]);
  // saveDB coalescing: many calls in one task → one localStorage write, one
  // dirty flip; noSync saves don't touch the sync flag.
  const { grabBetween } = require('./lib');
  const writes = [];
  const micro = [];
  const syncCfg = { dirty: false };
  let cfgSaves = 0;
  let syncs = 0;
  const sv = evalBlock(grabBetween('  let dbFlushQueued = false;', 'saveDB'), {
    localStorage: { setItem: (k, v) => writes.push([k, v.length]) }, LS_KEY: 'k', packDB: (x) => x, db: { a: 1 }, TAG: '[t]', console: { warn() {} },
    document: { body: null }, toast() {}, syncCfg, saveSyncCfg: () => { cfgSaves++; }, scheduleSync: () => { syncs++; },
    queueMicrotask: (fn) => micro.push(fn), window: { addEventListener() {} },
  }, ['saveDB', 'flushDB']);
  sv.saveDB(); sv.saveDB({ noSync: true }); sv.saveDB();
  const beforeFlush = writes.length;
  while (micro.length) micro.shift()();
  expect('saveDB coalesces into one write per task', [beforeFlush, writes.length, micro.length, syncCfg.dirty, cfgSaves, syncs], [0, 1, 0, true, 1, 2]);
  sv.saveDB();
  while (micro.length) micro.shift()();
  expect('next task writes again', writes.length, 2);
  return done();
};
