'use strict';
const { grabFunction, evalBlock, makeExpect } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('activity');
  const code = ['recordListActivity', 'applyStatusEffects', 'handleSave', 'createRec'].map(grabFunction).join('\n');
  const db = { seq: 0, entries: {}, activities: {} };
  const recById = (id) => Object.values(db.entries).find((r) => r.id === parseInt(id, 10) || r.entry.id === parseInt(id, 10)) || null;
  const allActivities = () => Object.values(db.activities).sort((x, y) => y.createdAt - x.createdAt || y.id - x.id);
  const fns = evalBlock(code, {
    db, ID_BASE: 2000000000, TAG: '[t]', console: { log() {}, warn() {} }, saveDB() {}, pushActivityLive() {},
    syncSections() {}, syncHomePreview() {}, ownerOpts: () => null, entryEntity: (r) => r.entry, mediaEntity: (r) => r.media,
    userEntity: (id) => ({ id }), recById, allActivities, ACTIVITY_MERGE_WINDOW: 3 * 3600, setTimeout: (fn) => fn(),
    logRevision() {}, revisionValue: (v) => String(v),
  }, ['recordListActivity', 'applyStatusEffects', 'handleSave', 'createRec']);
  const acts = (rec) => allActivities().filter((a) => a.mediaId === rec.id).map((a) => a.status + (a.progress ? ' ' + a.progress : ''));

  let r = fns.createRec({ ownerId: 1, type: 'MANGA', title: 'T', format: 'ONE_SHOT', mediaStatus: 'FINISHED', status: 'COMPLETED', chapters: 1, volumes: null, cover: 'c', banner: null });
  expect('create as Completed fills progress + dates', [r.entry.progress, !!(r.entry.completedAt.year && r.entry.startedAt.year)], [1, true]);
  expect('create as Completed → one activity', acts(r), ['completed']);
  fns.handleSave({ id: r.entry.id, status: 'COMPLETED', progress: 1, score: 8 });
  fns.handleSave({ id: r.entry.id, progress: 5 });
  expect('editor re-save / progress edit on Completed add nothing', acts(r), ['completed']);

  r = fns.createRec({ ownerId: 1, type: 'MANGA', title: 'T3', format: 'MANGA', mediaStatus: 'FINISHED', status: 'CURRENT', chapters: 10, volumes: null, cover: 'c', banner: null });
  expect('create as Reading → no activity, start date set', [acts(r), !!r.entry.startedAt.year], [[], true]);
  fns.handleSave({ id: r.entry.id, progress: 1 });
  fns.handleSave({ id: r.entry.id, progress: 2 });
  expect('progress merges into a range', acts(r), ['read chapter 1 - 2']);
  fns.handleSave({ id: r.entry.id, status: 'COMPLETED' });
  expect('Reading → Completed posts completed and fills progress', [acts(r), r.entry.progress], [['completed', 'read chapter 1 - 2'], 10]);

  r = fns.createRec({ ownerId: 1, type: 'MANGA', title: 'T4', format: 'MANGA', mediaStatus: 'FINISHED', status: null, chapters: 3, volumes: null, cover: 'c', banner: null });
  fns.handleSave({ mediaId: r.id, status: 'PLANNING' });
  expect('media-only record added as Planning', [r.entry.progress, acts(r)], [0, ['plans to read']]);
  return done();
};
