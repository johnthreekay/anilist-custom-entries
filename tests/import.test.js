'use strict';
const { grabFunction, grabConst, grabBetween, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('import');
  // Minimal DOMParser stand-in for the MAL export shape (regex-based).
  const fakeNode = (tag, inner) => ({
    tagName: tag,
    querySelector(name) {
      const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(inner);
      if (!m) return null;
      return { textContent: m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1') };
    },
  });
  class DOMParser {
    parseFromString(text) {
      const nodes = [];
      for (const m of text.matchAll(/<(anime|manga)>([\s\S]*?)<\/\1>/g)) nodes.push(fakeNode(m[1], m[2]));
      return { querySelector: (q) => (q === 'parsererror' && /<bad/.test(text) ? {} : null), querySelectorAll: () => nodes };
    }
  }
  const db = { seq: 0, entries: {}, owners: { 5: { id: 5, options: { scoreFormat: 'POINT_10' } } } };
  const created = [];
  const code = [
    grabConst('META_FORMAT_JIKAN'), grabConst('FORMAT_OPTS'),
    grabBetween('  const MAL_LIST_STATUS = ', 'csvRows'),
    grabFunction('importRow'), grabConst('importedBefore'),
  ].join('\n');
  const fns = evalBlock(code, {
    DOMParser, db, TAG: '[t]', isCustomId, nowSec: () => 1_800_000_000, DEFAULT_COVER: 'def.png', ownerOpts: (r) => db.owners[r.ownerId].options,
    allRecs: () => Object.values(db.entries), touchRec() {}, descToHtml: (t) => t,
    createRec: (f) => { created.push(f); const id = 2000000000 + (++db.seq); const rec = { id, ownerId: f.ownerId, type: f.type, media: { id, title: { userPreferred: f.title }, format: f.format, status: f.mediaStatus, episodes: f.episodes, chapters: f.chapters, volumes: f.volumes, coverImage: { large: f.cover } }, entry: { id, status: f.status, score: 0, progress: 0, progressVolumes: 0, repeat: 0, notes: null, startedAt: {}, completedAt: {}, private: false }, external: {} }; db.entries[id] = rec; return rec; },
    applyImportToRec: (rec, r) => { rec.media.format = r.format || rec.media.format; rec.media.status = r.mediaStatus; rec.external = Object.assign({}, rec.external, r.external); if (r.cover) rec.media.coverImage = { large: r.cover }; rec.media.genres = r.genres || []; },
    console: { log() {}, warn() {} },
  }, ['parseMalXml', 'csvRows', 'importRow', 'importedBefore', 'scoreFrom100', 'isoToFuzzy', 'parseCsv']);

  const xml = `<?xml version="1.0"?><myanimelist><myinfo><user_export_type>2</user_export_type></myinfo>
<manga><series_mangadb_id>74695</series_mangadb_id><series_title><![CDATA[Touhou Dj - Yatai]]></series_title><series_type>Doujinshi</series_type><series_chapters>12</series_chapters><series_volumes>2</series_volumes><my_read_chapters>5</my_read_chapters><my_read_volumes>1</my_read_volumes><my_start_date>2025-02-03</my_start_date><my_finish_date>0000-00-00</my_finish_date><my_score>8</my_score><my_status>Reading</my_status><my_comments><![CDATA[fun]]></my_comments><my_times_read>0</my_times_read><my_rereading>0</my_rereading></manga>
<manga><series_mangadb_id>2</series_mangadb_id><series_title><![CDATA[Berserk]]></series_title><series_type>Manga</series_type><series_chapters>0</series_chapters><my_read_chapters>300</my_read_chapters><my_score>0</my_score><my_status>Completed</my_status><my_rereading>1</my_rereading><my_times_read>2</my_times_read></manga>
</myanimelist>`;
  const rows = fns.parseMalXml(xml);
  expect('MAL xml rows', rows.map((r) => [r.title, r.type, r.format, r.external.mal, r.list.status, r.list.progress, r.list.progressVolumes, r.list.score100, r.list.notes, r.list.startedAt.year, r.list.repeat]),
    [['Touhou Dj - Yatai', 'MANGA', 'MANGA', 74695, 'CURRENT', 5, 1, 80, 'fun', 2025, 0], ['Berserk', 'MANGA', 'MANGA', 2, 'REPEATING', 300, 0, null, null, null, 2]]);

  const csv = 'Title,Type,Status,Progress,Score,Tags,Started At,mal_id,"Notes"\n"Mystia\'s Yatai, vol 1",manga,reading,3,7,"Yokai; Food",2024-05-01,,"line ""quoted"""\nSome Anime,Anime,ptw,0,,,,,\n';
  const crows = fns.csvRows(csv, 'MANGA');
  expect('CSV rows (quotes, aliases, defaults)', crows.map((r) => [r.title, r.type, r.list.status, r.list.progress, r.list.score, r.tags, r.list.startedAt, r.list.notes]),
    [["Mystia's Yatai, vol 1", 'MANGA', 'CURRENT', 3, 7, ['Yokai', 'Food'], { year: 2024, month: 5, day: 1 }, 'line "quoted"'], ['Some Anime', 'ANIME', 'PLANNING', 0, null, [], { year: null, month: null, day: null }, null]]);
  let threw = null;
  try { fns.csvRows('a,b\n1,2', 'MANGA'); } catch (e) { threw = e.message; }
  expect('CSV without title column is rejected', /title/.test(threw), true);

  // importRow: list fields applied, score converted to the viewer's format.
  const rec = fns.importRow(rows[0], 5);
  expect('importRow: quiet create, list fields, score 80 → 8 on POINT_10', [created[0].quiet, created[0].status, rec.entry.progress, rec.entry.progressVolumes, rec.entry.score, rec.entry.notes, rec.entry.startedAt.year, rec.external.mal, !!rec.imported], [true, 'CURRENT', 5, 1, 8, 'fun', 2025, 74695, true]);
  expect('importedBefore by MAL id per type', [fns.importedBefore(rows[0]), fns.importedBefore(rows[1]), fns.importedBefore({ type: 'ANIME', external: { mal: 74695 } })], [true, false, false]);
  expect('scoreFrom100 formats', [fns.scoreFrom100({ ownerId: 5 }, 85), fns.scoreFrom100({ ownerId: 5 }, 0)], [9, 0]);
  const r2 = fns.importRow(crows[0], 5);
  expect('CSV score kept as-is', r2.entry.score, 7);
  return done();
};
