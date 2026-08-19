'use strict';
const { grabBetween, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('search');
  const block = grabBetween('  const normText = ', 'patchQuickSearch');
  const db = { entries: {} };
  let bump = false;
  const fns = evalBlock(block, {
    allRecs: () => Object.values(db.entries), authUserId: () => 5, recIsListed: (r) => !!r.entry.status, mediaEntity: (r) => Object.assign({ id: r.id }, r.media),
    entryEntity: (r) => ({ id: r.entry.id }), charPartsOf: (c) => ({ userPreferred: c.name, full: c.name }), DEFAULT_CHAR_IMG: 'img', TAG: '[t]',
    console: { log() {} }, vueStore: () => null, entitiesState: () => null, isCustomId, searchBumpEnabled: () => bump,
  }, ['customSearchHits', 'patchSearchResult', 'patchQuickSearch']);
  db.entries[1] = { id: 2000000014, ownerId: 5, type: 'MANGA', media: { title: { userPreferred: "Tonight at the Mystia's Yatai" }, synonyms: ['Konya wa Yosuzume'], genres: ['Fantasy', 'Gourmet'], tags: [{ name: 'Youkai' }], format: 'MANGA', startDate: { year: 2026 }, isAdult: false }, entry: { id: 2000000014, status: 'CURRENT' }, characters: [{ id: 2000000050, name: 'Lorelei Mystia' }] };
  db.entries[2] = { id: 2000000020, ownerId: 5, type: 'MANGA', media: { title: { userPreferred: 'Adult thing' }, genres: ['Hentai'], tags: [], isAdult: true }, entry: { id: 2000000020, status: null } };
  db.entries[3] = { id: 2000000030, ownerId: 9, type: 'MANGA', media: { title: { userPreferred: 'Mystia other user' }, genres: [], tags: [] }, entry: { id: 2000000030, status: 'CURRENT' } };
  const ids = (v, t) => fns.customSearchHits(v, t).map((r) => r.id);
  expect('text / synonym / tag / genre-as-tag', [ids({ search: 'mystia' }, 'MANGA'), ids({ search: 'yosuzume' }, 'MANGA'), ids({ tags: ['Youkai'] }, 'MANGA'), ids({ genres: ['Youkai'] }, 'MANGA')], [[2000000014], [2000000014], [2000000014], [2000000014]]);
  expect('genre AND, adult filter, no-filter browse', [ids({ genres: ['Fantasy', 'Action'] }, 'MANGA'), ids({ genres: ['Hentai'], isAdult: false }, 'MANGA'), ids({ page: 1, sort: 'POPULARITY_DESC' }, 'MANGA')], [[], [], []]);
  const key = 'MANGA-{"genres":["Youkai"]}';
  const mk = (arr, meds, hasNext) => ({ entities: { page: { [key]: { pageInfo: { total: 100, hasNextPage: hasNext }, pageData: arr.slice() } }, media: meds } });
  const meds = { 1: { id: 1, title: { userPreferred: 'Alpha' }, startDate: { year: 2030 } }, 2: { id: 2, title: { userPreferred: 'Middle' }, startDate: { year: 2025 } }, 3: { id: 3, title: { userPreferred: 'Zeta' }, startDate: { year: 2010 } } };
  let r = mk([1, 2, 3], meds, true); fns.patchSearchResult(r, { pageId: key, vars: { page: 1, tags: ['Youkai'], sort: 'TITLE_ROMAJI' } });
  expect('title sort interleaves', r.entities.page[key].pageData, [1, 2, 2000000014, 3]);
  r = mk([1, 2, 3], meds, true); fns.patchSearchResult(r, { pageId: key, vars: { page: 1, tags: ['Youkai'], sort: 'POPULARITY_DESC' } });
  expect('popularity desc: not on page 1', r.entities.page[key].pageData, [1, 2, 3]);
  r = mk([1, 2, 3], meds, false); fns.patchSearchResult(r, { pageId: key, vars: { page: 4, tags: ['Youkai'], sort: 'POPULARITY_DESC' } });
  expect('popularity desc: end of last page', r.entities.page[key].pageData, [1, 2, 3, 2000000014]);
  bump = true;
  r = mk([1, 2, 3], meds, true); fns.patchSearchResult(r, { pageId: key, vars: { page: 1, tags: ['Youkai'], sort: 'POPULARITY_DESC' } });
  expect('bump toggle pins on top', r.entities.page[key].pageData, [2000000014, 1, 2, 3]);
  bump = false;
  const qs = { entities: { page: { quickSearch: { anime: { pageInfo: { total: 0 }, results: [] }, manga: { pageInfo: { total: 1 }, results: [77] }, characters: { pageInfo: { total: 0 }, results: [] } } } } };
  fns.patchQuickSearch(qs, { vars: { search: 'Mystia' } });
  expect('quick search: media + local character', [qs.entities.page.quickSearch.manga.results, qs.entities.page.quickSearch.characters.results], [[2000000014, 77], [2000000050]]);
  return done();
};
