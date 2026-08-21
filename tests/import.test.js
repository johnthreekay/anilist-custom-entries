'use strict';
const { grabFunction, grabConst, grabBetween, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = async function () {
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
    grabFunction('importRow'), grabConst('findImportedRec'), grabConst('importedBefore'),
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

  // --- Title languages (1.42): per-language titles land in their own
  // fields (romaji/english/native), not in synonyms. ---
  const csv2 = fns.csvRows('title,native,english,romaji\nMystia,ミスティア,Mystia EN,Mystia Ro\n', 'MANGA');
  expect('CSV title language columns', csv2[0].titles, { romaji: 'Mystia Ro', english: 'Mystia EN', native: 'ミスティア' });

  const tls = { lang: 'ROMAJI', getItem() { return JSON.stringify({ options: { titleLanguage: this.lang } }); } };
  const tfns = evalBlock([
    grabConst('META_STATUS_MB'), grabConst('META_STATUS_JIKAN'), grabConst('META_FORMAT_JIKAN'),
    grabConst('MD_STATUS'), grabConst('mdText'), grabConst('intId'), grabConst('FORMAT_OPTS'), grabConst('malName'),
    grabConst('looksCjk'), grabConst('HEPBURN_WORD'), grabConst('ENGLISH_HINTS'), grabFunction('romajiScore'), grabFunction('pickEnglishTitle'),
    grabFunction('viewerTitleLang'), grabFunction('preferredTitleOf'),
    grabFunction('importTitleObj'), grabFunction('stripTitleSynonyms'), grabFunction('mergeExternal'), grabFunction('importStaff'),
    grabFunction('mergeTagsFrom'), grabFunction('mbByMalId'),
    grabFunction('mbNormalize'), grabFunction('jikanNormalize'), grabFunction('mdNormalize'),
    grabFunction('applyImportToRec'), grabFunction('parseTags'), grabConst('titleFlattened'), grabFunction('applyTitleFix'),
    grabConst('dynTags'), grabConst('DYN_STATUS'), grabConst('DYN'), grabConst('DYN_KIND_LABEL'), grabFunction('dynNormalize'),
  ].join('\n'), {
    titleCase: (s) => s, descToHtml: (t) => t || null, splitGenresTags: (g) => ({ genres: g, tags: [] }),
    mbIsAdult: () => false, jikanIsAdult: () => false,
    setCover: (md, u) => { md.coverImage = { large: u }; }, touchRec() {}, saveDB() {},
    muFetchJson: async () => ({ completed: true }),
    metaFetchJson: async () => ({ data: [
      { id: 1, title: 'Wrong Series', type: 'manga', status: 'completed', source: { my_anime_list: { id: 111 } } },
      { id: 2, title: 'Right Series', type: 'manga', status: 'completed', genres: ['Fantasy'], tags: ['Youkai'], source: { my_anime_list: { id: 222 } } },
    ] }),
    htmlToText: (t) => t || '',
    db: { seq: 500 }, ID_BASE: 2000000000,
    localStorage: tls,
  }, ['importTitleObj', 'stripTitleSynonyms', 'mbNormalize', 'jikanNormalize', 'mdNormalize', 'applyImportToRec', 'titleFlattened', 'applyTitleFix', 'preferredTitleOf', 'romajiScore', 'pickEnglishTitle', 'dynNormalize', 'mergeTagsFrom', 'mbByMalId']);

  expect('importTitleObj: per-language titles, userPreferred = viewer language (romaji)',
    tfns.importTitleObj({ title: 'Disp', titles: { romaji: 'Rom', english: 'Eng', native: '夜雀' } }),
    { romaji: 'Rom', english: 'Eng', native: '夜雀', userPreferred: 'Rom' });
  expect('importTitleObj: bare title → romaji only',
    tfns.importTitleObj({ title: 'Solo' }), { romaji: 'Solo', english: null, native: null, userPreferred: 'Solo' });
  expect('preferredTitleOf follows the AniList title language, romaji fallback', (() => {
    const t = { romaji: 'Rom', english: 'Eng', native: '夜雀' };
    const at = (lang) => { tls.lang = lang; return tfns.preferredTitleOf(t); };
    const out = [at('ROMAJI'), at('ENGLISH'), at('NATIVE'), at('ENGLISH_STYLISED'),
      (tls.lang = 'ENGLISH', tfns.preferredTitleOf({ romaji: 'Rom', english: null, native: null }))];
    tls.lang = 'ROMAJI';
    return out;
  })(), ['Rom', 'Eng', '夜雀', 'Eng', 'Rom']);
  expect('stripTitleSynonyms drops promoted titles + dupes',
    tfns.stripTitleSynonyms(['Eng', '夜雀', 'Alt', 'Alt'], { userPreferred: 'Disp', romaji: 'Rom', english: 'Eng', native: '夜雀' }),
    ['Alt']);
  expect('jikanNormalize titles',
    tfns.jikanNormalize({ title: 'Sousou no Frieren', title_english: 'Frieren', title_japanese: '葬送のフリーレン', title_synonyms: ['Frieren at the Funeral'], type: 'TV', status: 'Finished Airing' }, true).titles,
    { romaji: 'Sousou no Frieren', english: 'Frieren', native: '葬送のフリーレン' });
  expect('romajiScore: Hepburn words score, English words do not', [
    tfns.romajiScore('Touhou Project dj - Kazami Yuuka no Hidamari Hatake') > tfns.romajiScore('Touhou dj - Flower Master'),
    tfns.romajiScore('Kusuriya no Hitorigoto') > tfns.romajiScore('The Apothecary Diaries'),
    tfns.romajiScore('Konya wa Yosuzume no Yatai de') > 0.9,
  ], [true, true, true]);
  // English function words that happen to scan as Hepburn are English
  // evidence ("Bloom Into You" must not classify as romaji).
  expect('romajiScore: English function words count against', [
    tfns.romajiScore('Bloom Into You') < 0.5,
    tfns.romajiScore('Your Name') < 0.5,
    tfns.romajiScore('Watashi no Yuri Garden') >= 0.5,
  ], [true, true, true]);
  // A camel-cased single-token "romanized" title is a fan abbreviation;
  // the full romanization is rescued from the alt-title bag.
  expect('mbNormalize: abbreviation romanized_title rescued from the bag',
    tfns.mbNormalize({ id: 3, title: 'Star Dream', romanized_title: 'HoshiYume', native_title: '星の夢', secondary_titles: { unknown: [{ title: 'Hoshi no Yume o Miru' }, { title: 'Stellar Dreaming' }] }, type: 'manga', status: 'completed' }).titles,
    { romaji: 'Hoshi no Yume o Miru', english: null, native: '星の夢' });
  expect('mdNormalize: staffRows keep author/artist roles',
    tfns.mdNormalize({ id: 'u9', attributes: { title: { en: 'X' }, altTitles: [], tags: [], status: 'ongoing', links: {} }, relationships: [
      { type: 'author', attributes: { name: 'Pen Writer' } },
      { type: 'artist', attributes: { name: 'Ink Drawer' } },
      { type: 'artist', attributes: { name: 'Pen Writer' } },
    ] }).staffRows,
    [{ name: 'Pen Writer', role: 'Story & Art' }, { name: 'Ink Drawer', role: 'Art' }]);
  expect('jikanNormalize: staffRows flip MAL name order',
    tfns.jikanNormalize({ title: 'T', type: 'Manga', status: 'Finished', authors: [{ name: 'Ito, Sakura' }] }, false).staffRows,
    [{ name: 'Sakura Ito', role: null }]);
  // The real MangaBaka data for series 16648: romanized_title holds an
  // English alt, every secondary title is typed "unknown". The importer
  // must still produce the right romaji AND pick the English translation
  // that shares name tokens with the romaji (not "Flower Master" etc.).
  const kazami = tfns.mbNormalize({
    id: 16648,
    title: 'Touhou Project dj - Kazami Yuuka no Hidamari Hatake',
    native_title: '東方 Project dj - 風見幽香の向日葵畑',
    romanized_title: 'Touhou dj - Flower Master',
    secondary_titles: { unknown: [
      { type: 'unknown', title: 'Touhou dj - Flower Master' },
      { type: 'unknown', title: 'Touhou dj - Flowers and Humans and Youkai and…' },
      { type: 'unknown', title: 'Touhou Project dj - Drink till Drunk in the Scent of the Party' },
      { type: 'unknown', title: 'Touhou Project dj - Flower Master' },
      { type: 'unknown', title: 'Touhou Project dj - Kazami Yuuka no Hidamari Hatake' },
      { type: 'unknown', title: "Touhou Project dj - Kazami Yuuka' Sunflower Field Story" },
      { type: 'unknown', title: 'Touhou Project dj - Kazami Yuukou no Himawari Hatake' },
      { type: 'unknown', title: "Touhou Project dj - Yuka Kazami's Sunflower Field" },
      { type: 'unknown', title: '東方 Project dj - 風見幽香の向日葵畑' },
    ] },
    type: 'doujinshi', status: 'completed',
  }).titles;
  expect('mbNormalize on real MangaBaka doujin data', kazami, {
    romaji: 'Touhou Project dj - Kazami Yuuka no Hidamari Hatake',
    english: "Touhou Project dj - Yuka Kazami's Sunflower Field",
    native: '東方 Project dj - 風見幽香の向日葵畑',
  });
  expect('pickEnglishTitle: no shared tokens → null (no wild guesses)',
    tfns.pickEnglishTitle(['Some Other Comic', 'Moonlight Blade'], 'Tsukimichi no Akane', 'Tsukimichi no Akane'),
    null);
  // Overlap ranks, brevity breaks ties, romaji-ish and CJK candidates are
  // not English candidates, and Yuuka/Yuka's-style variants still match.
  expect('pickEnglishTitle: best-overlap candidate wins, shorter on ties',
    tfns.pickEnglishTitle(
      ["Akane's Moonlit Road", 'Akane Moonlight Story Extended Version', 'Moonlight Blade', 'Tsukiyo no Akane', '月夜の茜'],
      'Tsukiyo no Akane', 'Tsukiyo no Akane'),
    "Akane's Moonlit Road");
  expect('pickEnglishTitle: long-vowel collapse matches name variants',
    tfns.pickEnglishTitle(["Ryouko's Diner"], 'Ryoko no Shokudou', 'Ryoko no Shokudou'),
    "Ryouko's Diner");
  // MangaBaka sometimes stores an English alt in romanized_title; the more
  // romaji-plausible of romanized_title / title wins.
  // The demoted romanized_title is still the only known English alt here,
  // so it lands in english instead of vanishing.
  expect('mbNormalize: junk romanized_title demoted to the english slot',
    tfns.mbNormalize({ id: 2, title: 'Touhou Project dj - Kazami Yuuka no Hidamari Hatake', romanized_title: 'Touhou dj - Flower Master', native_title: '東方 Project dj - 風見幽香の向日葵畑', type: 'doujinshi', status: 'completed' }).titles,
    { romaji: 'Touhou Project dj - Kazami Yuuka no Hidamari Hatake', english: 'Touhou dj - Flower Master', native: '東方 Project dj - 風見幽香の向日葵畑' });
  expect('mbNormalize titles (romanized/native + secondary en)',
    tfns.mbNormalize({ id: 1, title: 'Food Stand', romanized_title: 'Yosuzume no Yatai', native_title: '屋台', secondary_titles: { en: [{ title: 'Food Cart' }] }, type: 'manga', status: 'releasing' }).titles,
    { romaji: 'Yosuzume no Yatai', english: 'Food Cart', native: '屋台' });
  expect('mdNormalize titles (title map + altTitles by lang)',
    tfns.mdNormalize({ id: 'u1', attributes: { title: { en: 'Eng T' }, altTitles: [{ ja: 'ジャ' }, { 'ja-ro': 'Ja Ro' }], tags: [], status: 'ongoing', links: {} }, relationships: [] }).titles,
    { romaji: 'Ja Ro', english: 'Eng T', native: 'ジャ' });
  // MangaDex language tags are unreliable: CJK-under-en is native, and an
  // en-tagged title that scans as Hepburn is really the romanized title.
  expect('mdNormalize: mislabeled en tags reclassified by script',
    tfns.mdNormalize({ id: 'u2', attributes: { title: { en: 'Mou Marisa' }, altTitles: [{ en: 'もう魔理沙ったら私が好きなんだから!' }], tags: [], status: 'completed', links: {} }, relationships: [] }).titles,
    { romaji: 'Mou Marisa', english: null, native: 'もう魔理沙ったら私が好きなんだから!' });
  expect('mdNormalize: romaji-as-en plus a real English alt sorted apart',
    tfns.mdNormalize({ id: 'u3', attributes: { title: { en: 'Tsuki no Cafe' }, altTitles: [{ en: 'The Moon Cafe' }, { ja: '月のカフェ' }], tags: [], status: 'ongoing', links: {} }, relationships: [] }).titles,
    { romaji: 'Tsuki no Cafe', english: 'The Moon Cafe', native: '月のカフェ' });
  expect('importTitleObj: distinct English-looking display title fills english',
    tfns.importTitleObj({ title: 'Tonight at the Stand', titles: { romaji: 'Konya no Yatai', native: '今夜の屋台' } }),
    { romaji: 'Konya no Yatai', english: 'Tonight at the Stand', native: '今夜の屋台', userPreferred: 'Konya no Yatai' });
  expect('importTitleObj: CJK-dominant english moved to native',
    tfns.importTitleObj({ title: 'Disp', titles: { english: '夜雀の屋台' } }),
    { romaji: 'Disp', english: null, native: '夜雀の屋台', userPreferred: 'Disp' });

  // MAL: no title_english, but an untyped synonym carrying the heroine's
  // name is the translation.
  expect('jikanNormalize: english falls back to a name-sharing synonym',
    tfns.jikanNormalize({ title: 'Hanako no Himitsu Kissa', title_japanese: '花子の秘密喫茶', title_synonyms: ["Hanako's Secret Cafe", 'Hanako no Himitsu Kissaten'], type: 'Manga', status: 'Finished' }, false).titles,
    { romaji: 'Hanako no Himitsu Kissa', english: "Hanako's Secret Cafe", native: '花子の秘密喫茶' });
  // Dynasty: no language tags at all; title and aliases classified by script.
  expect('dynNormalize: title/aliases classified into romaji/english/native',
    tfns.dynNormalize('series', 'yuri-garden', { name: 'Watashi no Yuri Garden', tags: [], taggings: [], aliases: ['私の百合ガーデン', 'My Lily Garden'], description: '' }).titles,
    { romaji: 'Watashi no Yuri Garden', english: 'My Lily Garden', native: '私の百合ガーデン' });
  const arec = { type: 'MANGA', media: { title: {}, coverImage: {} }, external: {} };
  tfns.applyImportToRec(arec, { title: 'Disp', titles: { romaji: 'Rom', native: '夜雀' }, synonyms: ['夜雀', 'Alt'], mediaStatus: 'FINISHED', format: 'MANGA', genres: [], tags: [] });
  expect('applyImportToRec: titles to fields, synonyms cleaned',
    [arec.media.title, arec.media.synonyms],
    [{ romaji: 'Rom', english: 'Disp', native: '夜雀', userPreferred: 'Rom' }, ['Alt']]);

  const brec = { type: 'MANGA', media: { title: {}, coverImage: {} }, external: { mal: 5, mangabaka: 7 } };
  tfns.applyImportToRec(brec, { title: 'T', mediaStatus: 'FINISHED', format: 'MANGA', genres: [], tags: ['Alpha', 'Beta', 'Gamma:70'], synonyms: [], external: { mal: null, mangadex: 'x1' }, staffRows: [{ name: 'Sola Author' }] });
  expect('applyImportToRec: rank band, null-safe external merge, staff import',
    [brec.media.tags.map((t) => [t.name, t.rank]), brec.external, brec.staff.map((s) => [s.name.userPreferred, s.role])],
    [[['Alpha', 90], ['Beta', 88], ['Gamma', 70]], { mal: 5, mangabaka: 7, mangadex: 'x1' }, [['Sola Author', 'Story & Art']]]);
  // Unknown source status must never fabricate "Releasing" over curated data.
  expect('mbNormalize: unknown status stays null',
    tfns.mbNormalize({ id: 4, title: 'T', type: 'other', status: 'unknown' }).mediaStatus, null);
  // A stale MangaBaka record (status unknown) has stale counts too; the
  // hydrate step asks the upstream MangaUpdates record for the status.
  const stale = tfns.mbNormalize({ id: 5, title: 'T', type: 'manga', status: 'unknown', total_chapters: '3', final_volume: '1', source: { manga_updates: { id: 'zzz' } } });
  expect('mbNormalize: stale record drops counts, gains an MU hydrate',
    [stale.mediaStatus, stale.chapters, stale.volumes, typeof stale.hydrate], [null, null, null, 'function']);
  await stale.hydrate();
  expect('MB hydrate: MangaUpdates completed=true becomes Finished', stale.mediaStatus, 'FINISHED');
  expect('dynNormalize: anthology is a finished collection, chapters counted',
    (({ mediaStatus, chapters }) => ({ mediaStatus, chapters }))(tfns.dynNormalize('anthologies', 'x', { name: 'Flower Anthology', tags: [], taggings: [{ permalink: 'a' }, { permalink: 'b' }, { permalink: 'c' }], aliases: [], description: '' })),
    { mediaStatus: 'FINISHED', chapters: 3 });
  const srec = { type: 'MANGA', media: { title: {}, coverImage: {}, status: 'FINISHED' }, external: {} };
  tfns.applyImportToRec(srec, { title: 'T', mediaStatus: null, format: 'MANGA', genres: [], tags: [], synonyms: [] });
  expect('applyImportToRec: null status keeps the record status', srec.media.status, 'FINISHED');
  const flat = { type: 'MANGA', media: { title: { userPreferred: 'Disp', romaji: 'Disp', english: 'Disp', native: 'Disp' }, synonyms: ['Rom', '夜雀', 'Alt'], coverImage: {} }, external: { mangabaka: 9 } };
  expect('titleFlattened detects pre-1.42 shape', [tfns.titleFlattened(flat), tfns.titleFlattened(arec)], [true, false]);
  tfns.applyTitleFix(flat, { title: 'Night Sparrow Stand', titles: { romaji: 'Rom', native: '夜雀' } });
  expect('applyTitleFix: titles promoted, display becomes english, synonyms stripped',
    [flat.media.title, flat.media.synonyms],
    [{ romaji: 'Rom', english: 'Night Sparrow Stand', native: '夜雀', userPreferred: 'Rom' }, ['Alt']]);
  const manual = { media: { title: { userPreferred: 'Disp', romaji: 'Real Romaji', english: 'Manual English', native: null }, synonyms: [], coverImage: {} }, external: {} };
  tfns.applyTitleFix(manual, { title: 'Disp', titles: { native: '手動' } });
  expect('applyTitleFix: refetch adds languages but never erases distinct ones',
    manual.media.title,
    { romaji: 'Real Romaji', english: 'Manual English', native: '手動', userPreferred: 'Real Romaji' });
  // Live title-language switch: recomputes userPreferred, re-commits entities.
  const langBox = { v: 'ROMAJI' };
  const pushed = [];
  const trec = { id: 1, media: { title: { romaji: 'Rom', english: 'Eng', native: '夜雀', userPreferred: 'Rom' } } };
  const t3 = evalBlock(
    grabFunction('preferredTitleOf') + '\nlet lastTitleLang = viewerTitleLang();\n' + grabFunction('tickTitleLanguage'),
    {
      viewerTitleLang: () => langBox.v,
      allRecs: () => [trec],
      saveDB() {},
      pushRecEntities: (r) => pushed.push(r.id),
      TAG: '[t]', console: { log() {} },
    }, ['tickTitleLanguage']);
  t3.tickTitleLanguage(); // unchanged language: no-op
  expect('same title language: untouched', [trec.media.title.userPreferred, pushed.length], ['Rom', 0]);
  langBox.v = 'NATIVE';
  t3.tickTitleLanguage();
  expect('title language switch recomputes and re-commits', [trec.media.title.userPreferred, pushed], ['夜雀', [1]]);
  // MAL -> MangaBaka tag chase: resolved by exact MAL id, add-only merge.
  const hit = await tfns.mbByMalId(222, 'Right Series');
  const miss = await tfns.mbByMalId(999, 'Right Series');
  expect('mbByMalId: exact MAL id verification', [hit && hit.external.mangabaka, miss], [2, null]);
  const mrec = { media: { genres: ['Fantasy'], tags: [{ name: 'Youkai', rank: 90 }, { name: 'Food', rank: 88 }] } };
  const addedN = tfns.mergeTagsFrom(mrec, { genres: ['Fantasy', 'Comedy'], tags: ['youkai', 'Onsen:75', 'Birds'] });
  expect('mergeTagsFrom: add-only union, ranks continue, case-insensitive dedup',
    [addedN, mrec.media.genres, mrec.media.tags.map((t) => [t.name, t.rank])],
    [3, ['Fantasy', 'Comedy'], [['Youkai', 90], ['Food', 88], ['Onsen', 75], ['Birds', 84]]]);
  return done();
};
