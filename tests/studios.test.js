'use strict';
const { grabBetween, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('studios');
  const block = grabBetween('  /* --- studios --- */', 'patchStudioBacklinks');
  const db = { seq: 400, entries: {} };
  const fetches = [];
  const fns = evalBlock(block, {
    db, ID_BASE: 2000000000, TAG: '[t]', isCustomId, allRecs: () => Object.values(db.entries), recById: (id) => db.entries[id] || null,
    viewerRecs: () => Object.values(db.entries), touchRec() {}, saveDB() {}, pushRecEntities() {}, logRevision() {}, mediaEntity: (r) => ({ id: r.id }),
    passesOnList: () => true, vueStore: () => null, entitiesState: () => null, console: { log() {} }, window: {},
    nativeFetch: { call: (w, u, init) => { fetches.push(JSON.parse(init.body)); return new Promise(() => {}); } },
  }, ['studioIdFor', 'studiosOf', 'handleSaveMediaStudio', 'removeStudioLink', 'studioPageResult', 'patchStudioBacklinks']);
  const rec = { id: 2000000001, ownerId: 5, type: 'ANIME', media: { studioName: 'Manpuku Jinja', studios: [] }, entry: {} };
  db.entries[rec.id] = rec;
  const sid = fns.studioIdFor('Manpuku Jinja');
  expect('stable custom studio id', [isCustomId(sid), sid === fns.studioIdFor('manpuku jinja ')], [true, true]);
  expect('local studio edge first, main', fns.studiosOf(rec).map((s) => [s.studioId === sid, s.name, s.isMain, !!s.isCustom]), [[true, 'Manpuku Jinja', true, true]]);
  fns.handleSaveMediaStudio({ mediaId: 2000000001, studioId: 2, isMain: false }, rec);
  expect('real studio linked (name fetched)', [rec.media.studios.length, rec.media.studios[0].studioId, fetches.length], [1, 2, 1]);
  fns.handleSaveMediaStudio({ id: rec.media.studios[0].id, mediaId: 2000000001, studioId: 2, isMain: true }, rec);
  fns.handleSaveMediaStudio({ mediaId: 2000000001, studioId: sid, isMain: false }, rec);
  expect('main flags editable, local via its id', [rec.media.studios[0].isMain, rec.media.studioMain], [true, false]);
  const pg = fns.studioPageResult(sid, { page: 1 }, { page: { id: 'studioMedia-{"id":"x"}' } });
  expect('local studio page', [pg.entities.studio[sid].name, pg.entities.page['studioMedia-{"id":"x"}'].pageData], ['Manpuku Jinja', [{ isMainStudio: false, node: 2000000001 }]]);
  const r = { entities: { page: { k: { pageInfo: { total: 500 }, pageData: [{ isMainStudio: true, node: 204738 }] } } } };
  fns.patchStudioBacklinks(r, { id: 2, pageId: 'k', vars: { page: 1 } });
  expect('real studio backlink', [r.entities.page.k.pageData.map((e) => e.node), r.entities.page.k.pageInfo.total], [[2000000001, 204738], 501]);
  fns.removeStudioLink(rec, rec.media.studios[0].id);
  fns.removeStudioLink(rec, rec.id);
  expect('removals', [rec.media.studios.length, rec.media.studioName], [0, null]);
  // mediaEntity always serves media.studios as {edges} (the media page's
  // sidebar reads .edges.map and drops its whole data block otherwise).
  const { grabFunction } = require('./lib');
  const me = evalBlock(grabFunction('mediaEntity'), {
    enrichRecTags() {}, recIsListed: () => true, sanitizeHtml: (x) => x, nextAiringOf: () => null, studiosOf: fns.studiosOf,
  }, ['mediaEntity']);
  const plain = { id: 2000000014, type: 'MANGA', media: { studios: [], title: { userPreferred: 'X' } }, entry: {} };
  const withStudio = { id: 2000000015, type: 'ANIME', media: { studioName: 'Manpuku Jinja', studios: [] }, entry: {} };
  expect('mediaEntity studios shape', [me.mediaEntity(plain).studios, me.mediaEntity(withStudio).studios.edges.map((e) => [e.isMain, e.node === sid])], [{ edges: [] }, [[true, true]]]);
  return done();
};
