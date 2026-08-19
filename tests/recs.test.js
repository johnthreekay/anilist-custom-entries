'use strict';
const { grabFunction, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('recs');
  const code = [grabFunction('recRecEntity'), grabFunction('recBacklinkEntity'), grabFunction('recTargetMediaEntity'), grabFunction('recPageEntity'), grabFunction('handleSaveRecommendation'), grabFunction('handleDeleteRecommendation')].join('\n');
  const db = { seq: 300, entries: {} };
  const fns = evalBlock(code, {
    db, ID_BASE: 2000000000, TAG: '[t]', isCustomId, recById: (id) => db.entries[id] || null, allRecs: () => Object.values(db.entries),
    touchRec() {}, saveDB() {}, authUserId: () => 5, userEntity: (id) => ({ id }), mediaEntity: (r) => ({ id: r.id }),
    mediaStubFromStore: (id) => ({ id, title: { userPreferred: '#' + id } }), console: { log() {} },
  }, ['handleSaveRecommendation', 'handleDeleteRecommendation']);
  const a = { id: 2000000014, type: 'MANGA', media: {}, recs: [] };
  const b = { id: 2000000020, type: 'MANGA', media: {}, recs: [] };
  db.entries[a.id] = a; db.entries[b.id] = b;
  // From the custom entry's own page: stored on it, page entity returned.
  let r = fns.handleSaveRecommendation({ mediaId: 2000000014, mediaRecommendationId: 30013, rating: 'RATE_UP' });
  expect('own page: stored with stub, page entity (update only)', [a.recs.length, a.recs[0].target, !!a.recs[0].media, Object.keys(r.entities.page), fns.handleSaveRecommendation({ mediaId: 2000000014, mediaRecommendationId: 30013, rating: 'RATE_UP', new: true }).entities.page], [1, 30013, true, ['mediaRecommendations-2000000014'], undefined]);
  // Rated from the real page (backlink card): same pair updated, no page entity, card points back.
  r = fns.handleSaveRecommendation({ mediaId: 30013, mediaRecommendationId: 2000000014, rating: 'RATE_DOWN' });
  expect('flipped from real page: pair updated in place', [a.recs.length, a.recs[0].userRating, a.recs[0].rating, r.entities.recommendation[a.recs[0].id].mediaRecommendation, r.entities.page], [1, 'RATE_DOWN', -1, 2000000014, undefined]);
  // New rec made from a real page towards a custom entry: stored on the custom entry.
  r = fns.handleSaveRecommendation({ mediaId: 30002, mediaRecommendationId: 2000000020, rating: 'RATE_UP' });
  expect('real page → custom: stored on the custom entry', [b.recs.length, b.recs[0].target, r.result === b.recs[0].id], [1, 30002, true]);
  // Custom↔custom: made from A, rated from B updates A's record (no duplicate pair).
  fns.handleSaveRecommendation({ mediaId: 2000000014, mediaRecommendationId: 2000000020, rating: 'RATE_UP' });
  fns.handleSaveRecommendation({ mediaId: 2000000020, mediaRecommendationId: 2000000014, rating: 'RATE_DOWN' });
  expect('custom pair stored once, rated from either side', [a.recs.filter((x) => x.target === b.id).map((x) => x.userRating), b.recs.filter((x) => x.target === a.id).length], [['RATE_DOWN'], 0]);
  // Delete by id from whichever record holds it.
  const rid = a.recs[0].id;
  r = fns.handleDeleteRecommendation({ id: rid });
  expect('delete removes it', [a.recs.some((x) => x.id === rid), r], [false, { DeleteRecommendation: { deleted: true } }]);
  return done();
};
