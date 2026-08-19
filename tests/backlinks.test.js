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
    recBacklinkEntity: (rec, rr) => ({ id: rr.id, rating: rr.rating || 0, userRating: rr.userRating || 'RATE_UP', mediaRecommendation: rec.id, user: 5 }),
  }, ['patchMediaBacklinks', 'patchCharacterBacklinks', 'patchStaffBacklinks', 'customRelationsTo', 'customRecsTo', 'addRecBacklinks']);
  db.entries[1] = { id: 2000000014, ownerId: 5, type: 'MANGA', media: {}, entry: { status: 'CURRENT' }, relations: [{ id: 2000000183, type: 'SAME_UNIVERSE', target: 188979 }], characters: [{ id: 17898, role: 'MAIN' }], staff: [{ id: 2000000182, staffId: 359544, role: 'Story & Art' }], recs: [{ id: 2000000190, target: 188979, rating: 1, userRating: 'RATE_UP' }, { id: 2000000191, target: 30013, rating: 1, userRating: 'RATE_UP' }] };
  db.entries[2] = { id: 2000000030, ownerId: 9, type: 'MANGA', media: {}, entry: { status: 'CURRENT' }, relations: [{ id: 1, type: 'SEQUEL', target: 188979 }], characters: [{ id: 17898, role: 'MAIN' }], staff: [], recs: [{ id: 2000000192, target: 188979 }] };
  let r = { entities: { media: { 188979: { id: 188979, relations: { edges: [{ id: 5, relationType: 'ADAPTATION', node: 33 }] } } } } };
  fns.patchMediaBacklinks(r, { id: 188979, backs: fns.customRelationsTo(188979) });
  fns.patchMediaBacklinks(r, { id: 188979, backs: fns.customRelationsTo(188979) });
  expect('media backlink (viewer only, inverse type, idempotent)', r.entities.media[188979].relations.edges.map((e) => [e.relationType, e.node]), [['ADAPTATION', 33], ['SAME_UNIVERSE', 2000000014]]);
  // Recommendation backlink: the overview response carries the rec strip page.
  r = { entities: { media: { 188979: { id: 188979, relations: { edges: [] } } }, page: { 'mediaRecommendations-188979': { pageInfo: { total: 2 }, pageData: [3442, 3443] } }, recommendation: { 3442: { id: 3442, mediaRecommendation: 30026 }, 3443: { id: 3443, mediaRecommendation: 30013 } } } };
  fns.patchMediaBacklinks(r, { id: 188979, backs: [], recBacks: fns.customRecsTo(188979), page: 1 });
  fns.patchMediaBacklinks(r, { id: 188979, backs: [], recBacks: fns.customRecsTo(188979), page: 1 });
  const rp = r.entities.page['mediaRecommendations-188979'];
  expect('rec backlink prepended (viewer only, idempotent)', [rp.pageData, rp.pageInfo.total, r.entities.recommendation[2000000190].mediaRecommendation, !!r.entities.media[2000000014]], [[2000000190, 3442, 3443], 3, 2000000014, true]);
  r = { entities: { media: { 188979: { id: 188979 } }, page: { 'mediaRecommendations-188979': { pageInfo: { total: 2 }, pageData: [7] } }, recommendation: {} } };
  fns.patchMediaBacklinks(r, { id: 188979, backs: [], recBacks: fns.customRecsTo(188979), page: 2 });
  expect('rec backlink skipped on page 2', r.entities.page['mediaRecommendations-188979'].pageData, [7]);
  // Store form (heal): pair already present under another id is not duplicated.
  const arr = [900];
  const n = fns.addRecBacklinks(arr, {}, { total: 1 }, fns.customRecsTo(188979), { 900: { id: 900, mediaRecommendation: 2000000014 } });
  expect('rec backlink dedup by pair', [n, arr], [0, [900]]);
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
