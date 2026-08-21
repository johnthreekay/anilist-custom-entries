'use strict';
const { grabFunction, grabConst, evalBlock, makeExpect, isCustomId, ID_BASE } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('people');
  const db = { seq: 100 };
  const fns = evalBlock([
    grabConst('nameKey'), grabFunction('pickPersonMatch'), grabConst('staffLinkable'),
    grabFunction('mergeExternal'), grabFunction('importStaff'),
  ].join('\n'), { isCustomId, db, ID_BASE }, ['pickPersonMatch', 'staffLinkable', 'mergeExternal', 'importStaff']);

  const cand = (full, native, alt) => ({ id: 1, name: { full, native: native || null, userPreferred: full, alternative: alt || [] } });
  expect('pickPersonMatch: exact match in either name order', [
    !!fns.pickPersonMatch('Sakura Ito', [cand('Sakura Ito')]),
    !!fns.pickPersonMatch('Ito Sakura', [cand('Sakura Ito')]),
    !!fns.pickPersonMatch('Sakura  ITO', [cand('Sakura Ito')]),
  ], [true, true, true]);
  expect('pickPersonMatch: native and alternative names count', [
    !!fns.pickPersonMatch('伊藤さくら', [cand('Sakura Ito', '伊藤さくら')]),
    !!fns.pickPersonMatch('Saku Itou', [cand('Sakura Ito', null, ['Saku Itou'])]),
  ], [true, true]);
  expect('pickPersonMatch: partial names and ambiguity never link', [
    fns.pickPersonMatch('Sakura', [cand('Sakura Ito')]),
    fns.pickPersonMatch('Sakura Ito Tanaka', [cand('Sakura Ito')]),
    fns.pickPersonMatch('Sakura Ito', [cand('Sakura Ito'), cand('Sakura Ito')]),
    fns.pickPersonMatch('Sakura Ito', []),
  ], [null, null, null, null]);
  expect('staffLinkable: multi-token local only (circles/handles stay put)', [
    fns.staffLinkable({ staffId: ID_BASE + 5, name: { userPreferred: 'Sakura Ito' } }),
    fns.staffLinkable({ staffId: ID_BASE + 5, name: { userPreferred: 'cercis' } }),
    fns.staffLinkable({ staffId: 4321, name: { userPreferred: 'Sakura Ito' } }),
    fns.staffLinkable(null),
  ], [true, false, false, false]);

  expect('mergeExternal: nulls never erase known ids', (() => {
    const rec = { external: { mal: 5, mangabaka: 7 } };
    fns.mergeExternal(rec, { mal: null, mangadex: 'u-1', anilist: undefined });
    return rec.external;
  })(), { mal: 5, mangabaka: 7, mangadex: 'u-1' });

  const rec1 = { staff: [] };
  const n1 = fns.importStaff(rec1, { staffRows: [{ name: 'Aoi Writer', role: 'Story' }, { name: 'Beni Artist', native: '紅', role: 'Art' }] });
  expect('importStaff: provider roles preserved, local ids assigned',
    [n1, rec1.staff.map((s) => [s.name.userPreferred, s.name.native, s.role, isCustomId(s.staffId), s.isCustom])],
    [2, [['Aoi Writer', null, 'Story', true, true], ['Beni Artist', '紅', 'Art', true, true]]]);
  const rec2 = { staff: [] };
  fns.importStaff(rec2, { authors: ['Solo Mangaka'] });
  const rec3 = { staff: [] };
  fns.importStaff(rec3, { authors: ['Writer One', 'Writer Two'] });
  expect('importStaff: solo author gets Story & Art, multi stays roleless',
    [rec2.staff[0].role, rec3.staff.map((s) => s.role)], ['Story & Art', [null, null]]);
  expect('importStaff: never clobbers existing staff',
    fns.importStaff({ staff: [{ id: 1 }] }, { authors: ['X Y'] }), 0);
  return done();
};
