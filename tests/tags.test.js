'use strict';
const { grabFunction, grabConst, evalBlock, makeExpect } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('tags');
  // Synthetic AniList catalog slice: enough vocabulary to exercise every
  // branch (exact hit, squashed hit, alias target present/absent).
  const CATALOG = ['Iyashikei', 'Yuri', 'Gender Bending', '4-koma', 'Shounen', 'Female Protagonist', 'Time Travel'];
  const byLower = new Map(CATALOG.map((n) => [n.toLowerCase(), { name: n }]));
  const squash = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const bySquash = new Map(CATALOG.map((n) => [squash(n), { name: n }]));
  const fns = evalBlock([
    grabConst('AL_GENRES'), grabConst('GENRE_CANON'), grabConst('titleCase'), grabConst('tagCase'),
    grabConst('tagKey'), grabConst('TAG_ALIAS'), grabFunction('canonTag'), grabFunction('splitGenresTags'),
  ].join('\n'), {
    catalogTagLoose: (n) => (n ? byLower.get(String(n).toLowerCase()) || bySquash.get(squash(n)) || null : null),
  }, ['canonTag', 'splitGenresTags']);

  expect('canonTag: exact and squashed catalog matches take canonical casing',
    [fns.canonTag('iyashikei'), fns.canonTag('female  protagonist'), fns.canonTag('4 Koma')],
    ['Iyashikei', 'Female Protagonist', '4-koma']);
  expect('canonTag: aliases map provider vocab (target present in catalog)',
    [fns.canonTag('Shoujo Ai'), fns.canonTag('GL'), fns.canonTag('Gender Bender'), fns.canonTag('yonkoma'), fns.canonTag('Time-Travel')],
    ['Yuri', 'Yuri', 'Gender Bending', '4-koma', 'Time Travel']);
  expect('canonTag: alias whose target is missing from the catalog is a no-op',
    [fns.canonTag('Yaoi'), fns.canonTag('shounen ai')], ['Yaoi', 'Shounen Ai']);
  expect('canonTag: unmatched names preserved verbatim, never dropped',
    [fns.canonTag('Aaaaaaangst'), fns.canonTag('reimu x marisa:70'), fns.canonTag('Iyashikei:88')],
    ['Aaaaaaangst', 'Reimu x Marisa:70', 'Iyashikei:88']);
  expect('splitGenresTags: genres split out, aliases can land in genres',
    fns.splitGenresTags(['Slice-of-Life', 'Suspense', 'Shoujo Ai', 'Shounen', 'Aaaaaaangst', 'slice of life']),
    { genres: ['Slice of Life', 'Thriller'], tags: ['Yuri', 'Shounen', 'Aaaaaaangst'] });
  expect('splitGenresTags: dedup after canonicalization',
    fns.splitGenresTags(['Girls Love', 'Yuri', 'shoujo-ai']), { genres: [], tags: ['Yuri'] });
  return done();
};
