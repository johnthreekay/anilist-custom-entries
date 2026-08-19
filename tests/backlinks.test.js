'use strict';
const { grabBetween, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('backlinks');
  const block = grabBetween('  const viewerRecs = ', 'healBacklinks');
  const db = { entries: {} };
  const fns = evalBlock(block, {
    allRecs: () => Object.values(db.entries), authUserId: () => 5, recIsListed: (r) => !!r.entry.status, mediaEntity: (r) => ({ id: r.id }), isCustomId,
    INVERSE_REL: { SAME_UNIVERSE: 'SAME_UNIVERSE', SEQUEL: 'PREQUEL', PREQUEL: 'SEQUEL' }, vueStore: () => null, entitiesState: () => null, TAG: '[t]',
    console: { log() {} }, location: { pathname: '/manga/188979' },
  }, ['patchMediaBacklinks', 'patchCharacterBacklinks', 'patchStaffBacklinks', 'customRelationsTo']);
  db.entries[1] = { id: 2000000014, ownerId: 5, type: 'MANGA', media: {}, entry: { status: 'CURRENT' }, relations: [{ id: 2000000183, type: 'SAME_UNIVERSE', target: 188979 }], characters: [{ id: 17898, role: 'MAIN' }], staff: [{ id: 2000000182, staffId: 359544, role: 'Story & Art' }] };
  db.entries[2] = { id: 2000000030, ownerId: 9, type: 'MANGA', media: {}, entry: { status: 'CURRENT' }, relations: [{ id: 1, type: 'SEQUEL', target: 188979 }], characters: [{ id: 17898, role: 'MAIN' }], staff: [] };
  let r = { entities: { media: { 188979: { id: 188979, relations: { edges: [{ id: 5, relationType: 'ADAPTATION', node: 33 }] } } } } };
  fns.patchMediaBacklinks(r, { id: 188979, backs: fns.customRelationsTo(188979) });
  fns.patchMediaBacklinks(r, { id: 188979, backs: fns.customRelationsTo(188979) });
  expect('media backlink (viewer only, inverse type, idempotent)', r.entities.media[188979].relations.edges.map((e) => [e.relationType, e.node]), [['ADAPTATION', 33], ['SAME_UNIVERSE', 2000000014]]);
  const ck = 'characterMediaRoles-{"id":"17898"}';
  r = { entities: { page: { [ck]: { pageInfo: { total: 4 }, pageData: [{ id: 1, characterRole: 'SUPPORTING', voiceActorRoles: [], node: 39429 }] } } } };
  fns.patchCharacterBacklinks(r, { id: 17898, pageId: ck, vars: { page: 1 } });
  expect('character appearance prepended', [r.entities.page[ck].pageData.map((e) => e.node), r.entities.page[ck].pageInfo.total], [[2000000014, 39429], 5]);
  const sk = 'staffMediaRoles-{"id":"359544","type":"MANGA"}';
  r = { entities: { page: { [sk]: { pageInfo: { total: 1 }, pageData: [{ staffRole: 'Story & Art', node: 188979 }] } } } };
  fns.patchStaffBacklinks(r, { id: 359544, pageId: sk, vars: { staffPage: 1, type: 'MANGA' } });
  expect('staff role prepended', r.entities.page[sk].pageData.map((e) => e.node), [2000000014, 188979]);
  return done();
};
