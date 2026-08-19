'use strict';
const { grabBetween, evalBlock, makeExpect } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('stats');
  const block = grabBetween('  const STAT_BUCKETS = {', 'patchUsersStats');
  const db = { entries: {}, activities: {} };
  const fns = evalBlock(block, {
    allRecs: () => Object.values(db.entries), allActivities: () => Object.values(db.activities), statsBumpEnabled: () => true,
    vueStore: () => null, entitiesState: () => null, TAG: '[t]', console: { log() {}, warn() {} },
  }, ['patchUsersStats', 'patchActivityHistory', 'activityLevel']);
  db.entries[1] = { id: 2000000001, ownerId: 5, type: 'MANGA', media: { format: 'MANGA', genres: ['Fantasy', 'Gourmet'], tags: [{ name: 'Youkai' }], startDate: { year: 2026 }, countryOfOrigin: 'JP' }, entry: { status: 'CURRENT', progress: 100, progressVolumes: 3, startedAt: { year: 2026 } } };
  db.entries[2] = { id: 2000000002, ownerId: 5, type: 'ANIME', media: { format: 'TV', duration: 24, genres: [] }, entry: { status: 'COMPLETED', progress: 12 } };
  db.entries[3] = { id: 2000000003, ownerId: 5, type: 'MANGA', media: {}, entry: { status: null, progress: 50 } };
  db.entries[4] = { id: 2000000004, ownerId: 9, type: 'MANGA', media: {}, entry: { status: 'CURRENT', progress: 500 } };
  db.activities[1] = { ownerId: 5, createdAt: 1785193200 + 50 };
  db.activities[2] = { ownerId: 5, createdAt: 1785193200 - 30 * 86400 };
  const deepMerge = (dst, src) => { for (const [k, v] of Object.entries(src)) { if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v); else dst[k] = v; } return dst; };
  const users = { 5: { id: 5, statistics: {
    anime: { count: 319, minutesWatched: 100, episodesWatched: 4275, genrePreview: [{ genre: 'Action', count: 149 }] },
    manga: { count: 147, chaptersRead: 10990, volumesRead: 281, formats: [{ format: 'MANGA', count: 134, chaptersRead: 10324, mediaIds: [1] }], genres: [{ genre: 'Fantasy', count: 63, chaptersRead: 100, mediaIds: [] }], tags: [{ tag: { id: 1, name: 'youkai' }, count: 2, chaptersRead: 5, mediaIds: [] }], genrePreview: [{ genre: 'Fantasy', count: 63 }] } },
    stats: { activityHistory: [{ date: 1785193200, amount: 11, level: 7 }] } } };
  fns.patchUsersStats(users); fns.patchUsersStats(users);
  const m = users[5].statistics.manga; const a = users[5].statistics.anime;
  expect('totals (idempotent, listed viewer entries only)', [m.count, m.chaptersRead, m.volumesRead, a.count, a.episodesWatched, a.minutesWatched], [148, 11090, 284, 320, 4287, 100 + 12 * 24]);
  expect('buckets: existing + new, mediaIds carry the entry', [m.formats.map((b) => [b.format, b.count, b.mediaIds.length]), m.genres.map((b) => [b.genre, b.count]), m.tags[0].count], [[['MANGA', 135, 2]], [['Fantasy', 64], ['Gourmet', 1]], 3]);
  expect('activity history: existing day bumped, old day added, levels', users[5].stats.activityHistory.map((d) => [d.date - 1785193200, d.amount, d.level]), [[-30 * 86400, 1, 1], [0, 12, 7]]);
  expect('levels', [1, 3, 4, 7, 13, 40].map(fns.activityLevel), [1, 1, 3, 5, 9, 10]);
  // partial (genres-only) response deep-merged into the store must not double count
  const partial = { 5: { id: 5, statistics: { manga: { genres: [{ genre: 'Fantasy', count: 63, chaptersRead: 100, mediaIds: [1] }] } } } };
  fns.patchUsersStats(partial);
  deepMerge(users, JSON.parse(JSON.stringify(partial)));
  fns.patchUsersStats(users);
  expect('partial merge stays correct', [users[5].statistics.manga.count, users[5].statistics.manga.genres.map((b) => b.count)], [148, [64, 1]]);
  return done();
};
