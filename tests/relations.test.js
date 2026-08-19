'use strict';
const { grabFunction, grabConst, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('relations');
  const code = [grabConst('INVERSE_REL'), '  const linkSourceCache = new Map();', grabFunction('handleSaveMediaRelation'), grabFunction('dropReciprocalRelation'), grabFunction('fetchRelationStub'), grabFunction('handleSaveMediaExternalLink'), grabFunction('enrichLinkSource')].join('\n');
  const db = { seq: 300, entries: {} };
  const fetches = [];
  const fns = evalBlock(code, {
    db, ID_BASE: 2000000000, TAG: '[t]', isCustomId, recById: (id) => db.entries[id] || null, allRecs: () => Object.values(db.entries),
    touchRec() {}, saveDB() {}, pushRecEntities() {}, logRevision() {}, mediaStubFromStore: (id) => (id === 44439 ? { id, title: { userPreferred: 'S' } } : null),
    nativeFetch: { call: (w, u, init) => { fetches.push(JSON.parse(init.body)); return new Promise(() => {}); } }, console: { log() {} }, window: {},
  }, ['handleSaveMediaRelation', 'handleSaveMediaExternalLink', 'dropReciprocalRelation']);
  const rec = { id: 2000000014, type: 'MANGA', media: {}, relations: [] };
  const other = { id: 2000000020, type: 'MANGA', media: {}, relations: [] };
  db.entries[rec.id] = rec; db.entries[other.id] = other;
  fns.handleSaveMediaRelation({ mediaId: 2000000014, relationId: 44439, relationType: 'SIDE_STORY' }, rec);
  fns.handleSaveMediaRelation({ mediaId: 2000000014, relationId: 44439, relationType: 'SEQUEL' }, rec);
  expect('real target: stub from store, type edit updates in place', rec.relations.map((e) => [e.type, e.target, !!e.media]), [['SEQUEL', 44439, true]]);
  fns.handleSaveMediaRelation({ mediaId: 2000000014, relationId: 30002, relationType: 'OTHER' }, rec);
  expect('unknown real target fetches a stub', [fetches.length, fetches[0].variables.id], [1, 30002]);
  fns.handleSaveMediaRelation({ mediaId: 2000000014, relationId: 2000000020, relationType: 'PREQUEL' }, rec);
  expect('custom target gets the reciprocal edge', other.relations.map((e) => [e.type, e.target]), [['SEQUEL', 2000000014]]);
  fns.dropReciprocalRelation(rec, rec.relations.find((e) => e.target === 2000000020));
  expect('reciprocal removed with the edge', other.relations.length, 0);
  fns.handleSaveMediaExternalLink({ mediaId: 2000000014, url: 'https://example.com/x', site: 'Official Site', type: 'INFO', siteId: '2', notes: 'n' }, rec);
  const l = rec.media.externalLinks[0];
  expect('external link stored', [isCustomId(l.id), l.site, l.siteId, l.type, l.notes], [true, 'Official Site', 2, 'INFO', 'n']);
  fns.handleSaveMediaExternalLink({ id: l.id, mediaId: 2000000014, url: 'https://example.com/y', siteId: '2', notes: null }, rec);
  expect('link edited by id', [rec.media.externalLinks.length, l.url, l.notes], [1, 'https://example.com/y', null]);
  return done();
};
