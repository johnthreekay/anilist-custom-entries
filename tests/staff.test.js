'use strict';
const { grabBetween, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('staff');
  const block = grabBetween('  /* --- staff --- */', 'staffPageResult');
  const db = { seq: 200, entries: {} };
  const fetches = [];
  let resolveFetch;
  const nativeFetch = { call: (w, url, init) => { fetches.push(JSON.parse(init.body)); return new Promise((res) => { resolveFetch = res; }); } };
  const fns = evalBlock(block, {
    db, ID_BASE: 2000000000, TAG: '[t]', isCustomId, allRecs: () => Object.values(db.entries), recById: (id) => db.entries[id] || null,
    touchRec() {}, saveDB() {}, pushRecEntities() {}, mediaEntity: (r) => ({ id: r.id, type: r.type }), sanitizeHtml: (h) => h,
    nativeFetch, console: { log() {}, warn() {} }, window: {}, logRevision() {},
  }, ['handleSaveStaff', 'handleSaveMediaStaff', 'staffPageResult', 'staffEditShape', 'staffEntityOf', 'staffLinksFor', 'pendingStaff']);
  const rec = { id: 2000000014, type: 'MANGA', staff: [], media: {}, entry: {} };
  db.entries[rec.id] = rec;

  fns.handleSaveMediaStaff({ mediaId: 2000000014, role: 'Story & Art', staffId: 359544 }, rec);
  expect('real staff linked with placeholder + fetch', [rec.staff.length, isCustomId(rec.staff[0].id), fns.staffEditShape(rec.staff[0]).name.userPreferred, fetches.length], [1, true, 'Staff #359544', 1]);
  return new Promise((resolve) => {
    resolveFetch({ json: async () => ({ data: { Staff: { id: 359544, name: { first: 'Mero', last: 'Mizuyama', full: 'Mizuyama Mero', userPreferred: 'Mizuyama Mero' }, image: { large: 'img' }, language: 'Japanese', primaryOccupations: ['Mangaka'] } } }) });
    setTimeout(() => {
      expect('fetched details applied', fns.staffEntityOf(rec.staff[0]).name.userPreferred, 'Mizuyama Mero');
      fns.handleSaveMediaStaff({ id: rec.staff[0].id, mediaId: 2000000014, staffId: 359544, role: 'Story' }, rec);
      expect('role edit does not duplicate', [rec.staff.length, rec.staff[0].role], [1, 'Story']);
      const cr = fns.handleSaveStaff({ name: { first: 'Test', last: 'Staffer', alternative: [] }, language: 'Japanese', primaryOccupations: [] });
      fns.handleSaveMediaStaff({ mediaId: 2000000014, role: 'Story', staffSubmissionId: cr.SaveStaff.id }, rec);
      expect('Create New Staff links via staffSubmissionId', [rec.staff.length, rec.staff[1].staffId === cr.SaveStaff.id, fns.pendingStaff.has(cr.SaveStaff.id)], [2, true, false]);
      const pg = fns.staffPageResult(cr.SaveStaff.id, { staffPage: 1, type: 'MANGA', withStaffRoles: true }, { page: { id: 'k' } });
      expect('local staff page lists the entry', pg.entities.page.k.pageData, [{ staffRole: 'Story', node: 2000000014 }]);
      resolve(done());
    }, 5);
  });
};
