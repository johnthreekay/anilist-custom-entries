'use strict';
const { grabBetween, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('reviews');
  const block = grabBetween('  /* --- local reviews: rec.reviews', 'patchUserReviews');
  const db = { seq: 500, entries: {} };
  const fns = evalBlock(block, {
    db, ID_BASE: 2000000000, TAG: '[t]', isCustomId, allRecs: () => Object.values(db.entries), recById: (id) => db.entries[id] || null, authUserId: () => 5,
    nowSec: () => 1000, touchRec() {}, saveDB() {}, pushRecEntities() {}, mediaEntity: (r) => ({ id: r.id }), activityUserEntity: (id) => ({ id, name: 'u' + id }),
    console: { log() {} }, location: { origin: 'https://anilist.co' },
  }, ['handleSaveReview', 'handleRateReview', 'handleDeleteReview', 'findReview', 'reviewResult', 'patchUserReviews']);
  const rec = { id: 2000000014, ownerId: 5, reviews: [] };
  db.entries[rec.id] = rec;
  const r1 = fns.handleSaveReview({ mediaId: 2000000014, summary: 'Great', body: 'Long text', score: 85, private: false });
  const rid = r1.result;
  expect('review created', [isCustomId(rid), rec.reviews.length, r1.entities.review[rid].summary, r1.entities.review[rid].score, r1.entities.review[rid].user, r1.entities.review[rid].media], [true, 1, 'Great', 85, 5, 2000000014]);
  fns.handleSaveReview({ id: rid, mediaId: 2000000014, summary: 'Better' });
  expect('second save edits in place (one review per user)', [rec.reviews.length, rec.reviews[0].summary, rec.reviews[0].body], [1, 'Better', 'Long text']);
  fns.handleRateReview({ id: rid, rating: 'UP_VOTE' });
  expect('rate up', [rec.reviews[0].rating, rec.reviews[0].ratingAmount, rec.reviews[0].userRating], [1, 1, 'UP_VOTE']);
  fns.handleRateReview({ id: rid, rating: 'DOWN_VOTE' });
  expect('switch to down', [rec.reviews[0].rating, rec.reviews[0].ratingAmount], [0, 1]);
  fns.handleRateReview({ id: rid, rating: 'NO_VOTE' });
  expect('unvote', [rec.reviews[0].rating, rec.reviews[0].ratingAmount], [0, 0]);
  const res = { entities: { page: { 'userReviews-5': { pageInfo: { total: 2 }, pageData: [11] } } } };
  fns.patchUserReviews(res, { pageId: 'userReviews-5', userId: '5', vars: { page: 1 } });
  expect('profile reviews prepended', [res.entities.page['userReviews-5'].pageData, res.entities.page['userReviews-5'].pageInfo.total, !!res.entities.review[rid]], [[rid, 11], 3, true]);
  fns.handleDeleteReview({ id: rid });
  expect('deleted', rec.reviews.length, 0);
  return done();
};
