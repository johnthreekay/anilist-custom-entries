// ==UserScript==
// @name         AniList Custom Entries
// @namespace    al-custom-entries
// @version      1.41.4
// @description  Create fully client-side custom anime/manga entries on AniList that behave like normal list entries (rate, note, custom lists, progress, favourite, delete) via the native UI, including local activity feed entries and the home page's in-progress lists. Optionally syncs the database to a private GitHub repo for cross-device use.
// @author       john
// @homepageURL  https://github.com/johnthreekay/anilist-custom-entries
// @supportURL   https://github.com/johnthreekay/anilist-custom-entries/issues
// @updateURL    https://raw.githubusercontent.com/johnthreekay/anilist-custom-entries/main/anilist-custom-entries.user.js
// @downloadURL  https://raw.githubusercontent.com/johnthreekay/anilist-custom-entries/main/anilist-custom-entries.user.js
// @match        https://anilist.co/*
// @run-at       document-start
// @inject-into  page
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.mangadex.org
// @connect      uploads.mangadex.org
// @connect      dynasty-scans.com
// @connect      ranobedb.org
// @connect      images.ranobedb.org
// @connect      *
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // The script needs GM_xmlhttpRequest (import sources without CORS, image
  // embedding), and granting anything turns the script manager's sandbox on:
  // `window` becomes a wrapper whose property writes stay inside the sandbox,
  // so the fetch/Worker hooks and ALcustom below would never reach the page.
  // Alias `window` to the real page window for the whole script. Under raw
  // injection / no sandbox, unsafeWindow is the page window anyway.
  // eslint-disable-next-line no-shadow
  const window = (typeof unsafeWindow === 'object' && unsafeWindow) ? unsafeWindow : globalThis;

  const TAG = '[AL-Custom]';
  try { window.__ALCE_T0 = performance.now(); window.__ALCE_VERSION = '1.41.4'; } catch (e) { /* diagnostics only */ }
  const ID_BASE = 2000000000; // far above any real AniList media/entry id, still within GraphQL Int32
  const LS_KEY = 'al-custom-entries-v1';

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */

  // Embedded (data:) covers sit under extraLarge/large/medium alike. In
  // memory that is one string referenced three times (free); serialized it
  // would triple every embedded cover in localStorage, the sync file and
  // exports. packDB collapses the copies to an "@large" marker for
  // storage; unpackDB restores them on read. Applied to every JSON boundary.
  const DUP_MARK = '@large';
  function packDB(v) {
    if (Array.isArray(v)) return v.map(packDB);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    const dup = typeof v.large === 'string' && v.large.length > 500;
    for (const [k, x] of Object.entries(v)) {
      out[k] = (dup && (k === 'medium' || k === 'extraLarge') && x === v.large) ? DUP_MARK : packDB(x);
    }
    return out;
  }
  function unpackDB(v) {
    if (Array.isArray(v)) return v.map(unpackDB);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = unpackDB(x);
    if (typeof out.large === 'string') {
      if (out.medium === DUP_MARK) out.medium = out.large;
      if (out.extraLarge === DUP_MARK) out.extraLarge = out.large;
    }
    return out;
  }

  function loadDB() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return unpackDB(JSON.parse(raw));
    } catch (e) { console.warn(TAG, 'failed to load db', e); }
    return { seq: 0, owners: {}, entries: {}, activities: {}, deleted: {} };
  }

  // Writes are coalesced: a burst of saveDB calls in one task (bulk import,
  // merge, a save that touches several records) serializes the database once,
  // at the end of the task (microtask), never later than that, so nothing is
  // lost to navigation or tab close. pagehide flushes as a belt and braces.
  let dbFlushQueued = false;
  let localChangeSeq = 0; // bumped by every syncing save; the sync compares it
  function flushDB() {
    dbFlushQueued = false;
    try { localStorage.setItem(LS_KEY, JSON.stringify(packDB(db))); }
    catch (e) {
      console.warn(TAG, 'failed to save db', e);
      // Embedded images are the usual reason for hitting the ~5 MB quota.
      if (document.body) {
        try { toast('Custom entries: browser storage is full, this change was NOT saved (embedded images take space; replace some with URLs)', true); }
        catch (e2) { /* toast not ready */ }
      }
    }
  }
  function saveDB(opts) {
    if (!dbFlushQueued) {
      dbFlushQueued = true;
      if (typeof queueMicrotask === 'function') queueMicrotask(flushDB); else Promise.resolve().then(flushDB);
    }
    if (!opts || !opts.noSync) {
      localChangeSeq++;
      if (!syncCfg.dirty) { syncCfg.dirty = true; saveSyncCfg(); }
      scheduleSync();
    }
  }
  try { window.addEventListener('pagehide', () => { if (dbFlushQueued) flushDB(); }); } catch (e) { /* ignore */ }

  // Database shape version. Every load, import and merge result passes
  // through migrateDB, which fills in fields introduced later (one place
  // instead of `|| {}` guards scattered around) and stamps the version.
  //   1: pre-1.8 (entries, owners, seq)   2: activities   3: deleted
  //   4: favOrder                          5: per-record arrays (characters,
  //   staff, relations, recs, history), media.externalLinks / tags / genres
  //   6: media.studios (linked real studios)   7: reviews
  const DB_VERSION = 7;
  function migrateDB(d) {
    if (!d || typeof d !== 'object') return d;
    const from = d.version || 0;
    if (typeof d.seq !== 'number') d.seq = 0;
    d.owners = d.owners || {};
    d.entries = d.entries || {};
    d.activities = d.activities || {};
    d.deleted = d.deleted || {};
    d.favOrder = d.favOrder || {};
    for (const rec of Object.values(d.entries)) {
      if (!rec || typeof rec !== 'object') continue;
      rec.media = rec.media || {};
      rec.entry = rec.entry || {};
      for (const k of ['characters', 'staff', 'relations', 'recs', 'history', 'reviews']) if (!Array.isArray(rec[k])) rec[k] = [];
      for (const k of ['genres', 'tags', 'synonyms', 'externalLinks', 'studios']) if (!Array.isArray(rec.media[k])) rec.media[k] = [];
      if (!rec.media.title || typeof rec.media.title !== 'object') rec.media.title = { userPreferred: String(rec.media.title || 'Untitled') };
    }
    d.version = DB_VERSION;
    if (from && from !== DB_VERSION) console.log(TAG, `database migrated ${from} → ${DB_VERSION}`);
    return d;
  }

  let db = migrateDB(loadDB());

  // Owners that were only learned by browsing someone else's list, never
  // the logged-in account (`self`), owning no entries or activities, are
  // transient: drop them so the registry doesn't accumulate every profile
  // ever visited. Works on any db shape (also called from mergeDBs).
  function pruneOwners(d) {
    const used = new Set();
    for (const r of Object.values(d.entries || {})) used.add(r.ownerId);
    for (const a of Object.values(d.activities || {})) used.add(a.ownerId);
    let changed = false;
    for (const [id, o] of Object.entries(d.owners || {})) {
      if (!o.self && !used.has(o.id)) { delete d.owners[id]; changed = true; }
    }
    return changed;
  }

  // Flag the account we're currently logged in as (also migrates databases
  // from before the self flag existed), then prune browsed-only owners.
  (() => {
    const uid = authUserId();
    let changed = false;
    if (uid && db.owners[uid] && !db.owners[uid].self) { db.owners[uid].self = true; changed = true; }
    if (pruneOwners(db)) changed = true;
    if (changed) saveDB({ noSync: true });
  })();

  // Route params and some call sites pass ids as numeric strings.
  const isCustomId = (v) => {
    const n = typeof v === 'number' ? v
      : (typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : NaN);
    return n >= ID_BASE;
  };
  const recById = (id) => db.entries[id] || null;
  const allRecs = () => Object.values(db.entries);

  /* ------------------------------------------------------------------ *
   * GitHub sync (optional): mirrors the db to one JSON file in a private
   * repo via the Contents API so several browsers share one database.
   * ------------------------------------------------------------------ */

  const SYNC_KEY = 'al-custom-entries-sync-v1';
  const SYNC_DEBOUNCE_MS = 4000;
  const nowSec = () => Math.floor(Date.now() / 1000);

  function loadSyncCfg() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { repo: '', token: '', branch: 'main', path: 'data.json' };
  }
  const syncCfg = loadSyncCfg();
  function saveSyncCfg() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg)); } catch (e) { /* ignore */ }
  }
  const syncConfigured = () => !!(syncCfg.repo && syncCfg.token);
  // Wrench-modal toggle: count custom entries into the profile statistics
  // (client-side patch of the User statistics responses). Default on.
  const statsBumpEnabled = () => syncCfg.statsBump !== false;
  // Wrench-modal toggle: pin custom entries to the top of search results
  // regardless of the sort (off: sort-aware placement). Default off.
  const searchBumpEnabled = () => syncCfg.searchBump === true;
  // Wrench-modal "Developer options": shows the Debug tab (diagnostics,
  // RPC logging switch). Default off.
  const debugEnabled = () => syncCfg.debug === true;

  // Timestamps that drive cross-device merging. List-entry saves already
  // bump entry.updatedAt; every other mutation (media edits, characters,
  // favourites) bumps rec.updatedAt, and activity mutations (likes,
  // replies, subscriptions) bump activity.updatedAt. Deletions leave a
  // tombstone in db.deleted so they replicate instead of resurrecting.
  const touchRec = (rec) => { if (rec) rec.updatedAt = nowSec(); };
  const touchAct = (a) => { if (a) a.updatedAt = nowSec(); };
  const markDeleted = (id) => { db.deleted[id] = nowSec(); };
  const recTime = (r) => Math.max(r.updatedAt || 0, (r.entry && r.entry.updatedAt) || 0, (r.entry && r.entry.createdAt) || 0);
  const actTime = (a) => Math.max(a.updatedAt || 0, a.createdAt || 0);

  // Merge two dbs: the newest version of each record wins, tombstones beat
  // older edits, and records that collided on an id (created independently
  // on two offline devices) are both kept by re-numbering one of them.
  function mergeDBs(local, remote) {
    const out = {
      seq: Math.max(local.seq || 0, remote.seq || 0),
      owners: {}, entries: {}, activities: {}, deleted: {},
    };
    // Local owner fields win, but a self flag from either side sticks
    // (absent keys don't overwrite in Object.assign).
    for (const src of [remote.owners || {}, local.owners || {}]) {
      for (const [id, o] of Object.entries(src)) out.owners[id] = Object.assign({}, out.owners[id], o);
    }
    // Favourites order: per-type, the newest edit wins.
    out.favOrder = {};
    for (const src of [remote.favOrder || {}, local.favOrder || {}]) {
      for (const [t, v] of Object.entries(src)) {
        if (!out.favOrder[t] || (v.at || 0) >= (out.favOrder[t].at || 0)) out.favOrder[t] = v;
      }
    }
    for (const src of [remote.deleted || {}, local.deleted || {}]) {
      for (const [id, t] of Object.entries(src)) out.deleted[id] = Math.max(out.deleted[id] || 0, t);
    }

    const entryIds = new Set(Object.keys(local.entries || {}).concat(Object.keys(remote.entries || {})));
    for (const id of entryIds) {
      const l = (local.entries || {})[id];
      const r = (remote.entries || {})[id];
      let rec = l || r;
      if (l && r) {
        rec = recTime(l) >= recTime(r) ? l : r;
        if (l.entry && r.entry && l.entry.createdAt !== r.entry.createdAt) {
          const clone = JSON.parse(JSON.stringify(rec === l ? r : l));
          out.seq += 1;
          const nid = ID_BASE + out.seq;
          clone.id = nid;
          clone.media.id = nid;
          clone.entry.id = nid;
          clone.entry.mediaId = nid;
          out.entries[nid] = clone;
        }
      }
      const del = out.deleted[id] || 0;
      if (del >= recTime(rec)) continue;
      if (del) delete out.deleted[id];
      out.entries[id] = rec;
    }

    const actIds = new Set(Object.keys(local.activities || {}).concat(Object.keys(remote.activities || {})));
    for (const id of actIds) {
      const l = (local.activities || {})[id];
      const r = (remote.activities || {})[id];
      const a = l && r ? (actTime(l) >= actTime(r) ? l : r) : (l || r);
      const del = out.deleted[id] || 0;
      if (del >= actTime(a)) continue;
      if (del) delete out.deleted[id];
      out.activities[id] = a;
    }
    for (const [id, a] of Object.entries(out.activities)) {
      if (!out.entries[a.mediaId]) delete out.activities[id];
    }

    // seq must stay above every id in use (incl. characters and replies).
    const bump = (v) => { const s = parseInt(v, 10) - ID_BASE; if (s > out.seq) out.seq = s; };
    for (const id of Object.keys(out.entries)) {
      bump(id);
      for (const c of out.entries[id].characters || []) bump(c.id);
      for (const st of out.entries[id].staff || []) { bump(st.id); bump(st.staffId); }
      for (const h of out.entries[id].history || []) bump(h.id);
      for (const st of (out.entries[id].media && out.entries[id].media.studios) || []) bump(st.id);
      for (const rv of out.entries[id].reviews || []) bump(rv.id);
    }
    for (const id of Object.keys(out.activities)) {
      bump(id);
      for (const r of out.activities[id].replies || []) bump(r.id);
    }
    const cutoff = nowSec() - 180 * 86400;
    for (const [id, t] of Object.entries(out.deleted)) { if (t < cutoff) delete out.deleted[id]; }
    pruneOwners(out);
    return migrateDB(out);
  }

  // What a merge changed locally, for the sync tab's "last pull" report:
  // records the remote side won or that only it had, and records a remote
  // tombstone removed. Titles are captured because the losing record is gone.
  function mergeReport(before, after) {
    const items = [];
    const title = (rec) => (rec && rec.media && rec.media.title && rec.media.title.userPreferred) || '#' + (rec && rec.id);
    for (const [id, rec] of Object.entries(after.entries || {})) {
      const prev = (before.entries || {})[id];
      if (!prev) items.push({ id, title: title(rec), kind: 'new' });
      else if (prev !== rec) items.push({ id, title: title(rec), kind: 'updated' });
    }
    for (const [id, rec] of Object.entries(before.entries || {})) {
      if (!(after.entries || {})[id]) items.push({ id, title: title(rec), kind: 'removed' });
    }
    let acts = 0;
    for (const [id, a] of Object.entries(after.activities || {})) if ((before.activities || {})[id] !== a) acts++;
    return { at: nowSec(), items: items.slice(0, 50), more: Math.max(0, items.length - 50), activities: acts };
  }

  // Key-sorted deep copy so equality checks (and the pushed file) don't
  // depend on object insertion order, which merging shuffles.
  function sortDeep(v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
      return o;
    }
    return v;
  }
  const canon = (v) => JSON.stringify(sortDeep(v));

  const b64encodeUtf8 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const b64decodeUtf8 = (b64) => {
    const bin = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  };

  /* --- optional end-to-end encryption of the synced file ---
   * Enabled by setting a passphrase in the sync settings. data.json then
   * holds an AES-256-GCM envelope instead of plaintext: GitHub stores only
   * ciphertext, and any tampering makes decryption fail, so a forged file
   * can never reach mergeDBs. The passphrase itself is never stored; a
   * non-extractable CryptoKey derived via PBKDF2 (salt lives in the
   * envelope so every device derives the same key) is kept in IndexedDB. */

  const ENC_ITER = 600000; // PBKDF2-SHA-256 iterations (OWASP 2023+)
  const b64FromBytes = (bytes) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const b64ToBytes = (b64) => Uint8Array.from(atob(String(b64).replace(/\s/g, '')), (c) => c.charCodeAt(0));

  const isEnvelope = (j) => !!(j && j.alce === 'enc1' && j.kdf && typeof j.kdf.salt === 'string'
    && typeof j.nonce === 'string' && typeof j.ct === 'string');

  async function deriveSyncKey(passphrase, saltBytes, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase),
      'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // keyObj: { key: CryptoKey, salt: <b64>, iterations }
  async function sealEnvelope(keyObj, plaintext) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, keyObj.key,
      new TextEncoder().encode(plaintext));
    return {
      alce: 'enc1',
      kdf: { algo: 'PBKDF2-SHA-256', iterations: keyObj.iterations, salt: keyObj.salt },
      nonce: b64FromBytes(nonce),
      ct: b64FromBytes(new Uint8Array(ct)),
    };
  }

  async function openEnvelope(env, cryptoKey) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.nonce) },
      cryptoKey, b64ToBytes(env.ct));
    return new TextDecoder().decode(pt);
  }
  /* --- end crypto primitives --- */

  // The derived CryptoKey survives reloads in IndexedDB (structured clone
  // keeps it non-extractable). Failures are tolerated (e.g. private
  // browsing): the key then lives only in memory for the session.
  function idbStore(mode) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('alce-crypto', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('keys', mode);
        resolve({ store: tx.objectStore('keys'), done: () => req.result.close() });
      };
    });
  }
  const idbReq = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  async function idbGetKey() {
    const { store, done } = await idbStore('readonly');
    try { return await idbReq(store.get('syncKey')); } finally { done(); }
  }
  async function idbSetKey(v) {
    const { store, done } = await idbStore('readwrite');
    try { return await idbReq(v ? store.put(v, 'syncKey') : store.delete('syncKey')); } finally { done(); }
  }

  let syncKey = null;          // { key, salt, iterations } once known
  let pendingPassphrase = null; // set by the sync UI, consumed on next sync
  let dropEncryption = false;   // set by the sync UI to push plaintext again

  // Resolve the key for this sync round. A pending passphrase (re)derives:
  // against the remote envelope's salt when one exists, else a fresh salt
  // (turning encryption on). Returns null when an envelope exists but no
  // usable key does (wrong/absent passphrase, or salt changed remotely).
  async function ensureSyncKey(remoteEnv) {
    if (pendingPassphrase) {
      const kdf = remoteEnv && remoteEnv.kdf;
      const salt = kdf ? kdf.salt : b64FromBytes(crypto.getRandomValues(new Uint8Array(16)));
      const iterations = kdf ? kdf.iterations : ENC_ITER;
      const key = await deriveSyncKey(pendingPassphrase, b64ToBytes(salt), iterations);
      pendingPassphrase = null;
      syncKey = { key, salt, iterations };
      try { await idbSetKey(syncKey); } catch (e) { /* in-memory only */ }
      return syncKey;
    }
    if (!syncKey) {
      try { syncKey = (await idbGetKey()) || null; } catch (e) { syncKey = null; }
    }
    if (syncKey && remoteEnv && remoteEnv.kdf && remoteEnv.kdf.salt !== syncKey.salt) return null;
    return syncKey;
  }

  function ghUrl() {
    const path = (syncCfg.path || 'data.json').replace(/^\/+/, '')
      .split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${syncCfg.repo}/contents/${path}`;
  }

  function ghHeaders(extra) {
    return Object.assign({
      Authorization: 'Bearer ' + syncCfg.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, extra || {});
  }

  async function ghPull() {
    const res = await nativeFetch(`${ghUrl()}?ref=${encodeURIComponent(syncCfg.branch || 'main')}`,
      { headers: ghHeaders(), cache: 'no-store' });
    if (res.status === 404) return { json: null, sha: null };
    if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
    const j = await res.json();
    let content = j.content;
    // Past 1 MB the Contents API answers with encoding "none" and an empty
    // content field; the Git Blobs API serves the same file up to 100 MB.
    if (j.encoding !== 'base64' || (!content && j.size > 0)) {
      const b = await nativeFetch(`https://api.github.com/repos/${syncCfg.repo}/git/blobs/${j.sha}`,
        { headers: ghHeaders(), cache: 'no-store' });
      if (!b.ok) throw new Error(`GitHub blob GET ${b.status}`);
      content = (await b.json()).content;
    }
    const text = b64decodeUtf8(content || '');
    if (!text.trim()) throw new Error('sync file is empty');
    return { json: JSON.parse(text), sha: j.sha };
  }

  // Latest commit touching the sync file: a ~1 KB answer that tells whether
  // the remote moved since the last sync, so page loads skip downloading,
  // decrypting and merging an unchanged file.
  async function ghHead() {
    const path = (syncCfg.path || 'data.json').replace(/^\/+/, '');
    const url = `https://api.github.com/repos/${syncCfg.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(syncCfg.branch || 'main')}&per_page=1`;
    const res = await nativeFetch(url, { headers: ghHeaders(), cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j) && j[0] && j[0].sha ? j[0].sha : null;
  }

  async function ghPush(content, sha) {
    const body = {
      message: `alce sync ${new Date().toISOString()}`,
      content: b64encodeUtf8(content),
      branch: syncCfg.branch || 'main',
    };
    if (sha) body.sha = sha;
    const res = await nativeFetch(ghUrl(), {
      method: 'PUT',
      headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 422) return { conflict: true };
    if (!res.ok) throw new Error(`GitHub PUT ${res.status}`);
    const j = await res.json();
    return { sha: j.content && j.content.sha, commit: j.commit && j.commit.sha };
  }

  let syncStatusEl = null;
  function setSyncStatus(msg, isError) {
    syncCfg.lastStatus = msg;
    syncCfg.lastStatusAt = nowSec();
    syncCfg.lastStatusError = !!isError;
    saveSyncCfg();
    if (syncStatusEl && syncStatusEl.isConnected) {
      syncStatusEl.textContent = msg;
      const row = syncStatusEl.closest('.alce-status-row');
      if (row) row.dataset.state = isError ? 'bad' : (/^Syncing/.test(msg) ? 'busy' : 'ok');
    }
    console.log(TAG, 'sync:', msg);
  }

  let syncing = false;
  let syncAgain = false;
  let syncTimer = null;
  function scheduleSync() {
    if (!syncConfigured()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow('change'), SYNC_DEBOUNCE_MS);
  }

  // Remember which remote commit the local database matches; local changes
  // made while the sync ran keep the dirty flag (syncAgain picks them up).
  async function noteSynced(seqAtPull, commit) {
    let head = commit;
    if (!head) { try { head = await ghHead(); } catch (e) { head = null; } }
    syncCfg.remoteHead = head || null;
    if (localChangeSeq === seqAtPull) syncCfg.dirty = false;
    saveSyncCfg();
  }

  async function syncNow(trigger) {
    if (!syncConfigured()) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    setSyncStatus('Syncing…');
    try {
      // Fast path for the timed syncs: nothing changed here since the last
      // sync and the remote file's latest commit is the one we synced to →
      // nothing to pull or push, without touching the file itself.
      if ((trigger === 'load' || trigger === 'interval') && !syncCfg.dirty && syncCfg.remoteHead) {
        const head = await ghHead();
        if (head && head === syncCfg.remoteHead) {
          setSyncStatus(`In sync (${new Date().toLocaleTimeString()})`);
          return;
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const seqAtPull = localChangeSeq;
        const remote = await ghPull();
        let remoteDb = remote.json;
        const remoteEncrypted = isEnvelope(remoteDb);
        const key = await ensureSyncKey(remoteEncrypted ? remoteDb : null);
        if (remoteEncrypted) {
          if (!key) {
            setSyncStatus('Encryption passphrase required. Enter it in the sync settings.', true);
            return;
          }
          try { remoteDb = JSON.parse(await openEnvelope(remoteDb, key.key)); }
          catch (e) {
            setSyncStatus('Decryption failed. Check your passphrase and try again.', true);
            return;
          }
        }
        if (remoteDb) remoteDb = unpackDB(remoteDb);
        const merged = remoteDb ? mergeDBs(db, remoteDb) : db;
        const mergedCanon = canon(merged);
        const pulledChanges = mergedCanon !== canon(db);
        if (pulledChanges) {
          try { syncCfg.lastMerge = mergeReport(db, merged); saveSyncCfg(); } catch (e) { /* report only */ }
          db = merged;
          saveDB({ noSync: true });
          try { selfHeal(); } catch (e) { /* best effort */ }
        }
        const suffix = pulledChanges ? ' · pulled changes, reload to apply' : '';
        // Also push when the encryption state should change (turning it on
        // over a plaintext file, or off over an encrypted one).
        const wantEnc = !!key && !dropEncryption;
        if (remoteDb && mergedCanon === canon(remoteDb) && wantEnc === remoteEncrypted) {
          if (dropEncryption) { // remote already plaintext: just forget the key
            dropEncryption = false;
            syncKey = null;
            try { await idbSetKey(null); } catch (e) { /* ignore */ }
          }
          await noteSynced(seqAtPull, null);
          setSyncStatus(`In sync (${new Date().toLocaleTimeString()})${suffix}`);
          return;
        }
        const plain = JSON.stringify(sortDeep(packDB(merged)), null, 2);
        const body = wantEnc ? JSON.stringify(await sealEnvelope(key, plain), null, 2) : plain;
        const pushed = await ghPush(body, remote.sha);
        if (pushed.conflict) continue; // another device pushed first: re-pull and re-merge
        await noteSynced(seqAtPull, pushed.commit || null);
        if (dropEncryption) {
          dropEncryption = false;
          syncKey = null;
          try { await idbSetKey(null); } catch (e) { /* ignore */ }
        }
        setSyncStatus(`Synced (${new Date().toLocaleTimeString()})${suffix}`);
        return;
      }
      setSyncStatus('Sync failed: repeated push conflicts', true);
    } catch (e) {
      setSyncStatus('Sync failed: ' + ((e && e.message) || e), true);
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; scheduleSync(); }
    }
  }

  /* ------------------------------------------------------------------ *
   * Leak audit: proof that custom-entry traffic never leaves the browser
   * ------------------------------------------------------------------ */

  // Deep-scan an arbitrary value for any custom id (numbers or numeric
  // strings). Used to classify GraphQL traffic and to trip an alarm if
  // anything referencing a custom id is ever about to hit the network.
  function refsCustomId(v, depth) {
    if (depth > 6 || v == null) return false;
    if (typeof v === 'number' || typeof v === 'string') return isCustomId(v);
    if (Array.isArray(v)) return v.some((x) => refsCustomId(x, depth + 1));
    if (typeof v === 'object') {
      for (const k in v) { if (refsCustomId(v[k], depth + 1)) return true; }
    }
    return false;
  }

  const audit = {
    handledLocal: 0,   // custom-id ops answered locally (never sent)
    passedThrough: 0,  // clean requests forwarded to AniList
    leaked: 0,         // custom-id requests that reached the network (should stay 0)
    leaks: [],         // details of any leak, for inspection
  };

  // Called on the real network path. Returns true (and records a leak) if the
  // outgoing payload references a custom id, meaning our interception missed
  // it. In normal operation this never fires.
  function tripwire(where, query, vars) {
    if (refsCustomId(vars, 0) || (typeof query === 'string' && /2000\d{6}/.test(query))) {
      audit.leaked++;
      const detail = { where, query: String(query).slice(0, 120), vars, at: new Date().toISOString() };
      audit.leaks.push(detail);
      console.error(TAG, '⚠ LEAK: a custom-id request reached the network via', where, detail);
      return true;
    }
    audit.passedThrough++;
    return false;
  }

  function auditReport() {
    const ok = audit.leaked === 0;
    /* eslint-disable no-console */
    console.log(`%c[AL-Custom] Leak audit`, 'font-weight:bold');
    console.log(`  handled locally (never sent): ${audit.handledLocal}`);
    console.log(`  clean requests to AniList:    ${audit.passedThrough}`);
    console.log(`%c  custom-id requests leaked:    ${audit.leaked}`,
      ok ? 'color:#4cca51' : 'color:#e15d75;font-weight:bold');
    console.log(ok
      ? '%c  ✓ No phantom-entry traffic has reached AniList this session.'
      : '%c  ✗ Leaks detected: see audit.leaks below.',
      ok ? 'color:#4cca51' : 'color:#e15d75');
    if (!ok) console.log(audit.leaks);
    /* eslint-enable no-console */
    return { ok, ...audit };
  }

  /* ------------------------------------------------------------------ *
   * Section (list group) logic
   * ------------------------------------------------------------------ */

  const FMT_LABEL = {
    TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special',
    OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music',
    MANGA: 'Manga', NOVEL: 'Novel', ONE_SHOT: 'One Shot',
  };

  function ownerOpts(rec) {
    const owner = db.owners[rec.ownerId];
    return owner && owner.options ? owner.options : null;
  }

  function statusSectionName(rec) {
    const anime = rec.type === 'ANIME';
    const opts = ownerOpts(rec);
    const listOpts = opts ? (anime ? opts.animeList : opts.mangaList) : null;
    switch (rec.entry.status) {
      case 'CURRENT': return anime ? 'Watching' : 'Reading';
      case 'REPEATING': return anime ? 'Rewatching' : 'Rereading';
      case 'PLANNING': return 'Planning';
      case 'PAUSED': return 'Paused';
      case 'DROPPED': return 'Dropped';
      case 'COMPLETED':
        if (listOpts && listOpts.splitCompletedSectionByFormat && rec.media.format) {
          return 'Completed ' + (FMT_LABEL[rec.media.format] || rec.media.format);
        }
        return 'Completed';
      default: return null;
    }
  }

  // -> [{name, isCustomList, isCompletedList}]
  function sectionNamesFor(rec) {
    const out = [];
    const statusName = statusSectionName(rec);
    if (statusName && !rec.entry.hiddenFromStatusLists) {
      out.push({
        name: statusName,
        isCustomList: false,
        isCompletedList: statusName.startsWith('Completed ') && statusName !== 'Completed',
      });
    }
    for (const [name, on] of Object.entries(rec.entry.customLists || {})) {
      if (on) out.push({ name, isCustomList: true, isCompletedList: false });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * HTML sanitizer: descriptions are stored as HTML and rendered by
   * AniList via v-html, but the database can arrive from the sync repo or
   * a pasted import, so treat it as untrusted: allowlist formatting tags,
   * drop active content, event handlers, and non-http(s) URLs. Applied at
   * entity-emission time so the stored originals stay editable as typed.
   * ------------------------------------------------------------------ */

  const SAFE_HTML_TAGS = new Set(['A', 'B', 'I', 'EM', 'STRONG', 'U', 'S', 'DEL', 'BR', 'P',
    'SPAN', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'PRE', 'CODE', 'SMALL', 'SUB', 'SUP',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG']);
  // Removed together with their contents (script bodies, styles, foreign
  // markup; dropping SVG/MATH wholesale also cuts off namespace-confusion
  // tricks); other unknown tags are unwrapped so their text survives.
  const DROP_HTML_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
    'BASE', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'TEMPLATE', 'NOSCRIPT',
    'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'SVG', 'MATH']);

  const sanitizeCache = new Map(); // raw html → sanitized (bounded)
  function sanitizeHtml(html) {
    if (typeof html !== 'string' || html.indexOf('<') === -1) return html;
    const hit = sanitizeCache.get(html);
    if (hit !== undefined) return hit;
    const out = sanitizeHtmlUncached(html);
    if (sanitizeCache.size >= 500) sanitizeCache.delete(sanitizeCache.keys().next().value);
    sanitizeCache.set(html, out);
    return out;
  }
  function sanitizeHtmlUncached(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { return html.replace(/</g, '&lt;'); }
    for (const node of Array.from(doc.body.querySelectorAll('*'))) {
      const tag = node.tagName.toUpperCase();
      if (!SAFE_HTML_TAGS.has(tag)) {
        if (DROP_HTML_TAGS.has(tag)) node.remove();
        else node.replaceWith(...Array.from(node.childNodes));
        continue;
      }
      for (const attr of Array.from(node.attributes)) {
        const n = attr.name.toLowerCase();
        const keep = (n === 'href' && tag === 'A') || (n === 'src' && tag === 'IMG')
          || n === 'alt' || n === 'title' || n === 'width' || n === 'height';
        if (!keep) { node.removeAttribute(attr.name); continue; }
        if ((n === 'href' || n === 'src') && !/^https?:\/\//i.test(attr.value.trim())) {
          node.removeAttribute(attr.name);
        }
      }
      if (tag === 'A' && node.hasAttribute('href')) node.setAttribute('rel', 'noopener noreferrer');
    }
    return doc.body.innerHTML;
  }

  /* ------------------------------------------------------------------ *
   * Normalized entity builders (mirror the shapes AniList's worker emits)
   * ------------------------------------------------------------------ */

  function entryEntity(rec) {
    return Object.assign({}, rec.entry, { media: rec.id, user: rec.ownerId });
  }

  // A rec with no list status is a media-only record: mediaListEntry null
  // makes its page show the native "Add to List" control.
  const recIsListed = (rec) => !!(rec.entry.status
    || Object.values(rec.entry.customLists || {}).some(Boolean));

  function mediaEntity(rec) {
    try { enrichRecTags(rec); } catch (e) { /* catalog not loaded yet */ }
    const m = Object.assign({}, rec.media, { mediaListEntry: recIsListed(rec) ? rec.id : null });
    if (m.description) m.description = sanitizeHtml(m.description);
    m.nextAiringEpisode = nextAiringOf(rec);
    return m;
  }

  /* --- airing schedule (custom anime): rec.media.airingSchedule =
   * [{airingAt, episode}], edited through the edit page's native Airing
   * Schedule section (its generator query has no custom id and is
   * forwarded; load and save are answered locally). The next unaired item
   * becomes media.nextAiringEpisode: countdown on the media page and the
   * home cards, "behind" counts on the list, and local airing
   * notifications (see tickNotifications). --- */
  function airingScheduleOf(rec) {
    const a = rec && rec.media && rec.media.airingSchedule;
    return Array.isArray(a) ? a.filter((x) => x && Number.isFinite(x.airingAt) && Number.isFinite(x.episode)).slice().sort((x, y) => x.airingAt - y.airingAt || x.episode - y.episode) : [];
  }
  function nextAiringOf(rec) {
    if (!rec || rec.type !== 'ANIME') return null;
    const now = nowSec();
    const next = airingScheduleOf(rec).find((a) => a.airingAt > now);
    return next ? { airingAt: next.airingAt, timeUntilAiring: next.airingAt - now, episode: next.episode } : null;
  }
  function airingSchedulesResult(rec) {
    return { Page: { pageInfo: { hasNextPage: false }, airingSchedules: airingScheduleOf(rec).map((a) => ({ airingAt: a.airingAt, timeUntilAiring: a.airingAt - nowSec(), episode: a.episode })) } };
  }
  function handleSaveAiringSchedule(rec, vars) {
    if (!rec) return { SaveAiringSchedule: false };
    const items = (Array.isArray(vars.airingSchedule) ? vars.airingSchedule : [])
      .map((a) => ({ airingAt: parseInt(a && a.airingAt, 10), episode: parseInt(a && a.episode, 10) }))
      .filter((a) => Number.isFinite(a.airingAt) && Number.isFinite(a.episode) && a.episode > 0);
    const seen = new Set();
    rec.media.airingSchedule = items.filter((a) => (seen.has(a.episode) ? false : seen.add(a.episode)))
      .sort((x, y) => x.airingAt - y.airingAt || x.episode - y.episode);
    // Episodes that already aired when the schedule was set don't notify.
    const now = nowSec();
    const aired = rec.media.airingSchedule.filter((a) => a.airingAt <= now);
    notifs.airedUntil[rec.id] = aired.length ? aired[aired.length - 1].airingAt : now;
    // Reminders for airings the new schedule no longer has were wrong: drop them.
    notifs.items = notifs.items.filter((n) => !(n.type === 'AIRING' && n.mediaId === rec.id
      && !rec.media.airingSchedule.some((a) => a.episode === n.episode && a.airingAt === n.createdAt)));
    saveNotifs();
    logRevision(rec, 'EDIT', { 'airing schedule': 'Modified' });
    touchRec(rec);
    saveDB();
    pushRecEntities(rec);
    console.log(TAG, 'saved airing schedule for custom entry', rec.id, rec.media.airingSchedule.length, 'episode(s)');
    return { SaveAiringSchedule: true };
  }

  function userEntity(ownerId) {
    const owner = db.owners[ownerId];
    return { id: ownerId, name: owner ? owner.name : '?' };
  }

  /* --- local recommendations (rec.recs = [{id, target, rating, userRating,
   * media}]): target is a real AniList id (media stub captured at save
   * time so cards render offline) or another custom entry's id. --- */

  /* --- local notifications: airing reminders for custom anime with a
   * schedule ("Episode N of X aired.") and release-day reminders for
   * entries with a full start date ("X starts releasing today."), shown in
   * the native notifications page and counted in the nav badge. Also flips
   * NOT_YET_RELEASED → RELEASING / RELEASING → FINISHED when a full start /
   * end date is reached, as the site does for real entries. Device-local
   * (reminders are not synced); generated lazily on the UI tick. --- */
  const NOTIF_KEY = 'al-custom-entries-notifs-v1';
  const NOTIF_BASE = ID_BASE + 900000000;
  const NOTIF_CAP = 200;
  function loadNotifs() {
    try {
      const v = JSON.parse(localStorage.getItem(NOTIF_KEY) || 'null');
      if (v && typeof v === 'object') return { seq: v.seq || 0, items: Array.isArray(v.items) ? v.items : [], airedUntil: v.airedUntil || {}, released: v.released || {}, lastTick: v.lastTick || 0 };
    } catch (e) { /* fresh */ }
    return { seq: 0, items: [], airedUntil: {}, released: {}, lastTick: 0 };
  }
  let notifs = loadNotifs();
  function saveNotifs() {
    try { localStorage.setItem(NOTIF_KEY, JSON.stringify(notifs)); } catch (e) { /* quota */ }
  }
  function addNotif(n) {
    notifs.seq += 1;
    const item = Object.assign({ id: NOTIF_BASE + notifs.seq, read: false }, n);
    notifs.items.push(item);
    if (notifs.items.length > NOTIF_CAP) notifs.items.splice(0, notifs.items.length - NOTIF_CAP);
    return item;
  }
  const localNotifsFor = (uid) => notifs.items.filter((n) => n.ownerId === uid && recById(n.mediaId)).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const unreadLocalNotifs = (uid) => localNotifsFor(uid).filter((n) => !n.read);
  function notifEntity(n) {
    if (n.type === 'AIRING') return { id: n.id, type: 'AIRING', episode: n.episode, contexts: ['Episode ', ' of ', ' aired.'], media: n.mediaId, createdAt: n.createdAt };
    return { id: n.id, type: 'RELATED_MEDIA_ADDITION', context: n.context || ' started releasing.', media: n.mediaId, createdAt: n.createdAt };
  }
  const fuzzySec = (d) => (d && d.year && d.month && d.day ? Math.floor(new Date(d.year, d.month - 1, d.day).getTime() / 1000) : null);
  // Generate due notifications and apply date-driven status flips.
  // Idempotent; cheap enough to run on the UI tick (throttled to a minute).
  function tickNotifications(force) {
    const now = nowSec();
    if (!force && now - (notifs.lastTick || 0) < 60) return;
    notifs.lastTick = now;
    const uid = authUserId();
    let changedDb = false;
    let added = 0;
    for (const rec of allRecs()) {
      const md = rec.media || {};
      // Status flips from dates (any owner: it's data, not a reminder).
      const start = fuzzySec(md.startDate);
      const end = fuzzySec(md.endDate);
      if (start !== null && start <= now && md.status === 'NOT_YET_RELEASED') {
        md.status = 'RELEASING'; logRevision(rec, 'EDIT', { status: 'Modified' }); touchRec(rec); changedDb = true;
        console.log(TAG, 'custom entry reached its start date: now releasing', rec.id);
      }
      if (end !== null && end + 86400 <= now && md.status === 'RELEASING') {
        md.status = 'FINISHED'; logRevision(rec, 'EDIT', { status: 'Modified' }); touchRec(rec); changedDb = true;
        console.log(TAG, 'custom entry reached its end date: now finished', rec.id);
      }
      if (!uid || rec.ownerId !== uid) continue;
      // Airing reminders (anime with a schedule).
      const sched = airingScheduleOf(rec);
      if (sched.length) {
        let until = notifs.airedUntil[rec.id];
        if (until === undefined) { until = now; notifs.airedUntil[rec.id] = now; } // first sight: no backfill
        for (const a of sched) {
          if (a.airingAt <= until || a.airingAt > now) continue;
          addNotif({ type: 'AIRING', ownerId: uid, mediaId: rec.id, episode: a.episode, createdAt: a.airingAt });
          notifs.airedUntil[rec.id] = a.airingAt;
          added++;
        }
      }
      // Release-day reminder: once, for entries added before their start
      // date (catalogued-after-the-fact entries never notify), within 30 days.
      if (start !== null && !notifs.released[rec.id]) {
        const createdAt = (rec.entry && rec.entry.createdAt) || 0;
        if (start <= now && createdAt && createdAt < start && now - start < 30 * 86400) {
          addNotif({ type: 'RELATED_MEDIA_ADDITION', ownerId: uid, mediaId: rec.id, context: rec.type === 'ANIME' && !sched.length ? ' started airing today.' : ' started releasing today.', createdAt: start });
          added++;
        }
        if (start <= now) notifs.released[rec.id] = true;
      }
    }
    for (const id of Object.keys(notifs.airedUntil)) if (!recById(parseInt(id, 10))) delete notifs.airedUntil[id];
    for (const id of Object.keys(notifs.released)) if (!recById(parseInt(id, 10))) delete notifs.released[id];
    saveNotifs();
    if (changedDb) saveDB();
    if (added) console.log(TAG, `${added} local notification${added === 1 ? '' : 's'} added`);
    return added;
  }
  // Viewer entity: the nav badge counts local unread reminders too. The
  // marker records what was added so re-runs (and the store heal) adjust
  // by the difference only.
  function bumpUnreadCount(u) {
    if (!u || typeof u !== 'object') return false;
    const n = unreadLocalNotifs(u.id).length;
    const prev = u.__alceUnread || 0;
    if (n === prev) return false;
    u.unreadNotificationCount = Math.max(0, (u.unreadNotificationCount || 0) - prev + n);
    u.__alceUnread = n;
    return true;
  }
  function patchViewer(result) {
    const ents = result && result.entities;
    const u = ents && ents.user && typeof result.result === 'number' ? ents.user[result.result] : null;
    if (bumpUnreadCount(u)) console.log(TAG, 'nav badge includes', u.__alceUnread, 'local notification(s)');
  }
  // Notifications page (feed 'all' | 'airing' | 'media' ...): page 1 gets
  // the local reminders, unread ones first (the page marks the first
  // unreadNotificationCount rows as unread), read ones merged by time.
  const NOTIF_FEEDS = { all: null, airing: ['AIRING'], media: ['RELATED_MEDIA_ADDITION'] };
  function patchNotifications(result, meta) {
    const ents = result && result.entities;
    const pg = ents && ents.page && ents.page[meta.pageId];
    if (!pg || !Array.isArray(pg.pageData) || (meta.page || 1) !== 1) return;
    const uid = authUserId();
    if (!uid || !(meta.feed in NOTIF_FEEDS)) return;
    const types = NOTIF_FEEDS[meta.feed];
    const mine = localNotifsFor(uid).filter((n) => !types || types.includes(n.type)).filter((n) => !pg.pageData.includes(n.id));
    if (!mine.length) return;
    ents.notification = ents.notification || {};
    ents.media = ents.media || {};
    const timeOf = (id) => { const e = ents.notification[id]; return e ? e.createdAt || 0 : 0; };
    const unread = mine.filter((n) => !n.read);
    const read = mine.filter((n) => n.read);
    for (const n of mine) { ents.notification[n.id] = notifEntity(n); ents.media[n.mediaId] = mediaEntity(recById(n.mediaId)); }
    const merged = pg.pageData.slice();
    for (const n of read) {
      let i = merged.findIndex((id) => !isCustomId(id) && timeOf(id) < n.createdAt);
      if (i === -1) i = merged.length;
      merged.splice(i, 0, n.id);
    }
    pg.pageData = unread.map((n) => n.id).concat(merged);
    if (pg.pageInfo && typeof pg.pageInfo.total === 'number') pg.pageInfo.total += mine.length;
    console.log(TAG, `added ${mine.length} local notification${mine.length === 1 ? '' : 's'} to the ${meta.feed} feed`);
    // Opening the feed marks them read (the site resets its own count the
    // same way); the page keeps its highlight until the count is reset.
    if (meta.feed === 'all' && unread.length) {
      setTimeout(() => { for (const n of unread) n.read = true; saveNotifs(); }, 1500);
    }
  }
  // Late injection: repair the store's viewer count / notifications page.
  function healNotifications() {
    const store = vueStore();
    const ents = store && entitiesState(store);
    if (!ents) return;
    const uid = authUserId();
    const u = uid && ents.user && ents.user[uid];
    // Not while the notifications page is open: it keeps its highlight until
    // the site resets the count on leaving.
    if (u && !/^\/notifications/.test(location.pathname) && bumpUnreadCount(u)) { try { store.commit('setEntities', { user: { [uid]: { unreadNotificationCount: u.unreadNotificationCount, __alceUnread: u.__alceUnread } } }); } catch (e) { /* ignore */ } }
    for (const feed of Object.keys(NOTIF_FEEDS)) {
      const key = 'notifications-' + feed;
      const pg = ents.page && ents.page[key];
      const arr = pg && pg.pageData && pg.pageData[1];
      if (!Array.isArray(arr)) continue;
      const fake = { entities: { page: { [key]: { pageInfo: {}, pageData: arr.slice() } }, notification: ents.notification || {} } };
      patchNotifications(fake, { pageId: key, feed, page: 1 });
      const out = fake.entities.page[key].pageData;
      if (out.length === arr.length) continue;
      const patch = { notification: {}, media: {} };
      for (const id of out) if (!arr.includes(id)) { patch.notification[id] = fake.entities.notification[id]; }
      for (const id of Object.keys(patch.notification)) { const n = notifs.items.find((x) => x.id === parseInt(id, 10)); if (n && recById(n.mediaId)) patch.media[n.mediaId] = mediaEntity(recById(n.mediaId)); }
      try { store.commit('setEntities', patch); } catch (e) { /* ignore */ }
      arr.splice(0, arr.length, ...out);
    }
  }

  function recRecEntity(rr) {
    return {
      id: rr.id,
      rating: rr.rating || 0,
      userRating: rr.userRating || 'RATE_UP',
      mediaRecommendation: rr.target,
      user: authUserId() || 0,
    };
  }

  // The same recommendation seen from the other side (on the target's page
  // the card points back at the custom entry it was made from).
  function recBacklinkEntity(rec, rr) {
    return {
      id: rr.id,
      rating: rr.rating || 0,
      userRating: rr.userRating || 'RATE_UP',
      mediaRecommendation: rec.id,
      user: authUserId() || 0,
    };
  }

  function recTargetMediaEntity(rr) {
    if (isCustomId(rr.target)) {
      const t = recById(rr.target);
      return t ? mediaEntity(t) : null;
    }
    return rr.media || { id: rr.target, title: { userPreferred: '#' + rr.target } };
  }

  // Response-side page entity: pageData is a PLAIN array of recommendation
  // ids. The store's merge layer nests it under the page number itself
  // (stored form: pageData: { "1": [...] }); emitting the stored form from a
  // response double-nests it and crashes the recommendations getter.
  function recPageEntity(rec) {
    const ids = (rec.recs || []).map((r) => r.id);
    return { pageInfo: { total: ids.length }, pageData: ids };
  }

  // Compact media stub from the Vuex store (the Add Recommendation search
  // just normalized the picked media into it).
  function mediaStubFromStore(id) {
    const store = vueStore();
    const m = store && store.state.entities.media && store.state.entities.media[id];
    if (!m) return null;
    const cov = m.coverImage || {};
    return {
      id: m.id,
      title: { userPreferred: (m.title && m.title.userPreferred) || ('#' + id) },
      type: m.type || null,
      format: m.format || null,
      status: m.status || null,
      bannerImage: m.bannerImage || null,
      coverImage: { large: cov.large || cov.medium || null, medium: cov.medium || cov.large || null },
      isAdult: !!m.isAdult,
    };
  }

  // Rich media entity + page entities for the media page (best effort).
  function richMediaResult(rec) {
    const id = rec.id;
    const pageKeys = [
      'mediaCharacterPreview', 'mediaStaffPreview', 'mediaReviewPreview',
      'mediaCharacters', 'mediaStaff', 'mediaReviews', 'mediaRecommendations',
      'mediaTrends', 'mediaAiringTrends',
    ];
    const emptyPage = () => ({
      pageInfo: { total: 0, perPage: 25, currentPage: 1, lastPage: 1, hasNextPage: false },
      pageData: [],
    });
    const media = Object.assign({
      description: rec.media.description || '<i>Custom entry (local only).</i>',
      season: null, seasonYear: null, duration: null,
      endDate: { year: null, month: null, day: null },
      source: null, hashtag: null, trailer: null,
      updatedAt: Math.floor(Date.now() / 1000),
      genres: [], synonyms: [], tags: [], rankings: [],
      averageScore: null, meanScore: null, popularity: 0, favourites: 0,
      isLocked: false, isLicensed: true, isRecommendationBlocked: false,
      isReviewBlocked: false, isFavouriteBlocked: false,
      nextAiringEpisode: null, externalLinks: [], streamingEpisodes: [],
      relations: { edges: [] },
      studios: { edges: [] },
      stats: { statusDistribution: [], scoreDistribution: [] },
      distribution: { status: [], score: [] },
      trends: { nodes: [] }, airingTrends: { nodes: [] },
    }, mediaEntity(rec));
    const page = {};
    for (const key of pageKeys) page[key + '-' + id] = emptyPage();
    media.characterPreview = 'mediaCharacterPreview-' + id;
    media.staffPreview = 'mediaStaffPreview-' + id;
    media.reviewPreview = 'mediaReviewPreview-' + id;
    const reviewEntities = {};
    const reviewUsers = {};
    const myReviews = (rec.reviews || []).filter((rv) => !rv.private || rv.userId === authUserId());
    if (myReviews.length) {
      const ids = myReviews.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0) || b.id - a.id).map((rv) => rv.id);
      for (const rv of myReviews) { reviewEntities[rv.id] = reviewEntity(rec, rv); reviewUsers[rv.userId] = activityUserEntity(rv.userId); }
      const info = { total: ids.length, perPage: 25, currentPage: 1, lastPage: 1, hasNextPage: false };
      page['mediaReviewPreview-' + id] = { pageInfo: info, pageData: ids };
      page['mediaReviews-' + id] = { pageInfo: info, pageData: ids };
    }
    media.characters = 'mediaCharacters-' + id;
    media.staff = 'mediaStaff-' + id;
    media.reviews = 'mediaReviews-' + id;
    media.recommendations = 'mediaRecommendations-' + id;

    // Custom characters -> character entities + page edges (what the
    // entityPagePreview getter and the Characters tab read).
    const characterEntities = {};
    const chars = rec.characters || [];
    if (chars.length) {
      const edges = chars.map((c) => ({
        id: c.id,
        role: c.role || 'MAIN',
        name: null,
        voiceActors: [],
        voiceActorRoles: [],
        node: c.id,
      }));
      for (const c of chars) {
        const img = c.image || DEFAULT_CHAR_IMG;
        const parts = charPartsOf(c);
        characterEntities[c.id] = {
          id: c.id,
          name: { userPreferred: parts.userPreferred, full: parts.full, native: null },
          image: { large: img, medium: img },
          isFavourite: !!c.isFavourite,
          isFavouriteBlocked: false,
          favourites: 0,
        };
      }
      const info = { total: chars.length, perPage: 25, currentPage: 1, lastPage: 1, hasNextPage: false };
      page['mediaCharacterPreview-' + id] = { pageInfo: info, pageData: edges };
      page['mediaCharacters-' + id] = { pageInfo: info, pageData: edges };
    }

    // Staff links -> staff entities + page edges (overview Staff section and
    // the Staff tab), same convention as characters above.
    const staffEntities = {};
    const staffLinks = rec.staff || [];
    if (staffLinks.length) {
      const edges = staffLinks.map((s) => ({ id: s.id, role: s.role || '', node: s.staffId }));
      for (const s of staffLinks) staffEntities[s.staffId] = staffEntityOf(s);
      const info = { total: edges.length, perPage: 25, currentPage: 1, lastPage: 1, hasNextPage: false };
      page['mediaStaffPreview-' + id] = { pageInfo: info, pageData: edges };
      page['mediaStaff-' + id] = { pageInfo: info, pageData: edges };
    }

    const studioEntities = {};
    const studioLinks = studiosOf(rec);
    if (studioLinks.length) {
      for (const st of studioLinks) {
        studioEntities[st.studioId] = { id: st.studioId, name: st.name || 'Studio #' + st.studioId, isAnimationStudio: st.isAnimationStudio !== false, isFavourite: !!(db.favStudios && db.favStudios[st.studioId]) };
      }
      media.studios = { edges: studioLinks.map((st) => ({ id: st.id, isMain: !!st.isMain, node: st.studioId })) };
    }

    const recommendationEntities = {};
    const mediaEntities = { [id]: media };

    // Relations render from media.relations.edges; targets reuse the same
    // {target, media} stub convention as recommendations. Processed before
    // recommendations: relation cards show a format/status footer, so when a
    // series is both a relation and a rec, the richer stub must win.
    if (rec.relations && rec.relations.length) {
      media.relations = {
        edges: rec.relations.map((rl) => ({ id: rl.id, relationType: rl.type, node: rl.target })),
      };
      for (const rl of rec.relations) {
        const tm = recTargetMediaEntity(rl);
        if (tm && !mediaEntities[tm.id]) mediaEntities[tm.id] = tm;
      }
    }

    // Own recommendations, then the inverse of recommendations other custom
    // entries made towards this one (a pair is stored once, on the entry it
    // was made from, and shown on both pages like on AniList).
    const inverseRecs = customRecsTo(id).filter(({ rec: a }) => a.id !== id && !(rec.recs || []).some((x) => x.target === a.id));
    if ((rec.recs && rec.recs.length) || inverseRecs.length) {
      const pg = recPageEntity(rec);
      page['mediaRecommendations-' + id] = pg;
      for (const rr of rec.recs || []) {
        recommendationEntities[rr.id] = recRecEntity(rr);
        const tm = recTargetMediaEntity(rr);
        if (tm && !mediaEntities[tm.id]) mediaEntities[tm.id] = tm;
      }
      for (const { rec: a, rr } of inverseRecs) {
        pg.pageData.push(rr.id);
        recommendationEntities[rr.id] = recBacklinkEntity(a, rr);
        if (!mediaEntities[a.id]) mediaEntities[a.id] = mediaEntity(a);
      }
      pg.pageInfo.total = pg.pageData.length;
    }

    return {
      result: id,
      entities: {
        media: mediaEntities,
        listEntry: recIsListed(rec) ? { [rec.entry.id]: entryEntity(rec) } : {},
        user: Object.assign({ [rec.ownerId]: userEntity(rec.ownerId) }, reviewUsers),
        character: characterEntities,
        staff: staffEntities,
        studio: studioEntities,
        recommendation: recommendationEntities,
        review: reviewEntities,
        page,
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * Local activity feed (client-side ListActivity records)
   * ------------------------------------------------------------------ */

  const DEFAULT_AVATAR = 'https://s4.anilist.co/file/anilistcdn/user/avatar/large/default.png';
  // AniList merges consecutive progress updates on the same media into one
  // activity ("watched episode 3 - 5") while they're recent; mirror that.
  const ACTIVITY_MERGE_WINDOW = 3 * 3600;

  const allActivities = () => Object.values(db.activities)
    .sort((x, y) => y.createdAt - x.createdAt || y.id - x.id);
  const activityById = (v) => db.activities[parseInt(v, 10)] || null;

  // Normalized ListActivity entity (shape observed in feed responses).
  function activityEntity(a) {
    return {
      id: a.id,
      userId: a.ownerId,
      type: a.type,
      status: a.status,
      progress: a.progress,
      replyCount: a.replyCount || 0,
      isLocked: false,
      isSubscribed: a.isSubscribed !== false,
      isLiked: !!a.isLiked,
      likeCount: a.likeCount || 0,
      createdAt: a.createdAt,
      user: a.ownerId,
      media: a.mediaId,
    };
  }

  // Rich user entity for feed rendering (avatar, donator badge…). The feed's
  // own responses carry this for real activities; for injected ones we build
  // it from the auth blob AniList keeps in localStorage.
  /* --- local revision history (edit page's "Revision History" section) ---
   * rec.history = [{id, action: CREATE|EDIT, changes: {field: value|
   * "Modified"}, createdAt, userId}], newest last, capped. Served in the
   * site's revisionHistory shape; entries without a log get a synthetic
   * CREATE row from their creation time. --- */
  const HISTORY_CAP = 200;
  const revisionValue = (v) => {
    if (v === null || v === undefined) return 'Modified';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    if (typeof v === 'string') return v.length <= 60 && !/[<>]/.test(v) ? v : 'Modified';
    return 'Modified';
  };
  function logRevision(rec, action, changes) {
    if (!rec) return;
    rec.history = rec.history || [];
    db.seq += 1;
    rec.history.push({ id: ID_BASE + db.seq, action, changes: changes || {}, createdAt: nowSec(), userId: authUserId() || rec.ownerId });
    if (rec.history.length > HISTORY_CAP) rec.history.splice(0, rec.history.length - HISTORY_CAP);
  }
  function revisionHistoryResult(rec, vars) {
    const perPage = 50;
    const page = Math.max(1, parseInt(vars.page, 10) || 1);
    let items = (rec.history || []).slice();
    if (!items.length) {
      items = [{ id: rec.id, action: 'CREATE', changes: {}, createdAt: (rec.entry && rec.entry.createdAt) || rec.updatedAt || nowSec(), userId: rec.ownerId }];
    }
    items.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    const total = items.length;
    const lastPage = Math.max(1, Math.ceil(total / perPage));
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const cov = rec.media.coverImage || {};
    const media = { id: rec.id, type: rec.type, title: { userPreferred: rec.media.title.userPreferred }, coverImage: { medium: cov.medium || cov.large || null } };
    return {
      Page: {
        pageInfo: { total, perPage, currentPage: page, lastPage, hasNextPage: page < lastPage },
        revisionHistory: slice.map((h) => {
          const u = activityUserEntity(h.userId);
          return {
            id: h.id, action: h.action, changes: h.changes || {}, createdAt: h.createdAt,
            user: { id: u.id, name: u.name, avatar: { medium: (u.avatar && u.avatar.large) || DEFAULT_AVATAR } },
            media, character: null, staff: null, studio: null, externalLink: null,
          };
        }),
      },
    };
  }

  function activityUserEntity(ownerId) {
    let auth = null;
    try { auth = JSON.parse(localStorage.getItem('auth')); } catch (e) { /* ignore */ }
    if (auth && auth.id === ownerId) {
      return {
        id: ownerId,
        name: auth.name,
        nameId: auth.nameId || String(auth.name || '').toLowerCase(),
        donatorTier: auth.donatorTier || 0,
        donatorBadge: auth.donatorBadge || 'Donator',
        moderatorRoles: auth.moderatorRoles || null,
        avatar: auth.avatar || { large: DEFAULT_AVATAR },
      };
    }
    const owner = db.owners[ownerId];
    const name = owner ? owner.name : '?';
    return {
      id: ownerId, name, nameId: String(name).toLowerCase(),
      donatorTier: 0, donatorBadge: 'Donator', moderatorRoles: null,
      avatar: { large: DEFAULT_AVATAR },
    };
  }

  // Mirror the server's activity generation on a list save: one ListActivity
  // per status transition or progress increase, using AniList's exact status
  // strings, with recent progress updates merged into a "first - last" range.
  function recordListActivity(rec, prevStatus, prevProgress) {
    const e = rec.entry;
    const anime = rec.type === 'ANIME';
    const now = Math.floor(Date.now() / 1000);
    // Progress on a Completed entry is a correction, not reading/watching:
    // no "read chapter N of X" for it. Without this, an entry created as
    // Completed got one next to its "completed X" as soon as the native
    // editor (or the completion auto-fill) set its progress.
    const progressed = e.status !== 'COMPLETED'
      && typeof e.progress === 'number' && e.progress > (prevProgress || 0);
    const progressStatus = () => (e.status === 'REPEATING'
      ? (anime ? 'rewatched episode' : 'reread chapter')
      : (anime ? 'watched episode' : 'read chapter'));
    let status = null;
    let progress = null;
    if (e.status !== prevStatus) {
      switch (e.status) {
        case 'COMPLETED': status = 'completed'; break;
        case 'PLANNING': status = anime ? 'plans to watch' : 'plans to read'; break;
        case 'PAUSED': status = anime ? 'paused watching' : 'paused reading'; break;
        case 'DROPPED': status = 'dropped'; break;
        case 'CURRENT':
        case 'REPEATING':
          if (progressed) { status = progressStatus(); progress = String(e.progress); }
          break;
        default: break;
      }
    } else if (progressed) {
      status = progressStatus();
      progress = String(e.progress);
    }
    if (!status) return;

    const latest = allActivities().find((a) => a.mediaId === rec.id);
    const recent = latest && latest.status === status
      && now - latest.createdAt < ACTIVITY_MERGE_WINDOW;
    if (recent && progress !== null) {
      const first = String(latest.progress || '').split(' - ')[0] || progress;
      latest.progress = first === progress ? progress : `${first} - ${progress}`;
      latest.createdAt = now;
      saveDB();
      pushActivityLive(latest, false);
      console.log(TAG, 'merged local activity', latest.status, latest.progress);
      return;
    }
    if (recent && latest.progress === progress) return; // identical re-save

    db.seq += 1;
    const a = {
      id: ID_BASE + db.seq,
      ownerId: rec.ownerId,
      mediaId: rec.id,
      type: anime ? 'ANIME_LIST' : 'MANGA_LIST',
      status,
      progress,
      replyCount: 0, likeCount: 0, isLiked: false, isLocked: false, isSubscribed: true,
      createdAt: now,
    };
    db.activities[a.id] = a;
    saveDB();
    pushActivityLive(a, true);
    console.log(TAG, 'recorded local activity:', status, progress || '', '-', rec.media.title.userPreferred);
  }

  function deleteActivitiesFor(rec) {
    for (const a of allActivities()) {
      if (a.mediaId === rec.id) {
        markDeleted(a.id);
        delete db.activities[a.id];
        removeActivityLive(a);
      }
    }
    saveDB();
  }

  /* --- local replies on local activities --- */

  function authUserId() {
    try {
      const auth = JSON.parse(localStorage.getItem('auth'));
      if (auth && auth.id) return auth.id;
    } catch (e) { /* ignore */ }
    return null;
  }

  // Minimal, safe text -> HTML for locally stored reply text (the real API
  // returns markdown rendered to HTML; we only support plain text + breaks).
  function renderReplyText(text) {
    const esc = String(text || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<p>' + esc.replace(/\n/g, '<br>') + '</p>';
  }

  function findReply(id) {
    const rid = parseInt(id, 10);
    for (const a of Object.values(db.activities)) {
      const r = (a.replies || []).find((r) => r.id === rid);
      if (r) return { a, r };
    }
    return null;
  }

  // Normalized ActivityReply entity (fields the reply list query selects).
  function replyEntity(a, r) {
    return {
      id: r.id,
      userId: r.userId,
      activityId: a.id,
      text: renderReplyText(r.text),
      createdAt: r.createdAt,
      isLiked: !!r.isLiked,
      likeCount: r.likeCount || 0,
      user: r.userId,
    };
  }

  // Normalized result for the reply-list query of a local activity.
  function activityRepliesResult(a, vars) {
    const replies = a.replies || [];
    const pageKey = 'activityReplies-' + a.id;
    const entities = { activityReply: {}, user: {}, page: {} };
    const ids = [];
    for (const r of replies) {
      entities.activityReply[r.id] = replyEntity(a, r);
      if (!entities.user[r.userId]) entities.user[r.userId] = activityUserEntity(r.userId);
      ids.push(r.id);
    }
    entities.page[pageKey] = {
      pageInfo: {
        total: replies.length, perPage: 25,
        currentPage: (vars && vars.page) || 1, lastPage: 1, hasNextPage: false,
      },
      pageData: ids,
    };
    return { result: pageKey, entities };
  }

  // Create or edit a reply on a local activity; returns the reply record.
  function saveLocalReply(a, vars) {
    let r = vars.id !== undefined && vars.id !== null
      ? (a.replies || []).find((x) => x.id === parseInt(vars.id, 10)) : null;
    if (!r) {
      db.seq += 1;
      r = {
        id: ID_BASE + db.seq,
        userId: authUserId() || a.ownerId,
        text: '',
        createdAt: Math.floor(Date.now() / 1000),
        likeCount: 0, isLiked: false,
      };
      a.replies = a.replies || [];
      a.replies.push(r);
    }
    if (vars.text !== undefined) r.text = vars.text;
    a.replyCount = a.replies.length;
    touchAct(a);
    saveDB();
    syncReplyLive(a, r);
    console.log(TAG, 'saved local reply on activity', a.id);
    return r;
  }

  function deleteLocalReply(a, r) {
    a.replies = (a.replies || []).filter((x) => x.id !== r.id);
    a.replyCount = a.replies.length;
    touchAct(a);
    saveDB();
    syncReplyLive(a, null);
    const store = vueStore();
    if (store) {
      const ents = entitiesState(store);
      const pg = ents && ents.page && ents.page['activityReplies-' + a.id];
      const arr = pg && pg.pageData && pg.pageData[1];
      if (Array.isArray(arr)) {
        const i = arr.indexOf(r.id);
        if (i >= 0) arr.splice(i, 1);
      }
    }
  }

  // Commit a reply (and the bumped replyCount) into the store so open reply
  // lists update without a refetch.
  function syncReplyLive(a, r) {
    const store = vueStore();
    if (!store) return;
    const ents = entitiesState(store);
    if (!ents) return;
    const patch = { activity: { [a.id]: activityEntity(a) } };
    if (r) {
      patch.activityReply = { [r.id]: replyEntity(a, r) };
      if (!(ents.user && ents.user[r.userId])) {
        patch.user = { [r.userId]: activityUserEntity(r.userId) };
      }
    }
    try { store.commit('setEntities', patch); }
    catch (e) { return; }
    if (!r) return;
    const pg = ents.page && ents.page['activityReplies-' + a.id];
    const arr = pg && pg.pageData && pg.pageData[1];
    if (Array.isArray(arr) && !arr.includes(r.id)) arr.push(r.id);
  }

  // Full result for the /activity/<id> permalink page of a local activity.
  /* --- local reviews: rec.reviews = [{id, userId, summary, body, score,
   * private, createdAt, updatedAt, rating (up votes), ratingAmount (votes),
   * userRating}]. Written by AniList's own review editor (SaveReview on a
   * custom media id), rated and deleted natively, shown on the media page
   * (preview + Reviews tab), the profile's Reviews tab and /review/<id>. --- */
  function findReview(reviewId) {
    for (const rec of allRecs()) {
      const rv = (rec.reviews || []).find((x) => x.id === reviewId);
      if (rv) return { rec, rv };
    }
    return null;
  }
  function reviewEntity(rec, rv) {
    return {
      id: rv.id, summary: rv.summary || '', body: rv.body || '', rating: rv.rating || 0, ratingAmount: rv.ratingAmount || 0,
      userRating: rv.userRating || 'NO_VOTE', score: rv.score || 0, private: !!rv.private,
      createdAt: rv.createdAt, updatedAt: rv.updatedAt || rv.createdAt, siteUrl: location.origin + '/review/' + rv.id,
      user: rv.userId, media: rec.id,
    };
  }
  function reviewResult(rec, rv) {
    return {
      result: rv.id,
      entities: {
        review: { [rv.id]: reviewEntity(rec, rv) },
        user: { [rv.userId]: activityUserEntity(rv.userId) },
        media: { [rec.id]: mediaEntity(rec) },
      },
    };
  }
  function handleSaveReview(vars) {
    const id = isCustomId(vars.id) ? parseInt(vars.id, 10) : null;
    const hit = id ? findReview(id) : null;
    const rec = hit ? hit.rec : (isCustomId(vars.mediaId) ? recById(parseInt(vars.mediaId, 10)) : null);
    if (!rec) return { result: null, entities: {} };
    rec.reviews = rec.reviews || [];
    const uid = authUserId() || rec.ownerId;
    let rv = hit ? hit.rv : rec.reviews.find((x) => x.userId === uid);
    const now = nowSec();
    if (!rv) {
      db.seq += 1;
      rv = { id: ID_BASE + db.seq, userId: uid, summary: '', body: '', score: 0, private: false, createdAt: now, updatedAt: now, rating: 0, ratingAmount: 0, userRating: 'NO_VOTE' };
      rec.reviews.push(rv);
    }
    if (vars.summary !== undefined) rv.summary = String(vars.summary || '');
    if (vars.body !== undefined) rv.body = String(vars.body || '');
    if (vars.score !== undefined) rv.score = parseInt(vars.score, 10) || 0;
    if (vars.private !== undefined) rv.private = !!vars.private;
    rv.updatedAt = now;
    touchRec(rec);
    saveDB();
    pushRecEntities(rec);
    console.log(TAG, 'saved local review', rv.id, 'on', rec.id);
    return reviewResult(rec, rv);
  }
  function handleRateReview(vars) {
    const hit = findReview(parseInt(vars.id !== undefined ? vars.id : vars.reviewId, 10));
    if (!hit) return { result: null, entities: {} };
    const { rec, rv } = hit;
    const prev = rv.userRating || 'NO_VOTE';
    const next = String(vars.rating || 'NO_VOTE');
    // One voter: up votes and the vote count follow the viewer's own vote.
    if (prev === 'UP_VOTE') rv.rating = Math.max(0, (rv.rating || 0) - 1);
    if (prev !== 'NO_VOTE') rv.ratingAmount = Math.max(0, (rv.ratingAmount || 0) - 1);
    if (next === 'UP_VOTE') rv.rating = (rv.rating || 0) + 1;
    if (next !== 'NO_VOTE') rv.ratingAmount = (rv.ratingAmount || 0) + 1;
    rv.userRating = next;
    touchRec(rec);
    saveDB();
    return reviewResult(rec, rv);
  }
  function handleDeleteReview(vars) {
    const hit = findReview(parseInt(vars.id, 10));
    if (hit) {
      hit.rec.reviews = hit.rec.reviews.filter((x) => x.id !== hit.rv.id);
      touchRec(hit.rec);
      saveDB();
      pushRecEntities(hit.rec);
    }
    return { result: null, entities: {} };
  }
  // Profile Reviews tab: prepend the user's local reviews on page 1.
  function patchUserReviews(result, meta) {
    const ents = result.entities;
    const pg = ents && ents.page && ents.page[meta.pageId];
    if (!pg || !Array.isArray(pg.pageData) || (meta.vars.page || 1) !== 1) return;
    const uid = parseInt(meta.userId, 10);
    const mine = [];
    for (const rec of allRecs()) for (const rv of rec.reviews || []) if (rv.userId === uid && !rv.private) mine.push({ rec, rv });
    if (!mine.length) return;
    mine.sort((a, b) => b.rv.createdAt - a.rv.createdAt);
    ents.review = ents.review || {};
    ents.media = ents.media || {};
    ents.user = ents.user || {};
    for (let i = mine.length - 1; i >= 0; i--) {
      const { rec, rv } = mine[i];
      if (pg.pageData.includes(rv.id)) continue;
      pg.pageData.unshift(rv.id);
      ents.review[rv.id] = reviewEntity(rec, rv);
      ents.media[rec.id] = mediaEntity(rec);
      if (!ents.user[rv.userId]) ents.user[rv.userId] = activityUserEntity(rv.userId);
      if (pg.pageInfo && typeof pg.pageInfo.total === 'number') pg.pageInfo.total += 1;
    }
  }

  function activityDetailResult(a) {
    const rec = recById(a.mediaId);
    const replies = a.replies || [];
    const users = { [a.ownerId]: activityUserEntity(a.ownerId) };
    const replyEnts = {};
    for (const r of replies) {
      replyEnts[r.id] = replyEntity(a, r);
      if (!users[r.userId]) users[r.userId] = activityUserEntity(r.userId);
    }
    return {
      result: a.id,
      entities: {
        activity: {
          [a.id]: Object.assign(activityEntity(a), {
            replies: replies.map((r) => r.id),
            likes: [],
          }),
        },
        activityReply: replyEnts,
        user: users,
        media: rec ? { [rec.id]: mediaEntity(rec) } : {},
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * RPC handlers (respond without touching the network)
   * ------------------------------------------------------------------ */

  // Mirror the AniList API's server-side behaviour on a status change:
  // Completed on a finished series fills progress to the episode/chapter
  // (and volume) count and stamps today's start/finish dates; starting
  // stamps the start date. `status` undefined (not sent) is a no-op.
  function applyStatusEffects(rec, status) {
    const e = rec.entry;
    const today = () => {
      const d = new Date();
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
    };
    if (status === 'COMPLETED' && rec.media.status === 'FINISHED') {
      const maxProgress = rec.type === 'ANIME' ? rec.media.episodes : rec.media.chapters;
      if (maxProgress) e.progress = maxProgress;
      if (rec.type === 'MANGA' && rec.media.volumes) e.progressVolumes = rec.media.volumes;
      if (!e.completedAt || !e.completedAt.year) e.completedAt = today();
      if (!e.startedAt || !e.startedAt.year) e.startedAt = today();
    }
    if (status === 'CURRENT' && (!e.startedAt || !e.startedAt.year)) {
      e.startedAt = today();
    }
  }

  function handleSave(vars) {
    const rec = recById(vars.id) || recById(vars.mediaId);
    if (!rec) return { result: null, entities: {} };
    const e = rec.entry;
    const prevStatus = e.status;
    const prevProgress = e.progress;
    for (const k of ['status', 'score', 'progress', 'progressVolumes', 'repeat',
      'private', 'notes', 'hiddenFromStatusLists', 'advancedScores',
      'startedAt', 'completedAt']) {
      if (vars[k] !== undefined) e[k] = vars[k];
    }
    if (vars.customLists !== undefined && vars.customLists !== null) {
      const opts = ownerOpts(rec);
      const listOpts = opts ? (rec.type === 'ANIME' ? opts.animeList : opts.mangaList) : null;
      const known = (listOpts && listOpts.customLists) || [];
      const map = {};
      for (const name of known) map[name] = false;
      for (const name of vars.customLists) map[name] = true;
      e.customLists = map;
    }
    applyStatusEffects(rec, vars.status);
    e.updatedAt = Math.floor(Date.now() / 1000);
    saveDB();
    recordListActivity(rec, prevStatus, prevProgress);
    setTimeout(() => { syncSections(rec); syncHomePreview(rec); }, 60);
    console.log(TAG, 'saved custom entry', rec.id, e);
    return {
      result: rec.entry.id,
      entities: {
        listEntry: { [rec.entry.id]: entryEntity(rec) },
        media: { [rec.id]: mediaEntity(rec) },
        user: { [rec.ownerId]: userEntity(rec.ownerId) },
      },
    };
  }

  function handleDelete(vars) {
    const rec = recById(vars.id);
    if (rec) {
      markDeleted(rec.id);
      delete db.entries[rec.id];
      deleteActivitiesFor(rec);
      saveDB();
      setTimeout(() => { syncSections(rec, true); syncHomePreview(rec, true); }, 60);
      console.log(TAG, 'deleted custom entry', rec.id);
    }
    return { DeleteMediaListEntry: { deleted: true } };
  }

  function handleFav(vars) {
    const id = parseInt(Object.values(vars).find(isCustomId), 10);
    const rec = recById(id);
    if (rec) {
      rec.media.isFavourite = !rec.media.isFavourite;
      touchRec(rec);
      saveDB();
      console.log(TAG, 'toggled favourite', rec.id, rec.media.isFavourite);
    } else {
      const owner = findCharOwner(id);
      if (owner) {
        owner.c.isFavourite = !owner.c.isFavourite;
        touchRec(owner.rec);
        saveDB();
        console.log(TAG, 'toggled character favourite', id, owner.c.isFavourite);
      } else {
        const links = staffLinksFor(id);
        if (links.length) {
          const fav = !links[0].s.isFavourite;
          for (const { rec, s: st } of links) { st.isFavourite = fav; touchRec(rec); }
          saveDB();
          console.log(TAG, 'toggled staff favourite', id, fav);
        } else if (customEntriesWithStudio(id).length) {
          db.favStudios = db.favStudios || {};
          if (db.favStudios[id]) delete db.favStudios[id]; else db.favStudios[id] = true;
          saveDB();
          console.log(TAG, 'toggled studio favourite', id, !!db.favStudios[id]);
        }
      }
    }
    const c = { pageInfo: { total: 0 } };
    return { ToggleFavourite: { anime: c, manga: c, characters: c, staff: c, studios: c } };
  }

  function handleMediaQuery(mid) {
    const rec = recById(mid);
    if (!rec) return { result: null, entities: {} };
    return richMediaResult(rec);
  }

  // SaveRecommendation on a custom entry: upsert into rec.recs (repeated
  // ratings on the same pair update it) and answer with the shapes the
  // recommendation card expects, so no "Internal Server Error" toast.
  // Rated from the other side (a real page's backlink card, or the inverse
  // card on another custom entry's page), the pair is still stored once: on
  // the custom entry it was made from, or on the custom entry being rated
  // when the page's media is real.
  function handleSaveRecommendation(vars) {
    const mid = parseInt(vars.mediaId, 10);
    const tid = parseInt(vars.mediaRecommendationId, 10);
    const a = recById(mid);
    const b = isCustomId(tid) ? recById(tid) : null;
    let rec = a;
    let target = tid;
    let flipped = false;
    if (b && (!a || (!(a.recs || []).some((x) => x.target === tid) && (b.recs || []).some((x) => x.target === mid)))) {
      rec = b; target = mid; flipped = true;
    }
    if (!rec) return { result: null, entities: {} };
    if (!Number.isFinite(target) || target === rec.id) return { result: null, entities: {} };
    rec.recs = rec.recs || [];
    let rr = rec.recs.find((x) => x.target === target);
    if (!rr) {
      db.seq += 1;
      rr = { id: ID_BASE + db.seq, target, media: null };
      rec.recs.push(rr);
    }
    rr.userRating = vars.rating || 'RATE_UP';
    rr.rating = rr.userRating === 'RATE_UP' ? 1 : (rr.userRating === 'RATE_DOWN' ? -1 : 0);
    if (!isCustomId(target)) rr.media = mediaStubFromStore(target) || rr.media;
    touchRec(rec);
    saveDB();
    console.log(TAG, 'saved local recommendation', rec.id, '->', target, rr.userRating, flipped ? '(from the target page)' : '');
    const uid = authUserId();
    if (flipped) {
      // The page being viewed is the target: the card points back at `rec`.
      // No page entity: the app prepends a new card into the current page
      // itself (from the response's recommendation key).
      const entities = { recommendation: { [rr.id]: recBacklinkEntity(rec, rr) }, media: { [rec.id]: mediaEntity(rec) } };
      if (uid) entities.user = { [uid]: userEntity(uid) };
      return { result: rr.id, entities };
    }
    // A new pair is prepended into the page by the app itself (vars.new), so
    // the page entity is only returned for rating updates.
    const entities = { recommendation: { [rr.id]: recRecEntity(rr) } };
    if (!vars.new) entities.page = { ['mediaRecommendations-' + rec.id]: recPageEntity(rec) };
    const tm = recTargetMediaEntity(rr);
    if (tm) entities.media = { [tm.id]: tm };
    if (uid) entities.user = { [uid]: userEntity(uid) };
    return { result: rr.id, entities };
  }

  // DeleteRecommendation on a local recommendation id (the card's delete
  // control, from either side): drop it from whichever custom entry holds it.
  function handleDeleteRecommendation(vars) {
    const rid = parseInt(vars.id, 10);
    for (const rec of allRecs()) {
      const i = (rec.recs || []).findIndex((x) => x.id === rid);
      if (i === -1) continue;
      rec.recs.splice(i, 1);
      touchRec(rec);
      saveDB();
      console.log(TAG, 'deleted local recommendation', rid, 'from', rec.id);
      break;
    }
    return { DeleteRecommendation: { deleted: true } };
  }

  // Normalized result for the character page (/character/<id>) of a custom
  // character: the character entity plus its appearance in the parent media.
  function characterPageResult(cid, vars) {
    const owner = findCharOwner(cid);
    if (!owner) return { result: null, entities: {} };
    const rec = owner.rec;
    const c = owner.c;
    const img = c.image || DEFAULT_CHAR_IMG;
    const parts = charPartsOf(c);
    const pageKey = 'characterMediaRoles-' + cid;
    return {
      result: cid,
      entities: {
        character: {
          [cid]: {
            id: cid,
            name: {
              first: parts.first, middle: null, last: parts.last,
              full: parts.full, native: null, userPreferred: parts.userPreferred,
              alternative: [], alternativeSpoiler: [],
            },
            image: { large: img, medium: img },
            favourites: 0,
            isFavourite: !!c.isFavourite,
            isFavouriteBlocked: false,
            description: c.description ? sanitizeHtml(c.description) : null,
            age: c.age || null,
            gender: c.gender || null,
            bloodType: null,
            dateOfBirth: { year: null, month: null, day: null },
            media: pageKey,
          },
        },
        media: { [rec.id]: mediaEntity(rec) },
        page: {
          [pageKey]: {
            pageInfo: { total: 1, perPage: 25, currentPage: (vars && vars.page) || 1, lastPage: 1, hasNextPage: false },
            pageData: [{
              id: cid,
              characterRole: c.role || 'MAIN',
              voiceActorRoles: [],
              node: rec.id,
            }],
          },
        },
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * Native submission editor (/edit/<type>/<id>) support
   * ------------------------------------------------------------------ */

  // rec for the custom entry being edited on AniList's own edit page, if any.
  function editPageRec() {
    const m = location.pathname.match(/^\/edit\/(anime|manga)\/(\d+)/);
    return m && isCustomId(parseInt(m[2], 10)) ? recById(parseInt(m[2], 10)) : null;
  }

  // Raw Media shape the edit form's fetchMedia expects (setMedia reads
  // media.id, media.studios.edges, media.relations.edges, media.externalLinks).
  function editMediaShape(rec) {
    const md = rec.media;
    const t = md.title || {};
    return {
      id: rec.id,
      title: { romaji: t.romaji || t.userPreferred || null, english: t.english || null, native: t.native || null },
      coverImage: { extraLarge: md.coverImage.extraLarge, large: md.coverImage.large, color: null },
      bannerImage: md.bannerImage || null,
      startDate: md.startDate || { year: null, month: null, day: null },
      endDate: md.endDate || { year: null, month: null, day: null },
      description: md.description || null,
      season: md.season !== undefined ? md.season : null,
      type: md.type,
      format: md.format,
      status: md.status,
      episodes: md.episodes || null,
      duration: md.duration !== undefined ? md.duration : null,
      chapters: md.chapters || null,
      volumes: md.volumes || null,
      genres: md.genres || [],
      synonyms: md.synonyms || [],
      source: md.source !== undefined ? md.source : null,
      isAdult: !!md.isAdult,
      isLicensed: md.isLicensed !== undefined ? md.isLicensed : true,
      isLocked: false,
      isRecommendationBlocked: false,
      isFavouriteBlocked: false,
      isReviewBlocked: false,
      autoCreateForumThread: false,
      hashtag: md.hashtag || null,
      countryOfOrigin: md.countryOfOrigin || 'JP',
      modNotes: null,
      idMal: null,
      trailer: null,
      relations: {
        edges: (rec.relations || []).map((rl) => {
          const tm = recTargetMediaEntity(rl) || {};
          const cov = tm.coverImage || {};
          return {
            id: rl.id,
            relationType: rl.type,
            media: {
              id: rl.target,
              title: { userPreferred: (tm.title && tm.title.userPreferred) || ('#' + rl.target) },
              type: tm.type || rec.type,
              format: tm.format || null,
              startDate: { year: (tm.startDate && tm.startDate.year) || null },
              coverImage: { medium: cov.medium || cov.large || null },
            },
          };
        }),
      },
      studios: {
        edges: studiosOf(rec).map((st) => ({ id: st.id, isMain: !!st.isMain, studio: { id: st.studioId, name: st.name || 'Studio #' + st.studioId } })),
      },
      externalLinks: (md.externalLinks || []).map((l) => ({
        id: l.id, site: l.site, siteId: l.siteId, url: l.url, type: l.type || 'INFO',
        language: l.language || null, notes: l.notes || null, isDisabled: !!l.isDisabled,
      })),
    };
  }

  // Edit page "Add Relation" (SaveMediaRelation on Submit): one edge per
  // target, keyed the same way as the MangaBaka-fetched ones (rec.relations
  // = [{id, type, target, media: stub}]), so the media page's Relations
  // section and the quick-edit panel list them alike. Custom targets get
  // the reciprocal edge, real targets a media stub (from the store, where
  // the picker just normalized it, else fetched).
  function handleSaveMediaRelation(vars, ctxRec) {
    const rec = isCustomId(vars.mediaId) ? recById(parseInt(vars.mediaId, 10)) : ctxRec;
    const target = vars.relationId !== undefined && vars.relationId !== null ? parseInt(vars.relationId, 10) : null;
    if (!rec || !target || target === rec.id) return { SaveMediaRelation: true };
    rec.relations = rec.relations || [];
    const type = String(vars.relationType || 'OTHER');
    let edge = rec.relations.find((x) => x.target === target);
    if (edge) {
      edge.type = type;
    } else {
      db.seq += 1;
      edge = { id: ID_BASE + db.seq, type, target, media: isCustomId(target) ? null : mediaStubFromStore(target) };
      rec.relations.push(edge);
      const targetRec = isCustomId(target) ? recById(target) : null;
      if (targetRec) {
        targetRec.relations = targetRec.relations || [];
        if (!targetRec.relations.some((x) => x.target === rec.id)) {
          db.seq += 1;
          targetRec.relations.push({ id: ID_BASE + db.seq, type: INVERSE_REL[type] || 'OTHER', target: rec.id, media: null });
          touchRec(targetRec);
        }
      } else if (!edge.media) {
        fetchRelationStub(rec, edge);
      }
    }
    logRevision(rec, 'EDIT', { relations: 'Modified' });
    touchRec(rec);
    saveDB();
    pushRecEntities(rec);
    console.log(TAG, 'relation saved locally', rec.id, type, '->', target);
    return { SaveMediaRelation: true };
  }

  // Removing a custom ↔ custom relation drops the reciprocal edge as well.
  function dropReciprocalRelation(rec, edge) {
    if (!edge || !isCustomId(edge.target)) return;
    const other = recById(edge.target);
    if (!other || !other.relations) return;
    const before = other.relations.length;
    other.relations = other.relations.filter((x) => x.target !== rec.id);
    if (other.relations.length !== before) { touchRec(other); pushRecEntities(other); }
  }

  function fetchRelationStub(rec, edge) {
    nativeFetch.call(window, '/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($id:Int){Media(id:$id){id type format status(version:2) isAdult bannerImage title{userPreferred}coverImage{large medium}startDate{year}}}',
        variables: { id: edge.target },
      }),
    }).then((r) => r.json()).then((j) => {
      const m = j && j.data && j.data.Media;
      if (!m) return;
      edge.media = {
        id: m.id, title: { userPreferred: (m.title && m.title.userPreferred) || ('#' + m.id) },
        type: m.type || null, format: m.format || null, status: m.status || null,
        bannerImage: m.bannerImage || null,
        coverImage: { large: m.coverImage && m.coverImage.large, medium: m.coverImage && (m.coverImage.medium || m.coverImage.large) },
        startDate: m.startDate || { year: null }, isAdult: !!m.isAdult,
      };
      touchRec(rec);
      saveDB();
      pushRecEntities(rec);
    }).catch(() => {});
  }

  // Edit page "Add Link" (SaveMediaExternalLink on Submit): stored on
  // rec.media.externalLinks in the media entity's own shape, so the media
  // page's link sidebar renders it as-is. Colour/icon come from AniList's
  // link-source catalog (public query) when the site is known there.
  const linkSourceCache = new Map();
  function handleSaveMediaExternalLink(vars, ctxRec) {
    const rec = isCustomId(vars.mediaId) ? recById(parseInt(vars.mediaId, 10)) : ctxRec;
    if (!rec) return { SaveMediaExternalLink: true };
    const md = rec.media;
    md.externalLinks = md.externalLinks || [];
    const url = String(vars.url || '').trim();
    const linkId = isCustomId(vars.id) ? parseInt(vars.id, 10) : null;
    let link = linkId ? md.externalLinks.find((l) => l.id === linkId) : null;
    if (!link) {
      if (!url) return { SaveMediaExternalLink: true };
      db.seq += 1;
      link = { id: ID_BASE + db.seq, url: null, site: null, siteId: null, type: 'INFO', language: null, color: null, icon: null, notes: null, isDisabled: false };
      md.externalLinks.push(link);
    }
    if (url) link.url = url;
    if (vars.siteId !== undefined && vars.siteId !== null && vars.siteId !== '') link.siteId = parseInt(vars.siteId, 10) || null;
    if (vars.site) link.site = String(vars.site);
    if (vars.type) link.type = String(vars.type);
    if (vars.language !== undefined) link.language = vars.language || null;
    if (vars.notes !== undefined) link.notes = vars.notes || null;
    if (vars.isDisabled !== undefined) link.isDisabled = !!vars.isDisabled;
    if (!link.site) link.site = (() => { try { return new URL(link.url).hostname.replace(/^www\./, ''); } catch (e) { return 'Link'; } })();
    logRevision(rec, 'EDIT', { 'external links': 'Modified' });
    touchRec(rec);
    saveDB();
    pushRecEntities(rec);
    console.log(TAG, 'external link saved locally', rec.id, link.site, link.url);
    if (link.siteId) enrichLinkSource(rec, link);
    return { SaveMediaExternalLink: true };
  }

  function enrichLinkSource(rec, link) {
    const apply = (src) => {
      if (!src) return;
      link.site = src.site || link.site;
      link.type = src.type || link.type;
      link.color = src.color || null;
      link.icon = src.icon || null;
      if (!link.language && src.language) link.language = src.language;
      touchRec(rec);
      saveDB();
      pushRecEntities(rec);
    };
    if (linkSourceCache.has(link.siteId)) { apply(linkSourceCache.get(link.siteId)); return; }
    nativeFetch.call(window, '/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($id:Int){ExternalLinkSourceCollection(id:$id){id site type language color icon}}',
        variables: { id: link.siteId },
      }),
    }).then((r) => r.json()).then((j) => {
      const list = (j && j.data && j.data.ExternalLinkSourceCollection) || [];
      const src = list.find((x) => x.id === link.siteId) || null;
      linkSourceCache.set(link.siteId, src);
      apply(src);
    }).catch(() => {});
  }

  // Apply a SaveMedia mutation's variables (the form's `changes`) locally.
  function applyMediaEdit(rec, vars) {
    const md = rec.media;
    // The form passes raw input strings; the real API coerces, so do we.
    const toIntOrNull = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };
    const coerceDate = (d) => (d
      ? { year: toIntOrNull(d.year), month: toIntOrNull(d.month), day: toIntOrNull(d.day) }
      : { year: null, month: null, day: null });
    if (vars.title) {
      md.title = {
        romaji: vars.title.romaji !== undefined ? vars.title.romaji : (md.title.romaji || null),
        english: vars.title.english !== undefined ? vars.title.english : (md.title.english || null),
        native: vars.title.native !== undefined ? vars.title.native : (md.title.native || null),
      };
      md.title.userPreferred = md.title.romaji || md.title.english || md.title.native || 'Untitled';
    }
    for (const k of ['description', 'format', 'status', 'genres', 'synonyms', 'source',
      'hashtag', 'countryOfOrigin', 'isAdult', 'isLicensed']) {
      if (vars[k] !== undefined) md[k] = vars[k];
    }
    for (const k of ['episodes', 'duration', 'chapters', 'volumes', 'season']) {
      if (vars[k] !== undefined) md[k] = toIntOrNull(vars[k]);
    }
    if (vars.startDate !== undefined) md.startDate = coerceDate(vars.startDate);
    if (vars.endDate !== undefined) md.endDate = coerceDate(vars.endDate);
    if (typeof vars.coverImage === 'string' && vars.coverImage) setCover(md, vars.coverImage, vars.coverImage);
    if (typeof vars.bannerImage === 'string') setBanner(md, vars.bannerImage || null, vars.bannerImage);
    const changes = {};
    for (const [k, v] of Object.entries(vars)) {
      if (['id', 'submissionId', 'submissionSources', 'submissionNotes', 'submissionAssigneeId', 'submissionStatus', 'submissionLocked', 'modNotes'].includes(k)) continue;
      changes[k] = revisionValue(v);
    }
    if (Object.keys(changes).length) logRevision(rec, 'EDIT', changes);
    touchRec(rec);
    saveDB();
    console.log(TAG, 'applied native edit-form save to custom entry', rec.id, vars);
    // A cover/banner from a hotlink-blocking host is embedded in the
    // background; the record re-saves and re-renders when that lands.
    embedRecImages(rec).catch((e) => console.warn(TAG, 'embed failed', e));
    setTimeout(() => {
      syncSections(rec);
      const store = vueStore();
      if (store) {
        try { store.commit('setEntities', richMediaResult(rec).entities); }
        catch (e) { /* ignore */ }
      }
    }, 60);
    return { id: rec.id };
  }

  // Character names render exactly as entered, everywhere. We deliberately
  // emit the whole name as `first` with no `last`, so AniList's own
  // first/last header composition (which reorders by the account's
  // name-order setting) has nothing to reorder, the same trick AniList data
  // mods use for phrase-like names. The precise Given/Surname parts entered
  // in the native character form stay stored on the record untouched.
  function charPartsOf(c) {
    const name = c.name || 'Unnamed';
    return { first: name, last: null, full: name, userPreferred: name };
  }

  function findCharOwner(charId) {
    for (const rec of allRecs()) {
      const c = (rec.characters || []).find((c) => c.id === charId);
      if (c) return { rec, c };
    }
    return null;
  }

  // Characters created via SaveCharacter before they're linked to a media.
  const pendingChars = new Map();

  /* --- staff --- */

  // Staff live on the record like characters: rec.staff = [link], link =
  // { id (link id, custom), staffId (a real AniList staff id, or a custom id
  // for staff created locally with the edit page's "Create New Staff"),
  // role, name{first,middle,last,full,native,userPreferred}, image,
  // language, occupations, + description/gender/… for local staff }. One
  // person can hold several roles on an entry, so link ids are their own.
  const DEFAULT_STAFF_IMG = 'https://s4.anilist.co/file/anilistcdn/staff/large/default.jpg';
  const STAFF_FIELDS = ['staffId', 'isCustom', 'name', 'image', 'language', 'occupations', 'description',
    'gender', 'homeTown', 'bloodType', 'age', 'yearsActive', 'dateOfBirth', 'dateOfDeath', 'isFavourite'];
  const copyStaffData = (dst, src) => { for (const k of STAFF_FIELDS) if (src[k] !== undefined) dst[k] = src[k]; return dst; };
  // Staff created via SaveStaff before being linked to a media (data objects).
  const pendingStaff = new Map();

  function staffNameOf(s) {
    const n = s.name || {};
    const full = n.userPreferred || n.full || [n.first, n.middle, n.last].filter(Boolean).join(' ') || 'Staff #' + s.staffId;
    return {
      first: n.first || null, middle: n.middle || null, last: n.last || null,
      full: n.full || full, native: n.native || null, userPreferred: full,
    };
  }
  // Media page / favourites shape (what mediaStaffPreview edges point at).
  function staffEntityOf(s) {
    const img = s.image || DEFAULT_STAFF_IMG;
    return { id: s.staffId, name: { userPreferred: staffNameOf(s).userPreferred }, language: s.language || null, image: { large: img, medium: img } };
  }
  // Edit page shape (staffRoles edge node, SaveStaff result).
  function staffEditShape(s) {
    const n = staffNameOf(s);
    return { id: s.staffId, name: { userPreferred: n.userPreferred, full: n.full, first: n.first, last: n.last }, image: { medium: s.image || DEFAULT_STAFF_IMG } };
  }
  function findStaffLink(linkId) {
    for (const rec of allRecs()) {
      const st = (rec.staff || []).find((x) => x.id === linkId);
      if (st) return { rec, s: st };
    }
    return null;
  }
  function staffLinksFor(staffId) {
    const out = [];
    for (const rec of allRecs()) for (const st of rec.staff || []) if (st.staffId === staffId) out.push({ rec, s: st });
    return out;
  }
  // Real staff linked from the edit page's search: fetch the display data
  // once (name/image/language/occupations); the placeholder shows meanwhile.
  function fetchStaffDetails(rec, s) {
    nativeFetch.call(window, '/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($id:Int){Staff(id:$id){id name{first middle last full native userPreferred}image{large}language:languageV2 primaryOccupations}}',
        variables: { id: s.staffId },
      }),
    }).then((r) => r.json()).then((j) => {
      const st = j && j.data && j.data.Staff;
      if (!st) return;
      s.name = st.name;
      s.image = (st.image && st.image.large) || null;
      s.language = st.language || null;
      s.occupations = st.primaryOccupations || [];
      touchRec(rec);
      saveDB();
      pushRecEntities(rec);
    }).catch(() => {});
  }

  // "Create New Staff" (and edits of a local staff): keep a data object
  // until SaveMediaStaff links it; afterwards every link sharing the id is
  // updated, since links are denormalized copies.
  function handleSaveStaff(vars) {
    const id = isCustomId(vars.id) ? parseInt(vars.id, 10) : null;
    let st = id ? (pendingStaff.get(id) || null) : null;
    let links = [];
    if (!st && id) { links = staffLinksFor(id); st = links.length ? links[0].s : null; }
    const isNew = !st;
    if (isNew) {
      db.seq += 1;
      st = { staffId: ID_BASE + db.seq, isCustom: true, name: null, image: null, language: null };
    }
    if (vars.name) {
      const n = vars.name;
      const full = [n.first, n.middle, n.last].filter(Boolean).join(' ') || 'Unnamed';
      st.name = {
        first: n.first || null, middle: n.middle || null, last: n.last || null,
        native: n.native || null, full, userPreferred: full,
        alternative: Array.isArray(n.alternative) ? n.alternative : [],
      };
    }
    if (typeof vars.image === 'string' && vars.image) st.image = vars.image;
    for (const k of ['description', 'gender', 'homeTown', 'bloodType', 'age', 'yearsActive', 'dateOfBirth', 'dateOfDeath']) {
      if (vars[k] !== undefined) st[k] = vars[k];
    }
    if (vars.primaryOccupations !== undefined) st.occupations = vars.primaryOccupations || [];
    if (vars.language !== undefined) st.language = vars.language || null;
    if (isNew) pendingStaff.set(st.staffId, st);
    else if (links.length) {
      for (const { rec, s: link } of links) { copyStaffData(link, st); touchRec(rec); }
      saveDB();
      for (const { rec } of links) pushRecEntities(rec);
    }
    console.log(TAG, isNew ? 'created local staff' : 'saved local staff', st.staffId, staffNameOf(st).userPreferred);
    return { SaveStaff: staffEditShape(st) };
  }

  // Edit page Submit: one SaveMediaStaff per row (id = existing link id when
  // editing a role, staffId = the AniList id picked in "Add Staff" or a
  // local id from "Create New Staff").
  function handleSaveMediaStaff(vars, ctxRec) {
    const rec = isCustomId(vars.mediaId) ? recById(parseInt(vars.mediaId, 10)) : ctxRec;
    if (!rec) return { SaveMediaStaff: true };
    rec.staff = rec.staff || [];
    const linkId = isCustomId(vars.id) ? parseInt(vars.id, 10) : null;
    // A staff person created in the same form is linked as a "staff
    // submission" (staffSubmissionId), an existing one by staffId.
    const rawStaffId = vars.staffId !== undefined && vars.staffId !== null ? vars.staffId : vars.staffSubmissionId;
    const staffId = rawStaffId !== undefined && rawStaffId !== null ? parseInt(rawStaffId, 10) : null;
    let st = linkId ? rec.staff.find((x) => x.id === linkId) : null;
    if (!st && staffId) {
      db.seq += 1;
      st = { id: ID_BASE + db.seq, staffId, role: null, name: null, image: null, language: null };
      const src = pendingStaff.get(staffId) || (staffLinksFor(staffId)[0] || {}).s;
      if (src) { copyStaffData(st, src); pendingStaff.delete(staffId); }
      rec.staff.push(st);
      if (!src && !isCustomId(staffId)) fetchStaffDetails(rec, st);
    }
    if (st) {
      if (vars.role !== undefined && vars.role !== null) st.role = String(vars.role);
      logRevision(rec, 'EDIT', { staff: 'Modified' });
      touchRec(rec);
      saveDB();
      pushRecEntities(rec);
      console.log(TAG, 'linked staff to custom entry', rec.id, st.staffId, st.role);
    }
    return { SaveMediaStaff: true };
  }

  /* --- studios --- */
  // Two kinds: a typed local studio (rec.media.studioName, anime only) with
  // a stable id derived from its name so entries sharing the name share one
  // /studio/<id> page, and real AniList studios linked from the edit page's
  // "Add Studios" (rec.media.studios = [{id (link), studioId, name, isMain}]).
  function studioIdFor(name) {
    let h = 2166136261;
    const str = String(name || '').trim().toLowerCase();
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return ID_BASE + 500000000 + (h % 400000000);
  }
  const localStudioOf = (rec) => (rec.media && rec.media.studioName ? { id: rec.id, studioId: studioIdFor(rec.media.studioName), name: rec.media.studioName, isMain: rec.media.studioMain !== false, isCustom: true } : null);
  // Every studio edge of a record, local one first.
  function studiosOf(rec) {
    const out = [];
    const local = localStudioOf(rec);
    if (local) out.push(local);
    for (const st of (rec.media && rec.media.studios) || []) if (st && st.studioId) out.push(st);
    return out;
  }
  const customEntriesWithStudio = (studioId) => viewerRecs().filter((rec) => studiosOf(rec).some((st) => st.studioId === studioId));
  function fetchStudioName(rec, link) {
    nativeFetch.call(window, '/graphql', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query($id:Int){Studio(id:$id){id name isAnimationStudio}}', variables: { id: link.studioId } }),
    }).then((r) => r.json()).then((j) => {
      const st = j && j.data && j.data.Studio;
      if (!st) return;
      link.name = st.name;
      link.isAnimationStudio = st.isAnimationStudio !== false;
      touchRec(rec); saveDB(); pushRecEntities(rec);
    }).catch(() => {});
  }
  function handleSaveMediaStudio(vars, ctxRec) {
    const rec = isCustomId(vars.mediaId) ? recById(parseInt(vars.mediaId, 10)) : ctxRec;
    if (!rec) return { SaveMediaStudio: true };
    const md = rec.media;
    md.studios = md.studios || [];
    const linkId = isCustomId(vars.id) ? parseInt(vars.id, 10) : null;
    const studioId = vars.studioId !== undefined && vars.studioId !== null ? parseInt(vars.studioId, 10) : null;
    const local = localStudioOf(rec);
    if (local && (linkId === rec.id || studioId === local.studioId)) {
      if (vars.isMain !== undefined && vars.isMain !== null) md.studioMain = !!vars.isMain;
    } else {
      let link = linkId ? md.studios.find((x) => x.id === linkId) : null;
      if (!link && studioId) {
        link = md.studios.find((x) => x.studioId === studioId);
        if (!link) {
          db.seq += 1;
          link = { id: ID_BASE + db.seq, studioId, name: null, isMain: false, isAnimationStudio: true };
          const store = vueStore();
          const sents = store && entitiesState(store);
          const known = sents && sents.studio && sents.studio[studioId]; // the Add Studios search normalized it
          if (known && known.name) { link.name = known.name; link.isAnimationStudio = known.isAnimationStudio !== false; }
          md.studios.push(link);
          if (!link.name) fetchStudioName(rec, link);
        }
      }
      if (link && vars.isMain !== undefined && vars.isMain !== null) link.isMain = !!vars.isMain;
    }
    logRevision(rec, 'EDIT', { studios: 'Modified' });
    touchRec(rec); saveDB(); pushRecEntities(rec);
    return { SaveMediaStudio: true };
  }
  function removeStudioLink(rec, linkId) {
    const md = rec.media;
    if (linkId === rec.id) { md.studioName = null; delete md.studioMain; }
    else md.studios = (md.studios || []).filter((x) => x.id !== linkId);
    logRevision(rec, 'EDIT', { studios: 'Modified' });
    touchRec(rec); saveDB(); pushRecEntities(rec);
  }
  // Local /studio/<id> page: the entries carrying that studio name.
  function studioPageResult(sid, vars, opts) {
    const recs = customEntriesWithStudio(sid);
    if (!recs.length) return { result: null, entities: {} };
    const name = (studiosOf(recs[0]).find((st) => st.studioId === sid) || {}).name || 'Studio';
    const pageId = opts && opts.page && opts.page.id ? String(opts.page.id) : 'studioMedia-' + sid;
    const v = vars || {};
    const media = {};
    const edges = [];
    for (const rec of recs) {
      if (!passesOnList(rec, v.onList)) continue;
      media[rec.id] = mediaEntity(rec);
      edges.push({ isMainStudio: !!(studiosOf(rec).find((st) => st.studioId === sid) || {}).isMain, node: rec.id });
    }
    const pg = { pageInfo: { total: edges.length, perPage: 25, currentPage: v.page || 1, lastPage: 1, hasNextPage: false }, pageData: edges };
    return {
      result: sid,
      entities: {
        studio: { [sid]: { id: sid, name, isAnimationStudio: true, favourites: 0, isFavourite: !!(db.favStudios && db.favStudios[sid]), isFavouriteBlocked: false, media: 'studioMedia-' + sid } },
        media,
        page: { [pageId]: pg, ['studioMedia-' + sid]: pg },
      },
    };
  }
  // Real studio page: prepend the custom entries linked to it.
  function addStudioBacklinks(arr, ents, pageInfo, hits) {
    let n = 0;
    for (const { rec, st } of hits) {
      if (arr.some((e) => e && e.node === rec.id)) continue;
      arr.unshift({ isMainStudio: !!st.isMain, node: rec.id });
      ents.media = ents.media || {};
      ents.media[rec.id] = mediaEntity(rec);
      n++;
    }
    if (n && pageInfo && typeof pageInfo.total === 'number') pageInfo.total += n;
    return n;
  }
  const studioHits = (studioId, onList) => customEntriesWithStudio(studioId).filter((rec) => passesOnList(rec, onList)).map((rec) => ({ rec, st: studiosOf(rec).find((x) => x.studioId === studioId) }));
  function patchStudioBacklinks(result, meta) {
    const ents = result.entities;
    const pg = ents && ents.page && ents.page[meta.pageId];
    if (!pg || !Array.isArray(pg.pageData) || (meta.vars.page || 1) !== 1) return;
    const n = addStudioBacklinks(pg.pageData, ents, pg.pageInfo, studioHits(meta.id, meta.vars.onList));
    if (n) console.log(TAG, `added ${n} custom entr${n === 1 ? 'y' : 'ies'} to studio ${meta.id}`);
  }

  // Local /staff/<id> page for staff created locally: header data plus the
  // roles on custom entries. The site keys the roles pages by its own page
  // id (vars JSON), which arrives in the RPC options; the entity's own
  // schema key gets the same page so either lookup works.
  function staffPageResult(sid, vars, opts) {
    const links = staffLinksFor(sid);
    if (!links.length) return { result: null, entities: {} };
    const st = links[0].s;
    const img = st.image || DEFAULT_STAFF_IMG;
    const noDate = { year: null, month: null, day: null };
    const staff = {
      id: sid,
      name: Object.assign({ alternative: (st.name && st.name.alternative) || [] }, staffNameOf(st)),
      image: { large: img },
      description: st.description ? sanitizeHtml(st.description) : null,
      favourites: 0,
      isFavourite: !!st.isFavourite,
      isFavouriteBlocked: false,
      age: st.age || null,
      gender: st.gender || null,
      yearsActive: st.yearsActive || [],
      homeTown: st.homeTown || null,
      bloodType: st.bloodType || null,
      primaryOccupations: st.occupations || [],
      dateOfBirth: st.dateOfBirth || noDate,
      dateOfDeath: st.dateOfDeath || noDate,
      language: st.language || null,
      characterMedia: 'staffCharacterMediaRoles-' + sid,
      staffMedia: 'staffMediaRoles-' + sid,
    };
    const page = {};
    const media = {};
    const pageId = opts && opts.page && opts.page.id ? String(opts.page.id) : null;
    const v = vars || {};
    if (v.withStaffRoles || v.withCharacterRoles) {
      const edges = [];
      if (v.withStaffRoles) {
        for (const { rec, s: link } of links) {
          if (v.type && rec.type !== v.type) continue;
          media[rec.id] = mediaEntity(rec);
          edges.push({ staffRole: link.role || '', node: rec.id });
        }
      }
      const pg = {
        pageInfo: { total: edges.length, perPage: 25, currentPage: v.staffPage || v.characterPage || 1, lastPage: 1, hasNextPage: false },
        pageData: edges,
      };
      page[v.withStaffRoles ? staff.staffMedia : staff.characterMedia] = pg;
      if (pageId) page[pageId] = pg;
    }
    return { result: sid, entities: { staff: { [sid]: staff }, media, page } };
  }

  function handleSaveCharacter(vars, ctxRec) {
    const id = isCustomId(vars.id) ? parseInt(vars.id, 10) : null;
    const name = vars.name
      ? [vars.name.first, vars.name.middle, vars.name.last].filter(Boolean).join(' ') || 'Unnamed'
      : null;
    let c;
    if (id) {
      const owner = findCharOwner(id);
      c = owner ? owner.c : null;
    }
    if (!c) {
      db.seq += 1;
      c = { id: ID_BASE + db.seq, name: name || 'Unnamed', role: 'MAIN', image: null };
      if (ctxRec) {
        ctxRec.characters = ctxRec.characters || [];
        ctxRec.characters.push(c);
      } else {
        pendingChars.set(c.id, c);
      }
    }
    if (name) c.name = name;
    if (vars.name) {
      // Keep the exact name parts so the account's name-order setting can be
      // applied faithfully everywhere.
      c.first = vars.name.first || null;
      c.middle = vars.name.middle || null;
      c.last = vars.name.last || null;
    }
    if (typeof vars.image === 'string' && vars.image) c.image = vars.image;
    for (const k of ['description', 'age', 'gender']) {
      if (vars[k] !== undefined) c[k] = vars[k];
    }
    const own = findCharOwner(c.id);
    touchRec(own ? own.rec : ctxRec);
    saveDB();
    console.log(TAG, 'saved custom character', c.id, c.name);
    return {
      SaveCharacter: {
        id: c.id,
        name: charPartsOf(c),
        image: { medium: c.image || DEFAULT_CHAR_IMG },
      },
    };
  }

  function handleSaveMediaCharacter(vars, ctxRec) {
    const rec = isCustomId(vars.mediaId) ? recById(parseInt(vars.mediaId, 10)) : ctxRec;
    if (!rec) return { SaveMediaCharacter: true };
    rec.characters = rec.characters || [];
    const rawCharId = vars.characterId !== undefined && vars.characterId !== null ? vars.characterId : vars.characterSubmissionId;
    const charId = rawCharId !== undefined && rawCharId !== null ? parseInt(rawCharId, 10) : null;
    const linkId = isCustomId(vars.id) ? parseInt(vars.id, 10) : null;
    let c = rec.characters.find((c) => c.id === (linkId || charId));
    if (!c && charId && pendingChars.has(charId)) {
      c = pendingChars.get(charId);
      pendingChars.delete(charId);
      rec.characters.push(c);
    }
    if (!c && charId) {
      // Linking an existing (possibly real) character: fetch its details so
      // it displays properly; falls back to a placeholder name.
      c = { id: charId, name: 'Character #' + charId, role: vars.role || 'MAIN', image: null };
      rec.characters.push(c);
      nativeFetch('/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query($id:Int){Character(id:$id){id name{userPreferred}image{large}}}',
          variables: { id: charId },
        }),
      }).then((r) => r.json()).then((j) => {
        const ch = j.data && j.data.Character;
        if (ch) {
          c.name = ch.name.userPreferred;
          c.image = ch.image.large;
          saveDB();
        }
      }).catch(() => {});
    }
    if (c) {
      if (vars.role !== undefined && vars.role !== null) c.role = vars.role;
      logRevision(rec, 'EDIT', { characters: 'Modified' });
      touchRec(rec);
      saveDB();
      console.log(TAG, 'linked character to custom entry', rec.id, c.id, c.role);
    }
    return { SaveMediaCharacter: true };
  }

  function mediaCharactersShape(rec) {
    return (rec.characters || []).map((c) => ({
      id: c.id,
      role: c.role || 'MAIN',
      roleNotes: null,
      dubGroup: null,
      characterName: null,
      character: {
        id: c.id,
        name: charPartsOf(c),
        image: { medium: c.image || DEFAULT_CHAR_IMG },
      },
      voiceActor: null,
    }));
  }

  // Direct (non-worker) GraphQL calls: returns a data object to answer
  // locally, or null to let the request through to the server.
  function handleDirectGraphQL(query, vars) {
    const hasCustom = Object.values(vars).some(isCustomId);
    const ctxRec = editPageRec();
    if (!hasCustom && !ctxRec) return null;
    const isMutation = query.trimStart().startsWith('mutation');

    if (!isMutation) {
      if (hasCustom && query.includes('MediaSubmission(')) return { MediaSubmission: [] };
      if (isCustomId(vars.id) && /results\s*:\s*media\s*\(/.test(query)) {
        const rec = recById(parseInt(vars.id, 10));
        return { Page: { pageInfo: { total: rec ? 1 : 0, perPage: 25, currentPage: 1, lastPage: 1, hasNextPage: false }, results: rec ? [editSearchStub(rec)] : [] } };
      }
      if (query.includes('revisionHistory(')) {
        const rec = isCustomId(vars.mediaId) ? recById(parseInt(vars.mediaId, 10)) : null;
        if (rec) return revisionHistoryResult(rec, vars);
        return { Page: { pageInfo: { total: 0, perPage: 50, currentPage: 1, lastPage: 1, hasNextPage: false }, revisionHistory: [] } };
      }
      if (isCustomId(vars.id) && query.includes('airingSchedules(')) {
        const rec = recById(parseInt(vars.id, 10));
        return rec ? airingSchedulesResult(rec) : { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [] } };
      }
      if (isCustomId(vars.id) && query.includes('MediaCharacters(')) {
        const rec = recById(parseInt(vars.id, 10));
        return { MediaCharacters: rec ? mediaCharactersShape(rec) : [] };
      }
      if (isCustomId(vars.id) && /\{Media\(id:\$id\)/.test(query)) {
        const rec = recById(parseInt(vars.id, 10));
        if (!rec) return { Media: null };
        if (query.includes('staffRoles')) {
          const edges = (rec.staff || []).map((st) => ({ id: st.id, role: st.role || null, staff: staffEditShape(st) }));
          return { Media: { id: rec.id, staffRoles: { pageInfo: { total: edges.length, perPage: 25, currentPage: 1, lastPage: 1, hasNextPage: false }, edges } } };
        }
        return { Media: editMediaShape(rec) };
      }
      if (!hasCustom) return null; // context-only queries (e.g. searches) pass through
      console.warn(TAG, 'blocked direct graphql query touching a custom id', query.slice(0, 80));
      return {};
    }

    // Mutations
    if (ctxRec) noteLocalSubmit(ctxRec); // Submit on a custom entry's edit page
    // Replies on local activities (post / edit / delete / like).
    if (query.includes('SaveActivityReply')) {
      const a = isCustomId(vars.activityId) ? activityById(vars.activityId)
        : (isCustomId(vars.id) && findReply(vars.id) ? findReply(vars.id).a : null);
      if (a) {
        const r = saveLocalReply(a, vars);
        return {
          SaveActivityReply: Object.assign(replyEntity(a, r), {
            user: activityUserEntity(r.userId),
          }),
        };
      }
    }
    const replyHit = isCustomId(vars.id) && !activityById(vars.id) ? findReply(vars.id) : null;
    if (replyHit) {
      if (/ToggleLike/.test(query)) {
        replyHit.r.isLiked = !replyHit.r.isLiked;
        replyHit.r.likeCount = Math.max(0, (replyHit.r.likeCount || 0) + (replyHit.r.isLiked ? 1 : -1));
        touchAct(replyHit.a);
        saveDB();
        syncReplyLive(replyHit.a, replyHit.r);
        return { ToggleLikeV2: { id: replyHit.r.id, type: 'ACTIVITY_REPLY', isLiked: replyHit.r.isLiked, likeCount: replyHit.r.likeCount, likes: [] } };
      }
      if (query.includes('DeleteActivityReply')) {
        deleteLocalReply(replyHit.a, replyHit.r);
        return { DeleteActivityReply: { deleted: true } };
      }
    }
    const act = isCustomId(vars.id) ? activityById(vars.id) : null;
    if (act) {
      if (/ToggleLike/.test(query)) {
        act.isLiked = !act.isLiked;
        act.likeCount = Math.max(0, (act.likeCount || 0) + (act.isLiked ? 1 : -1));
        touchAct(act);
        saveDB();
        pushActivityLive(act, false);
        return { ToggleLikeV2: { id: act.id, type: 'ACTIVITY', isLiked: act.isLiked, likeCount: act.likeCount, likes: [] } };
      }
      if (query.includes('DeleteActivity')) {
        markDeleted(act.id);
        delete db.activities[act.id];
        saveDB();
        removeActivityLive(act);
        return { DeleteActivity: { deleted: true } };
      }
      if (query.includes('ToggleActivitySubscription')) {
        act.isSubscribed = vars.subscribe !== undefined ? !!vars.subscribe : !act.isSubscribed;
        touchAct(act);
        saveDB();
        return { ToggleActivitySubscription: { id: act.id, isSubscribed: act.isSubscribed } };
      }
    }
    if (hasCustom && query.includes('ToggleFavourite')) return handleFav(vars);
    if (query.includes('SaveMedia(') && (isCustomId(vars.id) || (ctxRec && vars.id === undefined))) {
      const rec = isCustomId(vars.id) ? recById(parseInt(vars.id, 10)) : ctxRec;
      if (rec) return { SaveMedia: applyMediaEdit(rec, vars) };
    }
    if (query.includes('SaveAiringSchedule(') && (isCustomId(vars.mediaId) || ctxRec)) {
      return handleSaveAiringSchedule(isCustomId(vars.mediaId) ? recById(parseInt(vars.mediaId, 10)) : ctxRec, vars);
    }
    if (query.includes('SaveMediaCharacter(')) return handleSaveMediaCharacter(vars, ctxRec);
    if (query.includes('SaveCharacter(') && (ctxRec || isCustomId(vars.id))) {
      return handleSaveCharacter(vars, ctxRec);
    }
    if (query.includes('DeleteMediaCharacter(')) {
      // Only reachable for custom entries (guarded above); the link id may be
      // a real character's id when a real character was attached locally.
      const owner = findCharOwner(parseInt(vars.id, 10));
      if (owner) {
        owner.rec.characters = owner.rec.characters.filter((c) => c.id !== owner.c.id);
        logRevision(owner.rec, 'EDIT', { characters: 'Modified' });
        touchRec(owner.rec);
        saveDB();
        console.log(TAG, 'unlinked character', owner.c.id);
      }
      return { DeleteMediaCharacter: { deleted: true } };
    }
    if (query.includes('DeleteCharacter(') && isCustomId(vars.id)) {
      const owner = findCharOwner(parseInt(vars.id, 10));
      if (owner) {
        owner.rec.characters = owner.rec.characters.filter((c) => c.id !== owner.c.id);
        touchRec(owner.rec);
        saveDB();
      }
      pendingChars.delete(parseInt(vars.id, 10));
      return { DeleteCharacter: { deleted: true } };
    }
    // Reviews: the editor's save and the review page's rate / delete go
    // through the plain client (raw data shape).
    if (query.includes('SaveReview') && (isCustomId(vars.mediaId) || isCustomId(vars.id))) {
      const r = handleSaveReview(vars);
      const rv = r.result ? r.entities.review[r.result] : null;
      return { SaveReview: rv ? { id: rv.id, mediaId: rv.media, userId: rv.user } : null };
    }
    if (query.includes('RateReview') && (isCustomId(vars.id) || isCustomId(vars.reviewId))) {
      const r = handleRateReview(vars);
      const rv = r.result ? r.entities.review[r.result] : null;
      return { RateReview: rv ? { id: rv.id, userRating: rv.userRating, rating: rv.rating, ratingAmount: rv.ratingAmount } : null };
    }
    if (query.includes('DeleteReview') && isCustomId(vars.id)) {
      handleDeleteReview(vars);
      return { DeleteReview: { deleted: true } };
    }
    // Relations / external links on the edit page.
    if (query.includes('SaveMediaRelation(')) return handleSaveMediaRelation(vars, ctxRec);
    if (query.includes('DeleteMediaRelation(')) {
      const eid = parseInt(vars.id, 10);
      for (const rec of allRecs()) {
        const gone = (rec.relations || []).find((x) => x.id === eid);
        if (!gone) continue;
        rec.relations = rec.relations.filter((x) => x.id !== eid);
        dropReciprocalRelation(rec, gone);
        logRevision(rec, 'EDIT', { relations: 'Modified' }); touchRec(rec); saveDB(); pushRecEntities(rec); console.log(TAG, 'relation removed locally', eid);
      }
      return { DeleteMediaRelation: { deleted: true } };
    }
    if (query.includes('SaveMediaExternalLink(')) return handleSaveMediaExternalLink(vars, ctxRec);
    if (query.includes('DeleteMediaExternalLink(')) {
      const lid = parseInt(vars.id, 10);
      for (const rec of allRecs()) {
        const links = rec.media.externalLinks || [];
        if (!links.some((l) => l.id === lid)) continue;
        rec.media.externalLinks = links.filter((l) => l.id !== lid);
        logRevision(rec, 'EDIT', { 'external links': 'Modified' });
        touchRec(rec); saveDB(); pushRecEntities(rec);
        console.log(TAG, 'external link removed locally', lid);
      }
      return { DeleteMediaExternalLink: { deleted: true } };
    }
    // Studios on the edit page: "Add Studios" (real studios) and the main flag.
    if (query.includes('SaveMediaStudio(')) return handleSaveMediaStudio(vars, ctxRec);
    if (query.includes('DeleteMediaStudio(')) {
      const lid = parseInt(vars.id, 10);
      for (const rec of allRecs()) {
        if (lid === rec.id ? !!rec.media.studioName : (rec.media.studios || []).some((x) => x.id === lid)) removeStudioLink(rec, lid);
      }
      return { DeleteMediaStudio: { deleted: true } };
    }
    // Staff on the edit page: "Add Staff" (real AniList staff), "Create New
    // Staff" (local), role edits and the row's trash button.
    if (query.includes('SaveMediaStaff(')) return handleSaveMediaStaff(vars, ctxRec);
    if (query.includes('SaveStaff(') && (ctxRec || isCustomId(vars.id))) return handleSaveStaff(vars);
    if (query.includes('DeleteMediaStaff(')) {
      const hit = isCustomId(vars.id) ? findStaffLink(parseInt(vars.id, 10)) : null;
      if (hit) {
        hit.rec.staff = hit.rec.staff.filter((x) => x.id !== hit.s.id);
        logRevision(hit.rec, 'EDIT', { staff: 'Modified' });
        touchRec(hit.rec);
        saveDB();
        pushRecEntities(hit.rec);
        console.log(TAG, 'unlinked staff', hit.s.staffId, 'from', hit.rec.id);
      }
      return { DeleteMediaStaff: { deleted: true } };
    }
    if (query.includes('DeleteStaff(') && isCustomId(vars.id)) {
      const sid = parseInt(vars.id, 10);
      for (const { rec } of staffLinksFor(sid)) {
        rec.staff = rec.staff.filter((x) => x.staffId !== sid);
        touchRec(rec);
        pushRecEntities(rec);
      }
      pendingStaff.delete(sid);
      saveDB();
      return { DeleteStaff: { deleted: true } };
    }
    // The sidebar "Add Tag" (+) modal: add the tag to the local record,
    // enriched from AniList's tag catalog when the name matches.
    if (query.includes('AddMediaTag') && isCustomId(vars.mediaId)) {
      const rec = recById(parseInt(vars.mediaId, 10));
      const name = String(vars.name || '').trim();
      if (rec && name && !(rec.media.tags || []).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        rec.media.tags = rec.media.tags || [];
        const cat = catalogTag(name);
        rec.media.tags.push({
          id: ID_BASE + (++db.seq),
          name: cat ? cat.name : name,
          rank: 100,
          isMediaSpoiler: !!vars.isMediaSpoiler,
          isGeneralSpoiler: !!(cat && cat.isGeneralSpoiler),
          isAdult: !!(cat && cat.isAdult),
          category: cat ? cat.category || null : null,
          description: cat ? cat.description || null : null,
          userId: authUserId(),
        });
        logRevision(rec, 'EDIT', { tags: 'Modified' });
        touchRec(rec);
        saveDB();
        pushRecEntities(rec);
        console.log(TAG, 'added tag locally:', name, '->', rec.id);
      }
      return { AddMediaTag: true };
    }
    // The tag relevance dropdown sends vote 0-5 (Not Relevant .. Main
    // Theme). A custom entry has one voter, so it maps straight onto the
    // percentage: rank = vote * 20.
    if (query.includes('SaveMediaTagVote') && isCustomId(vars.mediaId)) {
      const rec = recById(parseInt(vars.mediaId, 10));
      const tag = rec && (rec.media.tags || []).find((t) => t.id === parseInt(vars.tagId, 10));
      if (tag) {
        const vote = Math.max(0, Math.min(5, parseInt(vars.vote, 10) || 0));
        tag.rank = vote * 20;
        touchRec(rec);
        saveDB();
        pushRecEntities(rec);
        console.log(TAG, 'tag vote:', tag.name, '->', tag.rank + '%');
      }
      return { SaveMediaTagVote: true };
    }
    // Anything else must never reach the server while a custom entry is in play.
    console.warn(TAG, 'blocked submission mutation for custom entry', query.slice(0, 90));
    return {};
  }

  /* ------------------------------------------------------------------ *
   * MediaListCollection response patching
   * ------------------------------------------------------------------ */

  function patchListResult(result, meta) {
    if (!result || !result.entities || typeof result.result !== 'string') return;
    const ents = result.entities;
    const mlId = result.result; // "<userId>-<type>"
    const uid = parseInt(mlId, 10);
    if (!uid) return;

    // Capture the list owner's identity + list options for later use.
    // `self` marks accounts we've actually been logged into; only those are
    // offered as move targets (any browsed list's owner lands here too).
    const user = ents.user && ents.user[uid];
    if (user && user.mediaListOptions) {
      const prev = db.owners[uid];
      const owner = { id: uid, name: user.name, options: user.mediaListOptions };
      if (uid === authUserId() || (prev && prev.self)) owner.self = true;
      db.owners[uid] = owner;
      saveDB();
    }

    const type = meta.type;
    const typeL = type.toLowerCase();
    const ml = ents.mediaList && ents.mediaList[mlId];
    if (!ml) return;

    let injected = 0;
    for (const rec of allRecs()) {
      if (rec.ownerId !== uid || rec.type !== type || !recIsListed(rec)) continue;
      ents.listEntry = ents.listEntry || {};
      ents.media = ents.media || {};
      ents.listSection = ents.listSection || {};
      ents.listEntry[rec.entry.id] = entryEntity(rec);
      ents.media[rec.id] = mediaEntity(rec);
      for (const s of sectionNamesFor(rec)) {
        const sid = `${uid}-${typeL}-${s.name}`;
        let sec = ents.listSection[sid];
        if (!sec) {
          sec = ents.listSection[sid] = {
            name: s.name,
            isCustomList: s.isCustomList,
            isCompletedList: s.isCompletedList,
            entries: [],
          };
          if (!ml.lists.includes(sid)) ml.lists.push(sid);
        }
        if (!sec.entries.includes(rec.entry.id)) sec.entries.push(rec.entry.id);
      }
      injected++;
    }
    if (injected) console.log(TAG, `injected ${injected} custom ${typeL} entr${injected === 1 ? 'y' : 'ies'}`);
  }

  /* ------------------------------------------------------------------ *
   * Activity feed + home "in progress" response patching
   * ------------------------------------------------------------------ */

  // Should activity `a` appear in a feed fetched with these variables?
  // Home feeds filter with `activityTypes: [TEXT, MEDIA_LIST, …]`, the
  // profile feed with a single `type` (ANIME_LIST / MANGA_LIST / TEXT / …).
  function activityMatchesFilter(a, vars) {
    if (vars.type && vars.type !== 'MEDIA_LIST' && vars.type !== a.type) return false;
    if (Array.isArray(vars.activityTypes)
      && !vars.activityTypes.includes('MEDIA_LIST')
      && !vars.activityTypes.includes(a.type)) return false;
    return true;
  }

  // Merge two newest-first id lists into one, ordered by timeOf (desc), so
  // injected records interleave with the server's instead of pinning on top.
  function mergeByTime(localIds, realIds, timeOf) {
    const out = [];
    let i = 0;
    let j = 0;
    while (i < localIds.length && j < realIds.length) {
      out.push(timeOf(localIds[i]) >= timeOf(realIds[j]) ? localIds[i++] : realIds[j++]);
    }
    return out.concat(localIds.slice(i), realIds.slice(j));
  }

  // Per-feed record of local activity ids already injected into some page, so
  // scrolling injects each local record exactly once, on the page whose time
  // range it falls into. Reset whenever a feed refetches its first page.
  const injectedFeedActs = new Map();

  function patchActivityFeed(result, meta) {
    if (!result || !result.entities) return;
    const vars = meta.vars || {};
    const page = vars.page || 1;
    const pg = result.entities.page && result.entities.page[meta.pageId];
    if (!pg || !Array.isArray(pg.pageData)) return;

    // Profile feeds ("userActivity-<filter>-<userId>") belong to one user.
    const m = String(meta.pageId).match(/^userActivity-.*-(\d+)$/);
    const onlyUid = m ? parseInt(m[1], 10) : null;

    if (page === 1) injectedFeedActs.set(meta.pageId, new Set());
    const injected = injectedFeedActs.get(meta.pageId) || new Set();
    injectedFeedActs.set(meta.pageId, injected);

    const ents = result.entities;
    const timeOf = (id) => {
      const a = (ents.activity && ents.activity[id]) || db.activities[id];
      return a ? a.createdAt : 0;
    };
    // A local record belongs on this page if it's newer than the page's
    // oldest real activity (older pages get it when they load); the last
    // page also takes everything that remains.
    const realTimes = pg.pageData.filter((id) => !isCustomId(id)).map(timeOf);
    const oldestReal = realTimes.length ? Math.min(...realTimes) : 0;
    const hasNext = !!(pg.pageInfo && pg.pageInfo.hasNextPage);

    const acts = allActivities().filter((a) =>
      (onlyUid === null || a.ownerId === onlyUid)
      && activityMatchesFilter(a, vars)
      && !injected.has(a.id)
      && (!hasNext || a.createdAt >= oldestReal));
    if (!acts.length) return;

    ents.activity = ents.activity || {};
    ents.media = ents.media || {};
    ents.user = ents.user || {};
    const ids = [];
    for (const a of acts) {
      const rec = recById(a.mediaId);
      if (!rec) continue;
      ents.activity[a.id] = activityEntity(a);
      ents.media[rec.id] = mediaEntity(rec);
      // Don't overwrite the response's own (richer) user entity if present.
      if (!ents.user[a.ownerId]) ents.user[a.ownerId] = activityUserEntity(a.ownerId);
      ids.push(a.id);
      injected.add(a.id);
    }
    if (!ids.length) return;
    pg.pageData = mergeByTime(ids, pg.pageData.filter((id) => !ids.includes(id)), timeOf);
    console.log(TAG, `injected ${ids.length} local activit${ids.length === 1 ? 'y' : 'ies'} into ${meta.pageId} page ${page}`);
  }

  function patchListPreview(result, meta) {
    if (!result || !result.entities) return;
    const pg = result.entities.page && result.entities.page[meta.pageId];
    if (!pg || !Array.isArray(pg.pageData)) return;
    const recs = allRecs().filter((r) => r.ownerId === meta.userId && r.type === meta.type
      && (r.entry.status === 'CURRENT' || r.entry.status === 'REPEATING'));
    if (!recs.length) return;
    recs.sort((x, y) => (y.entry.updatedAt || 0) - (x.entry.updatedAt || 0));
    const ents = result.entities;
    ents.listEntry = ents.listEntry || {};
    ents.media = ents.media || {};
    const ids = [];
    for (const rec of recs) {
      ents.listEntry[rec.entry.id] = entryEntity(rec);
      ents.media[rec.id] = mediaEntity(rec);
      ids.push(rec.entry.id);
    }
    // Response rows carry updatedAt because onOutgoing adds it to the home
    // query; the store copy is a fallback (e.g. an entry a list page loaded)
    // for the odd row that still lacks it.
    let storeEnts = null;
    const timeOf = (id) => {
      const e = ents.listEntry[id];
      if (e && e.updatedAt) return e.updatedAt;
      if (storeEnts === null) {
        const store = vueStore();
        storeEnts = (store && entitiesState(store)) || false;
      }
      const x = storeEnts && storeEnts.listEntry && storeEnts.listEntry[id];
      return (x && x.updatedAt) || 0;
    };
    pg.pageData = mergeByTime(ids, pg.pageData.filter((id) => !ids.includes(id)), timeOf);
    console.log(TAG, `injected ${ids.length} custom entr${ids.length === 1 ? 'y' : 'ies'} into ${meta.pageId}`);
  }

  /* ------------------------------------------------------------------ *
   * Live store sync for feeds + home previews (no reload needed)
   * ------------------------------------------------------------------ */

  // Store page ids of activity feeds that should show ownerId's activities.
  function feedPageIdsInStore(ents, ownerId) {
    return Object.keys(ents.page || {}).filter((k) =>
      k.indexOf('homeActivity-') === 0
      || new RegExp('^userActivity-.*-' + ownerId + '$').test(k));
  }

  // Commit an activity (and its media/user) into the store; when `isNew`,
  // also prepend it to any visible feed page so it shows up instantly.
  function pushActivityLive(a, isNew) {
    const store = vueStore();
    if (!store) return;
    const ents = entitiesState(store);
    if (!ents) return;
    const rec = recById(a.mediaId);
    const patch = { activity: { [a.id]: activityEntity(a) } };
    if (rec) patch.media = { [rec.id]: mediaEntity(rec) };
    if (!(ents.user && ents.user[a.ownerId])) {
      patch.user = { [a.ownerId]: activityUserEntity(a.ownerId) };
    }
    try { store.commit('setEntities', patch); }
    catch (e) { console.warn(TAG, 'activity commit failed', e); return; }
    if (!isNew) return;
    const timeOf = (id) => {
      const x = (ents.activity && ents.activity[id]) || db.activities[id];
      return x ? x.createdAt : 0;
    };
    for (const key of feedPageIdsInStore(ents, a.ownerId)) {
      const arr = ents.page[key] && ents.page[key].pageData && ents.page[key].pageData[1];
      if (!Array.isArray(arr) || arr.includes(a.id)) continue;
      const idx = arr.findIndex((id) => timeOf(id) < a.createdAt);
      if (idx === -1) arr.push(a.id);
      else arr.splice(idx, 0, a.id);
      // Already live in this feed; later page fetches must not re-inject it.
      const injected = injectedFeedActs.get(key);
      if (injected) injected.add(a.id);
    }
  }

  function removeActivityLive(a) {
    const store = vueStore();
    if (!store) return;
    const ents = entitiesState(store);
    if (!ents || !ents.page) return;
    for (const key of feedPageIdsInStore(ents, a.ownerId)) {
      const arr = ents.page[key] && ents.page[key].pageData && ents.page[key].pageData[1];
      if (Array.isArray(arr)) {
        const i = arr.indexOf(a.id);
        if (i >= 0) arr.splice(i, 1);
      }
    }
  }

  // The home preview's real rows only carry updatedAt because onOutgoing
  // extends the site's query. When that query ran before our hooks existed
  // (late injection, repaired by selfHeal) they have none, and custom
  // entries could only pin on top. Fetch the timestamps ourselves (same
  // query the site uses, id + updatedAt only, session cookie), merge them
  // into the store (setEntities merges per entity) and re-sort the preview
  // by time in place. Cached per type for a minute so repeated
  // syncHomePreview calls (one per entry from selfHeal) share one request.
  const previewTimesCache = {};
  function fillPreviewTimes(type) {
    const now = Date.now();
    const c = previewTimesCache[type];
    if (c && now - c.at < 60000) return c.promise;
    const uid = authUserId();
    if (!uid) return Promise.resolve();
    const query = 'query($userId:Int,$type:MediaType,$perPage:Int){Page(perPage:$perPage){'
      + 'mediaList(userId:$userId,type:$type,status_in:[CURRENT,REPEATING],sort:UPDATED_TIME_DESC){id updatedAt}}}';
    const promise = nativeFetch.call(window, '/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { userId: uid, type, perPage: 50 } }),
    })
      .then((r) => r.json())
      .then((j) => {
        const rows = (j && j.data && j.data.Page && j.data.Page.mediaList) || [];
        const store = vueStore();
        const ents = store && entitiesState(store);
        const pg = ents && ents.page && ents.page['homeListPreview-' + type];
        const arr = pg && pg.pageData && pg.pageData[1];
        if (!Array.isArray(arr) || !rows.length) return;
        const patch = {};
        for (const row of rows) {
          if (row && row.id && row.updatedAt && arr.includes(row.id)) {
            patch[row.id] = { id: row.id, updatedAt: row.updatedAt };
          }
        }
        if (!Object.keys(patch).length) return;
        store.commit('setEntities', { listEntry: patch });
        const timeOf = (id) => (ents.listEntry && ents.listEntry[id] && ents.listEntry[id].updatedAt) || 0;
        const sorted = arr.slice().sort((a, b) => timeOf(b) - timeOf(a));
        if (sorted.some((id, i) => id !== arr[i])) arr.splice(0, arr.length, ...sorted);
        console.log(TAG, `re-sorted homeListPreview-${type} by updatedAt (${Object.keys(patch).length} rows timed)`);
      })
      .catch((e) => {
        delete previewTimesCache[type];
        console.warn(TAG, 'preview updatedAt fetch failed', e);
      });
    previewTimesCache[type] = { at: now, promise };
    return promise;
  }

  // Keep the home page's "Anime/Manga in Progress" preview in step with the
  // entry's status while the home page is loaded.
  function syncHomePreview(rec, remove) {
    const store = vueStore();
    if (!store) return;
    const ents = entitiesState(store);
    const pg = ents && ents.page && ents.page['homeListPreview-' + rec.type];
    const arr = pg && pg.pageData && pg.pageData[1];
    if (!Array.isArray(arr)) return;
    const inProgress = !remove
      && (rec.entry.status === 'CURRENT' || rec.entry.status === 'REPEATING');
    const has = arr.includes(rec.entry.id);
    if (inProgress && !has) {
      try {
        store.commit('setEntities', {
          listEntry: { [rec.entry.id]: entryEntity(rec) },
          media: { [rec.id]: mediaEntity(rec) },
        });
      } catch (e) { /* ignore */ }
      const timeOf = (id) => (ents.listEntry && ents.listEntry[id] && ents.listEntry[id].updatedAt) || 0;
      const idx = arr.findIndex((id) => timeOf(id) < (rec.entry.updatedAt || 0));
      if (idx === -1) arr.push(rec.entry.id);
      else arr.splice(idx, 0, rec.entry.id);
      // Real rows without a timestamp can't be compared against: fetch
      // them and let the preview re-sort once they arrive.
      if (arr.some((id) => !isCustomId(id) && !timeOf(id))) fillPreviewTimes(rec.type);
    } else if (!inProgress && has) {
      arr.splice(arr.indexOf(rec.entry.id), 1);
    }
  }

  /* ------------------------------------------------------------------ *
   * Generic response patching (runs on every worker RPC response)
   * ------------------------------------------------------------------ */

  // Profile favourites: page entities "favourite{Anime,Manga,Characters}-<uid>"
  // with pageData keyed by page number holding {favouriteOrder, node} edges.
  // Append the user's favourited custom entries/characters to the final page.
  function patchFavouritesResult(result) {
    const pages = result.entities.page;
    if (!pages) return;
    for (const key of Object.keys(pages)) {
      const m = key.match(/^favourite(Anime|Manga|Characters)-(\d+)$/);
      if (!m) continue;
      const p = pages[key];
      if (!p || !p.pageData || (p.pageInfo && p.pageInfo.hasNextPage)) continue;
      const uid = parseInt(m[2], 10);
      // Response form is a plain edge array; tolerate the stored
      // page-number-keyed form too.
      let arr = Array.isArray(p.pageData) ? p.pageData : null;
      if (!arr && typeof p.pageData === 'object') {
        const nums = Object.keys(p.pageData).map(Number).filter(Number.isFinite);
        if (nums.length) arr = p.pageData[Math.max(...nums)];
      }
      if (!Array.isArray(arr)) continue;
      const present = new Set(arr.map((e) => e && e.node));
      let order = 9000 + arr.length;
      if (m[1] === 'Characters') {
        for (const rec of allRecs()) {
          if (rec.ownerId !== uid) continue;
          for (const c of rec.characters || []) {
            if (!c.isFavourite || present.has(c.id)) continue;
            arr.push({ favouriteOrder: ++order, node: c.id });
            result.entities.character = result.entities.character || {};
            result.entities.character[c.id] = favCharacterEntity(c);
            if (p.pageInfo) p.pageInfo.total = (p.pageInfo.total || 0) + 1;
          }
        }
      } else {
        const type = m[1] === 'Anime' ? 'ANIME' : 'MANGA';
        for (const rec of allRecs()) {
          if (rec.ownerId !== uid || rec.type !== type || !rec.media.isFavourite || present.has(rec.id)) continue;
          arr.push({ favouriteOrder: ++order, node: rec.id });
          result.entities.media = result.entities.media || {};
          result.entities.media[rec.id] = mediaEntity(rec);
          if (p.pageInfo) p.pageInfo.total = (p.pageInfo.total || 0) + 1;
        }
      }
      applySavedFavOrder(m[1], p, arr);
    }
  }

  // Late injection: the profile's favourites arrive with the first User
  // query, which can run before the hooks; patch the store's pages the same
  // way, but only when a custom favourite is actually missing (the patch
  // re-sorts arrays, which would re-render every tick otherwise).
  function healFavourites() {
    const store = vueStore();
    const ents = store && entitiesState(store);
    if (!ents || !ents.page) return;
    let missing = false;
    for (const key of Object.keys(ents.page)) {
      const m = key.match(/^favourite(Anime|Manga|Characters)-(\d+)$/);
      if (!m) continue;
      const p = ents.page[key];
      if (!p || !p.pageData || (p.pageInfo && p.pageInfo.hasNextPage)) continue;
      const nums = Object.keys(p.pageData).map(Number).filter(Number.isFinite);
      const arr = Array.isArray(p.pageData) ? p.pageData : (nums.length ? p.pageData[Math.max(...nums)] : null);
      if (!Array.isArray(arr)) continue;
      const uid = parseInt(m[2], 10);
      const present = new Set(arr.map((e) => e && e.node));
      for (const rec of allRecs()) {
        if (rec.ownerId !== uid) continue;
        if (m[1] === 'Characters') { if ((rec.characters || []).some((c) => c.isFavourite && !present.has(c.id))) missing = true; }
        else if (rec.type === (m[1] === 'Anime' ? 'ANIME' : 'MANGA') && rec.media.isFavourite && !present.has(rec.id)) missing = true;
        if (missing) break;
      }
      if (missing) break;
    }
    if (!missing) return;
    const fake = { entities: { page: ents.page } };
    patchFavouritesResult(fake);
    const patch = {};
    if (fake.entities.media) patch.media = fake.entities.media;
    if (fake.entities.character) patch.character = fake.entities.character;
    if (Object.keys(patch).length) { try { store.commit('setEntities', patch); } catch (e) { /* ignore */ } }
  }

  // Re-apply a locally saved reorder (see cleanFavouriteOrder). Only when
  // the list fits one page; on multi-page lists customs stay appended.
  function applySavedFavOrder(kind, p, arr) {
    const type = kind === 'Anime' ? 'anime' : (kind === 'Manga' ? 'manga' : 'characters');
    const saved = db.favOrder && db.favOrder[type];
    if (!saved || !Array.isArray(saved.ids)) return;
    if (p.pageInfo && p.pageInfo.lastPage > 1) return;
    const pos = new Map(saved.ids.map((id, i) => [id, i]));
    arr.sort((a, b) => {
      const pa = pos.has(a && a.node) ? pos.get(a.node) : Infinity;
      const pb = pos.has(b && b.node) ? pos.get(b.node) : Infinity;
      return pa - pb;
    });
    arr.forEach((e, i) => { if (e) e.favouriteOrder = i + 1; });
  }

  function favCharacterEntity(c) {
    const img = c.image || DEFAULT_CHAR_IMG;
    const parts = charPartsOf(c);
    return {
      id: c.id,
      name: { userPreferred: parts.userPreferred, full: parts.full, native: null },
      image: { large: img, medium: img },
      isFavourite: true,
      isFavouriteBlocked: false,
      favourites: 0,
    };
  }

  /* --- search: the search pages (/search/anime|manga, worker RPC with
   * opts.page.id "<TYPE>-{<url filters>}") and the header quick search
   * (opts.schema "quickSearch") get the viewer's matching custom entries
   * prepended, so genre/tag links on a custom entry's page, the filter
   * page and the search box all loop back to them. --- */

  const normText = (v) => String(v || '').toLowerCase().trim();
  function recSearchTitles(rec) {
    const t = rec.media.title || {};
    return [t.userPreferred, t.romaji, t.english, t.native].concat(rec.media.synonyms || []).filter(Boolean).map(normText);
  }
  const listOf = (v) => (v === undefined || v === null ? [] : [].concat(v));
  // vars: the search RPC's variables, or the page-id JSON (URL filters,
  // where "genres" holds genres and tags alike). Only the viewer's entries.
  function customSearchHits(vars, type) {
    if (vars.id !== undefined && vars.id !== null) return [];
    const uid = authUserId();
    const q = normText(vars.search);
    const wanted = listOf(vars.genres).concat(listOf(vars.tags), listOf(vars.genre), listOf(vars.tag)).map(normText).filter(Boolean);
    const excluded = listOf(vars.excludedGenres).concat(listOf(vars.excludedTags)).map(normText).filter(Boolean);
    const formats = listOf(vars.format).filter(Boolean);
    const year = vars.year ? String(vars.year).replace(/%/g, '') : (vars.seasonYear ? String(vars.seasonYear) : '');
    const hasFilter = !!(q || wanted.length || excluded.length || formats.length || vars.status || vars.countryOfOrigin
      || year || vars.season || vars.onList !== undefined && vars.onList !== null);
    if (!hasFilter) return []; // the plain popularity browse stays as served
    const out = [];
    for (const rec of allRecs()) {
      if (rec.type !== type || (uid && rec.ownerId !== uid)) continue;
      const md = rec.media;
      if (vars.isAdult === false && md.isAdult) continue;
      if (q && !recSearchTitles(rec).some((t) => t.includes(q))) continue;
      const labels = new Set((md.genres || []).concat((md.tags || []).map((t) => t && t.name)).map(normText));
      if (wanted.some((g) => !labels.has(g))) continue;
      if (excluded.some((g) => labels.has(g))) continue;
      if (formats.length && !formats.includes(md.format)) continue;
      if (vars.status && md.status !== vars.status) continue;
      if (vars.countryOfOrigin && md.countryOfOrigin !== vars.countryOfOrigin) continue;
      if (year && String((md.startDate && md.startDate.year) || '') !== year) continue;
      if (vars.season && md.season !== undefined && md.season !== null && String(md.season) !== String(vars.season)) continue;
      if (vars.onList === true && !recIsListed(rec)) continue;
      if (vars.onList === false && recIsListed(rec)) continue;
      out.push(rec);
    }
    return out;
  }
  const searchTypeOf = (pageId) => (String(pageId).indexOf('ANIME-') === 0 ? 'ANIME' : (String(pageId).indexOf('MANGA-') === 0 ? 'MANGA' : null));

  // Sort-aware placement. Sorts with a value a custom entry really has
  // (title, start date, lengths, id) interleave it at its proper position,
  // page by page. Popularity / trending / score / favourites are things a
  // custom entry has none of, so descending sorts put it at the very end
  // (last page), ascending ones first; relevance (SEARCH_MATCH) keeps the
  // hits on top of the first page.
  const dateNum = (d) => (d && d.year ? d.year * 10000 + (d.month || 0) * 100 + (d.day || 0) : null);
  const SORT_VALUE = {
    TITLE_ROMAJI: (m) => (m.title && (m.title.romaji || m.title.userPreferred)) || null,
    TITLE_ENGLISH: (m) => (m.title && (m.title.english || m.title.userPreferred)) || null,
    TITLE_NATIVE: (m) => (m.title && (m.title.native || m.title.userPreferred)) || null,
    START_DATE: (m) => dateNum(m.startDate),
    END_DATE: (m) => dateNum(m.endDate),
    EPISODES: (m) => (typeof m.episodes === 'number' ? m.episodes : null),
    CHAPTERS: (m) => (typeof m.chapters === 'number' ? m.chapters : null),
    VOLUMES: (m) => (typeof m.volumes === 'number' ? m.volumes : null),
    DURATION: (m) => (typeof m.duration === 'number' ? m.duration : null),
    ID: (m) => m.id,
  };
  const NO_VALUE_SORTS = ['POPULARITY', 'TRENDING', 'SCORE', 'FAVOURITES'];
  function sortPlacement(sortVar) {
    if (searchBumpEnabled()) return { kind: 'top' };
    const sort = String(listOf(sortVar)[0] || '');
    const desc = /_DESC$/.test(sort);
    const key = sort.replace(/_DESC$/, '');
    if (NO_VALUE_SORTS.includes(key)) return { kind: desc ? 'bottom' : 'top' };
    if (!SORT_VALUE[key]) return { kind: 'top' };
    const get = SORT_VALUE[key];
    const cmp = (a, b) => {
      if (a === null || a === undefined) return (b === null || b === undefined) ? 0 : 1; // unknown last
      if (b === null || b === undefined) return -1;
      const r = typeof a === 'string' ? a.localeCompare(String(b), undefined, { sensitivity: 'base' }) : a - b;
      return desc ? -r : r;
    };
    return { kind: 'value', get, cmp };
  }

  // Add hits to a search page's id list plus their entities. `arr` is the
  // response's plain array or the store's page array; `mediaOf(id)` looks
  // up the real rows' media for value sorts. Returns how many were added.
  function injectSearchHits(arr, ents, hits, pageInfo, opts) {
    const o = opts || {};
    const place = sortPlacement(o.sort);
    const first = o.page === undefined || o.page === 1;
    const last = !(pageInfo && pageInfo.hasNextPage);
    let added = 0;
    const put = (rec, idx) => {
      if (idx < 0) arr.push(rec.id); else arr.splice(idx, 0, rec.id);
      ents.media = ents.media || {};
      ents.media[rec.id] = mediaEntity(rec);
      if (recIsListed(rec)) {
        ents.listEntry = ents.listEntry || {};
        ents.listEntry[rec.entry.id] = entryEntity(rec);
      }
      added++;
    };
    if (place.kind === 'top') {
      if (!first) return 0;
      for (let i = hits.length - 1; i >= 0; i--) if (!arr.includes(hits[i].id)) put(hits[i], 0);
    } else if (place.kind === 'bottom') {
      if (!last) return 0;
      for (const rec of hits) if (!arr.includes(rec.id)) put(rec, -1);
    } else {
      const valueOf = (id) => {
        const m = (ents.media && ents.media[id]) || (o.mediaOf && o.mediaOf(id)) || null;
        return m ? place.get(m) : null;
      };
      for (const rec of hits) {
        if (arr.includes(rec.id)) continue;
        const v = place.get(mediaEntity(rec));
        const real = arr.filter((id) => !isCustomId(id));
        // Belongs before the first real row: only on the first page.
        if (real.length && place.cmp(v, valueOf(real[0])) < 0) { if (first) put(rec, 0); continue; }
        // Between two real rows on this page.
        let idx = -1;
        for (let i = 0; i < real.length; i++) {
          if (place.cmp(v, valueOf(real[i])) < 0) { idx = arr.indexOf(real[i]); break; }
        }
        if (idx >= 0) { put(rec, idx); continue; }
        // After the last real row: this page only if it is the last one.
        if (last || !real.length) put(rec, -1);
      }
    }
    if (added && pageInfo && typeof pageInfo.total === 'number') pageInfo.total += added;
    return added;
  }

  function patchSearchResult(result, meta) {
    const ents = result.entities;
    const pg = ents && ents.page && ents.page[meta.pageId];
    if (!pg || !Array.isArray(pg.pageData)) return;
    const type = searchTypeOf(meta.pageId) || meta.vars.type;
    if (!type) return;
    const hits = customSearchHits(meta.vars, type);
    if (!hits.length) return;
    const store = vueStore();
    const sents = store && entitiesState(store);
    const mediaOf = (id) => (sents && sents.media && sents.media[id]) || null;
    const n = injectSearchHits(pg.pageData, ents, hits, pg.pageInfo, { sort: meta.vars.sort, page: meta.vars.page || 1, mediaOf });
    if (n) console.log(TAG, `injected ${n} custom entr${n === 1 ? 'y' : 'ies'} into search ${meta.pageId} page ${meta.vars.page || 1}`);
  }

  function patchQuickSearch(result, meta) {
    const ents = result.entities;
    const qs = ents && ents.page && ents.page.quickSearch;
    if (!qs || typeof qs !== 'object') return;
    const vars = meta.vars || {};
    for (const [key, type] of [['anime', 'ANIME'], ['manga', 'MANGA']]) {
      const sec = qs[key];
      if (!sec || !Array.isArray(sec.results)) continue;
      const hits = customSearchHits({ search: vars.search, isAdult: vars.isAdult }, type);
      if (hits.length) injectSearchHits(sec.results, ents, hits, sec.pageInfo);
    }
    // Local characters by name.
    const q = normText(vars.search);
    const cs = qs.characters;
    if (q && cs && Array.isArray(cs.results)) {
      const uid = authUserId();
      for (const rec of allRecs()) {
        if (uid && rec.ownerId !== uid) continue;
        for (const c of rec.characters || []) {
          if (!normText(c.name).includes(q) || cs.results.includes(c.id)) continue;
          cs.results.unshift(c.id);
          ents.character = ents.character || {};
          const img = c.image || DEFAULT_CHAR_IMG;
          const parts = charPartsOf(c);
          ents.character[c.id] = { id: c.id, name: { userPreferred: parts.userPreferred, full: parts.full, native: null }, image: { large: img, medium: img } };
          if (cs.pageInfo && typeof cs.pageInfo.total === 'number') cs.pageInfo.total += 1;
        }
      }
    }
  }

  // Late injection: a search page loaded directly (/search/manga?genres=…)
  // fires its query before the hooks exist; repair the store's page from the
  // filters encoded in its id. Idempotent by membership.
  function healSearchPages() {
    const store = vueStore();
    const ents = store && entitiesState(store);
    if (!ents || !ents.page) return;
    for (const key of Object.keys(ents.page)) {
      const type = searchTypeOf(key);
      if (!type || key.indexOf('-{') === -1) continue;
      let filters;
      try { filters = JSON.parse(key.slice(key.indexOf('-{') + 1)); } catch (e) { continue; }
      if (!filters || typeof filters !== 'object') continue;
      const pg = ents.page[key];
      const arr = pg && pg.pageData && pg.pageData[1];
      if (!Array.isArray(arr)) continue;
      const hits = customSearchHits(filters, type).filter((rec) => !arr.includes(rec.id));
      if (!hits.length) continue;
      const patch = {};
      const info = Object.assign({}, pg.pageInfo, { hasNextPage: !!(pg.pageInfo && pg.pageInfo.hasNextPage) || Object.keys(pg.pageData).length > 1 });
      const n = injectSearchHits(arr, patch, hits, info, { sort: filters.sort, page: 1, mediaOf: (id) => ents.media && ents.media[id] });
      if (n && pg.pageInfo && typeof pg.pageInfo.total === 'number') pg.pageInfo.total += n;
      if (n) { try { store.commit('setEntities', patch); } catch (e) { /* ignore */ } }
    }
  }

  /* --- backlinks: real media / character / staff pages list the custom
   * entries that point at them (a relation to Koiiro no Kyoukai shows on
   * Koiiro's page as the inverse relation; a real character or staff
   * person linked from a custom entry shows it in their roles). --- */

  const viewerRecs = () => { const uid = authUserId(); return allRecs().filter((r) => !uid || r.ownerId === uid); };
  const customRelationsTo = (mediaId) => {
    const out = [];
    for (const rec of viewerRecs()) for (const e of rec.relations || []) if (e.target === mediaId) out.push({ rec, edge: e });
    return out;
  };
  const customEntriesWithCharacter = (charId) => {
    const out = [];
    for (const rec of viewerRecs()) { const c = (rec.characters || []).find((x) => x.id === charId); if (c) out.push({ rec, c }); }
    return out;
  };
  const customEntriesWithStaff = (staffId, type) => {
    const out = [];
    for (const rec of viewerRecs()) {
      if (type && rec.type !== type) continue;
      for (const st of rec.staff || []) if (st.staffId === staffId) out.push({ rec, s: st });
    }
    return out;
  };
  // Custom entries that recommend `mediaId` (real or custom).
  const customRecsTo = (mediaId) => {
    const out = [];
    for (const rec of viewerRecs()) for (const rr of rec.recs || []) if (rr.target === mediaId) out.push({ rec, rr });
    return out;
  };
  const passesOnList = (rec, onList) => (onList === true ? recIsListed(rec) : (onList === false ? !recIsListed(rec) : true));

  // Real media entity: add inverse relation edges to the custom entries.
  function addMediaBacklinks(m, ents, backs) {
    if (!m || !m.relations || !Array.isArray(m.relations.edges)) return 0;
    let n = 0;
    for (const { rec, edge } of backs) {
      if (m.relations.edges.some((e) => e && e.node === rec.id)) continue;
      m.relations.edges.push({ id: edge.id, relationType: INVERSE_REL[edge.type] || 'OTHER', node: rec.id });
      ents.media = ents.media || {};
      ents.media[rec.id] = mediaEntity(rec);
      n++;
    }
    return n;
  }
  // Real media page's recommendation strip / tab: prepend cards for the
  // custom entries that recommend it ("users also like" → your entry).
  // `recEnts` is the recommendation entity table the list renders from, for
  // skipping pairs already present.
  function addRecBacklinks(arr, ents, pageInfo, hits, recEnts) {
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const { rec, rr } of hits) {
      if (arr.includes(rr.id)) continue;
      if (arr.some((rid) => { const e = recEnts && recEnts[rid]; return e && e.mediaRecommendation === rec.id; })) continue;
      arr.unshift(rr.id);
      ents.recommendation = ents.recommendation || {};
      ents.recommendation[rr.id] = recBacklinkEntity(rec, rr);
      ents.media = ents.media || {};
      ents.media[rec.id] = mediaEntity(rec);
      n++;
    }
    if (n && pageInfo && typeof pageInfo.total === 'number') pageInfo.total += n;
    return n;
  }
  function patchMediaBacklinks(result, meta) {
    const ents = result.entities;
    const n = addMediaBacklinks(ents && ents.media && ents.media[meta.id], ents, meta.backs);
    if (n) console.log(TAG, `added ${n} custom relation backlink${n === 1 ? '' : 's'} to media ${meta.id}`);
    const pg = ents && ents.page && ents.page['mediaRecommendations-' + meta.id];
    if (pg && (meta.page || 1) === 1 && meta.recBacks && meta.recBacks.length) {
      const k = addRecBacklinks(pg.pageData, ents, pg.pageInfo, meta.recBacks, ents.recommendation);
      if (k) console.log(TAG, `added ${k} custom recommendation backlink${k === 1 ? '' : 's'} to media ${meta.id}`);
    }
  }
  // Real character's roles page: prepend the custom entries it appears in.
  function addCharacterBacklinks(arr, ents, pageInfo, hits) {
    let n = 0;
    for (const { rec, c } of hits) {
      if (arr.some((e) => e && e.node === rec.id)) continue;
      arr.unshift({ id: rec.id, characterRole: c.role || 'MAIN', voiceActorRoles: [], node: rec.id });
      ents.media = ents.media || {};
      ents.media[rec.id] = mediaEntity(rec);
      n++;
    }
    if (n && pageInfo && typeof pageInfo.total === 'number') pageInfo.total += n;
    return n;
  }
  function patchCharacterBacklinks(result, meta) {
    const ents = result.entities;
    const pg = ents && ents.page && ents.page[meta.pageId];
    if (!pg || !Array.isArray(pg.pageData) || (meta.vars.page || 1) !== 1) return;
    const hits = customEntriesWithCharacter(meta.id).filter((h) => passesOnList(h.rec, meta.vars.onList));
    const n = addCharacterBacklinks(pg.pageData, ents, pg.pageInfo, hits);
    if (n) console.log(TAG, `added ${n} custom appearance${n === 1 ? '' : 's'} to character ${meta.id}`);
  }
  // Real staff person's roles page (per media type): prepend custom entries.
  function addStaffBacklinks(arr, ents, pageInfo, hits) {
    let n = 0;
    for (const { rec, s: st } of hits) {
      if (arr.some((e) => e && e.node === rec.id && e.staffRole === (st.role || ''))) continue;
      arr.unshift({ staffRole: st.role || '', node: rec.id });
      ents.media = ents.media || {};
      ents.media[rec.id] = mediaEntity(rec);
      n++;
    }
    if (n && pageInfo && typeof pageInfo.total === 'number') pageInfo.total += n;
    return n;
  }
  function patchStaffBacklinks(result, meta) {
    const ents = result.entities;
    const pg = ents && ents.page && ents.page[meta.pageId];
    if (!pg || !Array.isArray(pg.pageData) || (meta.vars.staffPage || 1) !== 1) return;
    const hits = customEntriesWithStaff(meta.id, meta.vars.type || null).filter((h) => passesOnList(h.rec, meta.vars.onList));
    const n = addStaffBacklinks(pg.pageData, ents, pg.pageInfo, hits);
    if (n) console.log(TAG, `added ${n} custom role${n === 1 ? '' : 's'} to staff ${meta.id}`);
  }
  // '<name>-{json}' page keys → their variables (parsed once; the heal runs
  // every UI tick over the store's page table).
  const pageKeyVarsCache = new Map();
  function pageKeyVars(key) {
    if (pageKeyVarsCache.has(key)) return pageKeyVarsCache.get(key);
    let v = null;
    try { v = JSON.parse(key.slice(key.indexOf('{'))); } catch (e) { v = null; }
    if (pageKeyVarsCache.size >= 300) pageKeyVarsCache.delete(pageKeyVarsCache.keys().next().value);
    pageKeyVarsCache.set(key, v);
    return v;
  }
  // Late injection: repair the store's pages / media entity in place.
  function healBacklinks() {
    const store = vueStore();
    const ents = store && entitiesState(store);
    if (!ents) return;
    const patch = {};
    let changed = 0;
    const m = location.pathname.match(/^\/(anime|manga)\/(\d+)/);
    if (m && !isCustomId(parseInt(m[2], 10)) && ents.media) {
      const me = ents.media[parseInt(m[2], 10)];
      const backs = me ? customRelationsTo(me.id) : [];
      if (backs.length) changed += addMediaBacklinks(me, patch, backs);
      const rpg = ents.page && ents.page['mediaRecommendations-' + m[2]];
      const rarr = rpg && rpg.pageData && rpg.pageData[1];
      if (Array.isArray(rarr)) changed += addRecBacklinks(rarr, patch, rpg.pageInfo, customRecsTo(parseInt(m[2], 10)), ents.recommendation);
    }
    for (const key of Object.keys(ents.page || {})) {
      const isChar = key.indexOf('characterMediaRoles-{') === 0;
      const isStaff = key.indexOf('staffMediaRoles-{') === 0;
      const isStudio = key.indexOf('studioMedia-{') === 0;
      if (!isChar && !isStaff && !isStudio) continue;
      const v = pageKeyVars(key);
      if (!v) continue;
      const id = parseInt(v && v.id, 10);
      if (!id || isCustomId(id)) continue;
      const pg = ents.page[key];
      const arr = pg && pg.pageData && pg.pageData[1];
      if (!Array.isArray(arr)) continue;
      if (isChar) changed += addCharacterBacklinks(arr, patch, pg.pageInfo, customEntriesWithCharacter(id).filter((h) => passesOnList(h.rec, v.onList)));
      else if (isStaff) changed += addStaffBacklinks(arr, patch, pg.pageInfo, customEntriesWithStaff(id, v.type || null).filter((h) => passesOnList(h.rec, v.onList)));
      else changed += addStudioBacklinks(arr, patch, pg.pageInfo, studioHits(id, v.onList));
    }
    if (changed && (patch.media || patch.recommendation)) {
      const ent = {};
      if (patch.media) ent.media = patch.media;
      if (patch.recommendation) ent.recommendation = patch.recommendation;
      try { store.commit('setEntities', ent); } catch (e) { /* ignore */ }
    }
  }

  // The Add Recommendation modal's media search pages are keyed
  // '<TYPE>-"rec-<query>"'. On a custom entry's page, prepend matching
  // custom entries so they can be recommended too.
  function patchRecSearch(result) {
    const rid = result.result;
    if (typeof rid !== 'string') return;
    const m = rid.match(/^(ANIME|MANGA)-"rec-(.*)"$/);
    if (!m) return;
    const rm = location.pathname.match(/^\/(anime|manga)\/(\d+)/);
    const selfId = rm ? parseInt(rm[2], 10) : 0;
    if (!selfId) return; // only from a media page (custom or real)
    const page = result.entities.page && result.entities.page[rid];
    if (!page || !page.pageData) return;
    let arr = Array.isArray(page.pageData) ? page.pageData : null;
    if (!arr) {
      const nums = Object.keys(page.pageData).map(Number).filter(Number.isFinite);
      if (nums.length) arr = page.pageData[Math.min(...nums)];
    }
    if (!Array.isArray(arr)) return;
    const q = m[2].toLowerCase();
    result.entities.media = result.entities.media || {};
    for (const rec of allRecs()) {
      if (rec.type !== m[1] || rec.id === selfId || arr.includes(rec.id)) continue;
      const hay = (rec.media.title.userPreferred + ' ' + (rec.media.synonyms || []).join(' ')).toLowerCase();
      if (!hay.includes(q)) continue;
      arr.unshift(rec.id);
      result.entities.media[rec.id] = mediaEntity(rec);
      if (page.pageInfo && typeof page.pageInfo.total === 'number') page.pageInfo.total += 1;
    }
  }

  function patchGenericResponse(result) {
    if (!result || !result.entities) return;
    patchFavouritesResult(result);
    patchRecSearch(result);
    patchUserStatistics(result);
  }

  /* --- AniList's tag catalog (MediaTagCollection), for enriching tags that
   * only carry a name (imports, the sidebar "+"): real id, category,
   * description (the hover bubble), adult flag. Cached for a week. --- */
  const TAG_CACHE_KEY = 'al-custom-entries-tags-v2';
  let tagCatalog = null; // Map(lowercase name → tag)
  function loadTagCatalog() {
    try {
      const raw = localStorage.getItem(TAG_CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && Array.isArray(c.tags) && nowSec() - (c.at || 0) < 7 * 86400) { setTagCatalog(c.tags); return; }
      }
    } catch (e) { /* refetch */ }
    nativeFetch.call(window, '/graphql', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query{MediaTagCollection{id name description category isAdult isGeneralSpoiler}}' }),
    }).then((r) => r.json()).then((j) => {
      const tags = j && j.data && j.data.MediaTagCollection;
      if (!Array.isArray(tags) || !tags.length) return;
      try { localStorage.setItem(TAG_CACHE_KEY, JSON.stringify({ at: nowSec(), tags })); } catch (e) { /* ignore */ }
      setTagCatalog(tags);
    }).catch(() => {});
  }
  function setTagCatalog(tags) {
    tagCatalog = new Map();
    for (const t of tags) if (t && t.name) tagCatalog.set(String(t.name).toLowerCase(), t);
    for (const rec of allRecs()) enrichRecTags(rec);
  }
  // In-memory only (no save, no sync churn): the stored record keeps just
  // what the user entered; the catalog fields ride along on every render.
  function enrichRecTags(rec) {
    if (!tagCatalog || !rec || !rec.media || !Array.isArray(rec.media.tags)) return;
    for (const t of rec.media.tags) {
      if (!t || !t.name || t.category) continue;
      const c = tagCatalog.get(String(t.name).toLowerCase());
      if (!c) continue;
      t.category = c.category || null;
      if (!t.description) t.description = c.description || null;
      if (c.isAdult) t.isAdult = true;
      if (c.isGeneralSpoiler) t.isGeneralSpoiler = true;
    }
  }
  const catalogTag = (name) => (tagCatalog ? tagCatalog.get(String(name || '').toLowerCase()) || null : null);

  // Profile / stats pages: User.statistics.{anime,manga} come straight from
  // the server, so custom entries are missing from "Chapters Read" and
  // friends. Add each listed custom entry of that user to the totals
  // (count, episodes/minutes watched, chapters/volumes read) and to the
  // breakdown buckets the response carries (statuses, formats, genres,
  // release/start years, countries, tags), whose mediaIds also get the
  // custom entry so the Stats pages' cards show its cover. Only fields the
  // response already has are touched; meanScore/standardDeviation stay as
  // served.
  // Chapter / episode count buckets, labelled the way the Stats pages do.
  function lengthBucket(rec) {
    const n = rec.type === 'ANIME' ? rec.media.episodes : rec.media.chapters;
    if (!n || n < 1) return null;
    if (n === 1) return '1';
    if (rec.type === 'ANIME') return n <= 6 ? '2-6' : n <= 16 ? '7-16' : n <= 28 ? '17-28' : n <= 55 ? '29-55' : n <= 100 ? '56-100' : '101+';
    return n <= 10 ? '2-10' : n <= 25 ? '11-25' : n <= 50 ? '26-50' : n <= 100 ? '51-100' : n <= 200 ? '101-200' : '201+';
  }
  // Scores: the profile reports meanScore on a 0-100 scale; entries are
  // scored in the account's format, so convert before blending.
  function score100(rec) {
    const sc = parseFloat(rec.entry && rec.entry.score);
    if (!Number.isFinite(sc) || sc <= 0) return null;
    const fmt = (ownerOpts(rec) || {}).scoreFormat || 'POINT_100';
    if (fmt === 'POINT_10' || fmt === 'POINT_10_DECIMAL') return Math.min(100, sc * 10);
    if (fmt === 'POINT_5') return Math.min(100, sc * 20);
    if (fmt === 'POINT_3') return sc >= 3 ? 85 : (sc >= 2 ? 60 : 35);
    return Math.min(100, sc);
  }
  const STAT_BUCKETS = {
    lengths: ['length', (rec) => [lengthBucket(rec)]],
    scores: ['score', (rec) => [rec.entry && rec.entry.score > 0 ? Math.round(rec.entry.score) : null]],
    formats: ['format', (rec) => [rec.media.format]],
    statuses: ['status', (rec) => [rec.entry.status]],
    releaseYears: ['releaseYear', (rec) => [rec.media.startDate && rec.media.startDate.year]],
    startYears: ['startYear', (rec) => [rec.entry.startedAt && rec.entry.startedAt.year]],
    countries: ['country', (rec) => [rec.media.countryOfOrigin]],
    genres: ['genre', (rec) => rec.media.genres || []],
    genrePreview: ['genre', (rec) => rec.media.genres || []],
    tags: ['tag', (rec) => (rec.media.tags || []).map((t) => t && t.name)],
    studios: ['studio', (rec) => studiosOf(rec).map((st) => st.name)],
  };
  const STAT_TOTALS = ['count', 'episodesWatched', 'minutesWatched', 'chaptersRead', 'volumesRead'];
  function recStatContribution(rec) {
    const e = rec.entry;
    const anime = rec.type === 'ANIME';
    const progress = Math.max(0, parseInt(e.progress, 10) || 0);
    return {
      count: 1,
      episodesWatched: anime ? progress : 0,
      minutesWatched: anime ? progress * Math.max(0, parseInt(rec.media.duration, 10) || 0) : 0,
      chaptersRead: anime ? 0 : progress,
      volumesRead: anime ? 0 : Math.max(0, parseInt(e.progressVolumes, 10) || 0),
    };
  }
  const bumpStatTotals = (obj, c) => {
    for (const k of STAT_TOTALS) if (typeof obj[k] === 'number') obj[k] += c[k];
  };
  const bucketMatches = (b, key, value) => ((key === 'tag' || key === 'studio')
    ? !!(b[key] && String(b[key].name).toLowerCase() === String(value).toLowerCase())
    : (key === 'genre' ? String(b.genre).toLowerCase() === String(value).toLowerCase() : b[key] === value));
  function newStatBucket(list, parent, key, value, listKey) {
    const b = {};
    const model = list[0];
    if (model) {
      for (const [k, v] of Object.entries(model)) {
        b[k] = Array.isArray(v) ? [] : (typeof v === 'number' ? 0 : null);
      }
    } else {
      b.count = 0;
      for (const k of ['meanScore', 'minutesWatched', 'episodesWatched', 'chaptersRead', 'volumesRead']) {
        if (typeof parent[k] === 'number' && k !== 'meanScore') b[k] = 0;
      }
      if (listKey !== 'genrePreview') b.mediaIds = [];
    }
    b[key] = (key === 'tag' || key === 'studio') ? { id: 0, name: value } : value;
    list.push(b);
    return b;
  }
  // Activity history heatmap (User.stats.activityHistory = [{date, amount,
  // level}]): the server keys days at 23:00 UTC (a fixed UTC+1 midnight; the
  // profile component shifts them into the viewer's zone itself) and
  // colours by an absolute level, observed as 1-3 → 1, 4-6 → 3, 7-9 → 5, …
  // Local activities are counted onto the same keys, so all of them, old
  // ones included, show up in the heatmap.
  const ACTIVITY_DAY_OFFSET = 82800;
  const activityLevel = (amount) => Math.min(10, Math.max(1, 2 * Math.ceil(amount / 3) - 1));
  // Idempotence (the same objects can be patched again from the store, see
  // healUserStatistics, and the store deep-merges partial responses): the
  // stats object carries a marker object with, per total, the value as it
  // stood after the bump, and per bucket list without mediaIds a signature;
  // buckets with mediaIds simply remember the entry. Anything already at
  // its post-bump value is left alone, anything reset by a fresh server
  // response is bumped again.
  const AH_MARK = '__alceHistory';
  const ST_MARK = '__alce';
  const historySum = (ah) => ah.reduce((n, d) => n + ((d && d.amount) || 0), 0);
  const listSig = (list, key) => JSON.stringify(list.map((b) => [key === 'tag' ? (b.tag && b.tag.name) : b[key], b.count]));
  function patchActivityHistory(u) {
    const ah = u.stats && u.stats.activityHistory;
    if (!Array.isArray(ah)) return;
    const acts = allActivities().filter((a) => a.ownerId === u.id && a.createdAt);
    if (!acts.length) return;
    if (u.stats[AH_MARK] !== undefined && u.stats[AH_MARK] === historySum(ah)) return;
    const known = ah.find((d) => d && typeof d.date === 'number');
    const offset = known ? ((known.date % 86400) + 86400) % 86400 : ACTIVITY_DAY_OFFSET;
    const dayKey = (t) => Math.floor((t - offset) / 86400) * 86400 + offset;
    const added = new Map();
    for (const a of acts) {
      const k = dayKey(a.createdAt);
      added.set(k, (added.get(k) || 0) + 1);
    }
    for (const [k, n] of added) {
      let d = ah.find((x) => x && x.date === k);
      if (!d) {
        d = { date: k, amount: 0, level: 0 };
        ah.push(d);
      }
      d.amount = (d.amount || 0) + n;
      d.level = Math.max(d.level || 0, activityLevel(d.amount));
    }
    ah.sort((x, y) => (x.date || 0) - (y.date || 0));
    u.stats[AH_MARK] = historySum(ah);
    console.log(TAG, `counted ${acts.length} local activit${acts.length === 1 ? 'y' : 'ies'} into user ${u.id} activity history`);
  }

  function patchUserStatistics(result) {
    if (!statsBumpEnabled()) return;
    if (result.entities.user) patchUsersStats(result.entities.user);
  }

  // The initial page-load queries can fire before the hooks exist (late
  // injection), so their User responses arrive unpatched; the same patch is
  // therefore also applied to the store's user entities on the UI tick.
  // Values are bumped in place (reactive), the markers make it a no-op once
  // the numbers already include the custom entries.
  function healUserStatistics() {
    if (!statsBumpEnabled()) return;
    const store = vueStore();
    const ents = store && entitiesState(store);
    if (ents && ents.user) patchUsersStats(ents.user);
  }

  function patchUsersStats(users) {
    for (const u of Object.values(users)) {
      if (!u || !u.id) continue;
      try { patchActivityHistory(u); } catch (e) { console.warn(TAG, 'activity history patch failed', e); }
      const stats = u.statistics;
      if (!stats) continue;
      for (const type of ['ANIME', 'MANGA']) {
        const st = stats[type === 'ANIME' ? 'anime' : 'manga'];
        if (!st || typeof st !== 'object') continue;
        const recs = allRecs().filter((r) => r.ownerId === u.id && r.type === type && r.entry.status);
        if (!recs.length) continue;
        const mark = (st[ST_MARK] && typeof st[ST_MARK] === 'object') ? st[ST_MARK] : {};
        const contribs = recs.map(recStatContribution);
        // Totals: per key, skip when still at the post-bump value.
        let touched = false;
        const countBefore = typeof st.count === 'number' ? st.count : 0;
        for (const k of STAT_TOTALS) {
          if (typeof st[k] !== 'number' || mark[k] === st[k]) continue;
          for (const c of contribs) st[k] += c[k];
          mark[k] = st[k];
          touched = true;
        }
        // Mean score: blend the custom entries' scores (converted to 0-100)
        // into the served mean. The server's mean averages scored entries
        // only and their number isn't served, so the served count stands in
        // for it; a mean of 0 means nothing scored, then only custom scores
        // count.
        if (typeof st.meanScore === 'number' && mark.meanScore !== st.meanScore) {
          const scored = recs.map(score100).filter((v) => v !== null);
          if (scored.length) {
            const nReal = st.meanScore > 0 ? Math.max(0, countBefore) : 0;
            const sum = st.meanScore * nReal + scored.reduce((a, b) => a + b, 0);
            st.meanScore = Math.round((sum / (nReal + scored.length)) * 10) / 10;
            touched = true;
          }
          mark.meanScore = st.meanScore;
        }
        // Breakdown buckets.
        for (const [listKey, [key, valuesOf]] of Object.entries(STAT_BUCKETS)) {
          const list = st[listKey];
          if (!Array.isArray(list)) continue;
          const byIds = list.length ? Array.isArray(list[0].mediaIds) : listKey !== 'genrePreview';
          if (!byIds && mark[listKey] === listSig(list, key)) continue;
          for (let i = 0; i < recs.length; i++) {
            const rec = recs[i];
            const c = contribs[i];
            for (const value of valuesOf(rec)) {
              // "Unknown" length is a real bucket (length: null); every other
              // list skips missing values.
              if (value === undefined || value === '' || (value === null && listKey !== 'lengths')) continue;
              const b = list.find((x) => x && bucketMatches(x, key, value)) || newStatBucket(list, st, key, value, listKey);
              if (byIds) {
                if (!Array.isArray(b.mediaIds)) b.mediaIds = [];
                if (b.mediaIds.includes(rec.id)) continue;
                b.mediaIds.push(rec.id); // the cards' cover strips fetch these; custom ones are answered locally (onOutgoing)
              }
              bumpStatTotals(b, c);
              touched = true;
            }
          }
          if (!byIds) mark[listKey] = listSig(list, key);
        }
        st[ST_MARK] = mark;
        if (touched) console.log(TAG, `counted ${recs.length} custom ${type.toLowerCase()} entr${recs.length === 1 ? 'y' : 'ies'} into user ${u.id} statistics`);
      }
    }
  }


  // UpdateFavouriteOrder sends paired arrays (mangaIds in the new order +
  // mangaOrder [1..n]). Custom ids must not reach the server, but dropping
  // the whole mutation would lose the real entries' reorder too. So: save
  // the full requested order locally (per type), strip custom ids from the
  // variables, and forward the cleaned mutation. Returns the cleaned vars,
  // or null when nothing custom was present.
  const FAV_ORDER_KEYS = [
    ['animeIds', 'animeOrder', 'anime'],
    ['mangaIds', 'mangaOrder', 'manga'],
    ['characterIds', 'characterOrder', 'characters'],
    ['staffIds', 'staffOrder', 'staff'],
    ['studioIds', 'studioOrder', 'studios'],
  ];

  function cleanFavouriteOrder(vars) {
    let changed = false;
    const out = Object.assign({}, vars);
    for (const [idsKey, orderKey, type] of FAV_ORDER_KEYS) {
      const ids = vars[idsKey];
      if (!Array.isArray(ids) || !ids.some(isCustomId)) continue;
      changed = true;
      db.favOrder = db.favOrder || {};
      db.favOrder[type] = { ids: ids.slice(), at: nowSec() };
      const kept = ids.filter((id) => !isCustomId(id));
      out[idsKey] = kept;
      if (Array.isArray(vars[orderKey])) out[orderKey] = kept.map((_, i) => i + 1);
    }
    if (!changed) return null;
    saveDB();
    console.log(TAG, 'stored favourites order locally; forwarding cleaned reorder');
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Worker interception
   * ------------------------------------------------------------------ */

  function respond(w, id, result) {
    setTimeout(() => {
      w.dispatchEvent(new MessageEvent('message', { data: { type: 'RPC', id, result } }));
    }, 0);
  }

  // Returns true when the RPC was handled locally (do not forward).
  function onOutgoing(w, msg) {
    if (!msg || msg.type !== 'RPC' || msg.method !== 'fetch' || !Array.isArray(msg.params)) return false;
    const [, query, varsRaw, , optsRaw] = msg.params;
    const vars = varsRaw || {};
    const opts = optsRaw || {};

    // Own/other list collections: forward, then patch the response in place.
    if (opts.schema === 'mediaList' && typeof query === 'string' && query.includes('MediaListCollection')) {
      w.__alPending.set(msg.id, { kind: 'collection', type: vars.type });
      return false;
    }

    // Home/profile activity feeds and the home "in progress" previews:
    // forward, then inject local records into the response.
    const pageOpt = opts.page;
    if (pageOpt && pageOpt.id) {
      const pid = String(pageOpt.id);
      if (pageOpt.schema === 'activity' && (pid.indexOf('homeActivity-') === 0 || pid.indexOf('userActivity-') === 0)) {
        w.__alPending.set(msg.id, { kind: 'activityFeed', pageId: pid, vars });
        return false;
      }
      if (pageOpt.schema === 'notification' && pid.indexOf('notifications-') === 0) {
        w.__alPending.set(msg.id, { kind: 'notifications', pageId: pid, feed: pid.slice('notifications-'.length), page: vars.page });
        return false;
      }
      // Search pages: forward, then prepend matching custom entries.
      if (pageOpt.key === 'media' && searchTypeOf(pid) && pid.indexOf('-{') !== -1) {
        w.__alPending.set(msg.id, { kind: 'search', pageId: pid, vars });
        return false;
      }
      // Profile Reviews tab: forward, then prepend the user's local reviews.
      if (pid.indexOf('userReviews-') === 0 && pageOpt.key === 'reviews') {
        w.__alPending.set(msg.id, { kind: 'userReviews', pageId: pid, userId: pid.slice('userReviews-'.length), vars });
        return false;
      }
      if (pid.indexOf('homeListPreview-') === 0) {
        // The site's query selects only `id status score progress
        // progressVolumes media{…}` on each row: without `updatedAt` on the
        // real rows, the time-merge below would see them all as 0 and pin
        // every custom entry on top. Ask for it (a harmless extra field,
        // normalizr just keeps it on the listEntry entity) so custom
        // entries interleave by their real last-updated position.
        if (typeof query === 'string') {
          const q2 = query.replace(/(mediaList\s*\([^)]*\)\s*\{)([^{}]*)/, (m, head, fields) =>
            (/\bupdatedAt\b/.test(fields) ? m : head + 'updatedAt ' + fields));
          if (q2 !== query) msg.params[1] = q2;
        }
        w.__alPending.set(msg.id, { kind: 'listPreview', pageId: pid, type: vars.type, userId: vars.userId });
        return false;
      }
    }

    if (opts.schema === 'quickSearch') {
      w.__alPending.set(msg.id, { kind: 'quickSearch', vars });
      return false;
    }
    // Logged-in viewer: the nav badge counts local unread reminders too.
    if (opts.schema === 'user' && opts.root === 'Viewer' && typeof query === 'string' && /\bViewer\b/.test(query)) {
      w.__alPending.set(msg.id, { kind: 'viewer' });
      return false;
    }

    if (typeof query !== 'string') return false;

    // Backlinks on real pages (forwarded, then patched in the response).
    if (vars.id !== undefined && vars.id !== null && !isCustomId(vars.id)) {
      const rid = parseInt(vars.id, 10);
      if (rid && opts.schema === 'media' && /\bMedia\(/.test(query)) {
        const backs = customRelationsTo(rid);
        const recBacks = customRecsTo(rid);
        if (backs.length || recBacks.length) w.__alPending.set(msg.id, { kind: 'mediaBacklinks', id: rid, backs, recBacks, page: vars.page });
      } else if (rid && opts.schema === 'character' && vars.withRoles && pageOpt && pageOpt.id) {
        if (customEntriesWithCharacter(rid).length) w.__alPending.set(msg.id, { kind: 'characterBacklinks', id: rid, pageId: String(pageOpt.id), vars });
      } else if (rid && opts.schema === 'staff' && vars.withStaffRoles && pageOpt && pageOpt.id) {
        if (customEntriesWithStaff(rid, vars.type || null).length) w.__alPending.set(msg.id, { kind: 'staffBacklinks', id: rid, pageId: String(pageOpt.id), vars });
      } else if (rid && opts.schema === 'studio' && pageOpt && pageOpt.id) {
        if (customEntriesWithStudio(rid).length) w.__alPending.set(msg.id, { kind: 'studioBacklinks', id: rid, pageId: String(pageOpt.id), vars });
      }
    }

    if (query.includes('SaveMediaListEntry') && (isCustomId(vars.mediaId) || isCustomId(vars.id))) {
      respond(w, msg.id, handleSave(vars));
      return true;
    }
    // Stats pages fetch the cards' cover strips as Page{media(id_in:$ids)}.
    // Custom ids in there (from the statistics patch) are answered from the
    // local records: stripped from the forwarded query and spliced into the
    // response, or the whole thing answered locally when nothing real is left.
    if (Array.isArray(vars.ids) && vars.ids.some(isCustomId) && /\bmedia\(id_in:/.test(query)) {
      const media = {};
      const found = [];
      for (const v of vars.ids) {
        if (!isCustomId(v)) continue;
        const rec = recById(parseInt(v, 10));
        if (rec) { media[rec.id] = mediaEntity(rec); found.push(rec.id); }
      }
      const realIds = vars.ids.filter((v) => !isCustomId(v));
      if (!realIds.length) {
        respond(w, msg.id, { result: found, entities: { media } });
        return true;
      }
      msg.params[2] = Object.assign({}, vars, { ids: realIds });
      w.__alPending.set(msg.id, { kind: 'mediaByIds', ids: found, media });
      return false;
    }
    if (query.includes('DeleteMediaListEntry') && isCustomId(vars.id)) {
      respond(w, msg.id, handleDelete(vars));
      return true;
    }
    if (query.includes('ToggleFavourite') && Object.values(vars).some(isCustomId)) {
      respond(w, msg.id, handleFav(vars));
      return true;
    }
    if (query.includes('DeleteRecommendation') && isCustomId(vars.id)) {
      respond(w, msg.id, handleDeleteRecommendation(vars));
      return true;
    }
    if (query.includes('SaveRecommendation') && (isCustomId(vars.mediaId) || isCustomId(vars.mediaRecommendationId))) {
      respond(w, msg.id, handleSaveRecommendation(vars));
      return true;
    }
    if (isCustomId(vars.id) && /\bCharacter\(/.test(query)) {
      respond(w, msg.id, characterPageResult(parseInt(vars.id, 10), vars));
      return true;
    }
    if (isCustomId(vars.id) && /\bStaff\(/.test(query)) {
      respond(w, msg.id, staffPageResult(parseInt(vars.id, 10), vars, opts));
      return true;
    }
    if (isCustomId(vars.id) && /\bStudio\(/.test(query)) {
      respond(w, msg.id, studioPageResult(parseInt(vars.id, 10), vars, opts));
      return true;
    }
    // Reviews on custom entries: the editor's lookup (mediaId + userId), the
    // review page (id), saving, rating and deleting.
    if (/\bReview\(/.test(query) && (isCustomId(vars.mediaId) || isCustomId(vars.id))) {
      let hit = isCustomId(vars.id) ? findReview(parseInt(vars.id, 10)) : null;
      if (!hit && isCustomId(vars.mediaId)) {
        const rec = recById(parseInt(vars.mediaId, 10));
        const uid = vars.userId !== undefined && vars.userId !== null ? parseInt(vars.userId, 10) : authUserId();
        const rv = rec && (rec.reviews || []).find((x) => x.userId === uid);
        if (rec && rv) hit = { rec, rv };
      }
      respond(w, msg.id, hit ? reviewResult(hit.rec, hit.rv) : { result: null, entities: {} });
      return true;
    }
    if (query.includes('SaveReview') && (isCustomId(vars.mediaId) || isCustomId(vars.id))) {
      respond(w, msg.id, handleSaveReview(vars));
      return true;
    }
    if (query.includes('RateReview') && (isCustomId(vars.id) || isCustomId(vars.reviewId))) {
      respond(w, msg.id, handleRateReview(vars));
      return true;
    }
    if (query.includes('DeleteReview') && isCustomId(vars.id)) {
      respond(w, msg.id, handleDeleteReview(vars));
      return true;
    }
    // Replies on a local activity: list, post, edit.
    const replyAct = isCustomId(vars.activityId) ? activityById(vars.activityId)
      : (isCustomId(vars.id) ? activityById(vars.id) : null);
    if (replyAct && query.includes('activityReplies(')) {
      respond(w, msg.id, activityRepliesResult(replyAct, vars));
      return true;
    }
    if (replyAct && query.includes('SaveActivityReply')) {
      const r = saveLocalReply(replyAct, vars);
      respond(w, msg.id, {
        result: r.id,
        entities: {
          activityReply: { [r.id]: replyEntity(replyAct, r) },
          user: { [r.userId]: activityUserEntity(r.userId) },
          activity: { [replyAct.id]: activityEntity(replyAct) },
        },
      });
      return true;
    }
    // Like / delete on a local reply (its id is a custom id too).
    const replyHit = isCustomId(vars.id) && !activityById(vars.id) ? findReply(vars.id) : null;
    if (replyHit) {
      if (/ToggleLike/.test(query)) {
        replyHit.r.isLiked = !replyHit.r.isLiked;
        replyHit.r.likeCount = Math.max(0, (replyHit.r.likeCount || 0) + (replyHit.r.isLiked ? 1 : -1));
        touchAct(replyHit.a);
        saveDB();
        respond(w, msg.id, { result: replyHit.r.id, entities: { activityReply: { [replyHit.r.id]: replyEntity(replyHit.a, replyHit.r) } } });
        return true;
      }
      if (query.includes('DeleteActivityReply')) {
        deleteLocalReply(replyHit.a, replyHit.r);
        respond(w, msg.id, { result: null, entities: {} });
        return true;
      }
      if (query.includes('SaveActivityReply')) { // edit passes only the reply id
        const r = saveLocalReply(replyHit.a, vars);
        respond(w, msg.id, {
          result: r.id,
          entities: { activityReply: { [r.id]: replyEntity(replyHit.a, r) } },
        });
        return true;
      }
    }
    // Interactions with a local activity (like, delete, subscribe, permalink).
    const act = isCustomId(vars.id) ? activityById(vars.id) : null;
    if (act) {
      if (/ToggleLike/.test(query)) {
        act.isLiked = !act.isLiked;
        act.likeCount = Math.max(0, (act.likeCount || 0) + (act.isLiked ? 1 : -1));
        touchAct(act);
        saveDB();
        respond(w, msg.id, { result: act.id, entities: { activity: { [act.id]: activityEntity(act) } } });
        return true;
      }
      if (query.includes('DeleteActivity')) {
        markDeleted(act.id);
        delete db.activities[act.id];
        saveDB();
        removeActivityLive(act);
        respond(w, msg.id, { result: null, entities: {} });
        return true;
      }
      if (query.includes('ToggleActivitySubscription')) {
        act.isSubscribed = vars.subscribe !== undefined ? !!vars.subscribe : !act.isSubscribed;
        touchAct(act);
        saveDB();
        respond(w, msg.id, { result: act.id, entities: { activity: { [act.id]: activityEntity(act) } } });
        return true;
      }
      if (/\bActivity\(/.test(query)) {
        respond(w, msg.id, activityDetailResult(act));
        return true;
      }
    }
    const mid = isCustomId(vars.mediaId) ? vars.mediaId : (isCustomId(vars.id) ? vars.id : null);
    if (mid && /\bMedia\(/.test(query)) {
      respond(w, msg.id, handleMediaQuery(mid));
      return true;
    }
    // Favourites reorder: strip custom ids, store the order, forward the rest.
    if (/animeIds|mangaIds|characterIds/.test(query)) {
      const cleaned = cleanFavouriteOrder(vars);
      if (cleaned) {
        msg.params[2] = cleaned;
        return false; // forward the cleaned mutation
      }
    }
    // Catch-all: any other query whose variables reference a custom id (e.g.
    // the media page's Threads / following-status Page queries) must never
    // reach the server. Answer with an empty normalized result.
    if (refsCustomId(vars, 0)) {
      respond(w, msg.id, { result: null, entities: {} });
      console.log(TAG, 'answered unrecognized custom-id query locally:', query.slice(0, 60));
      return true;
    }
    return false;
  }

  const DEBUG_RPC = () => { try { return !!localStorage.getItem('alce-debug'); } catch (e) { return false; } };

  function hookWorker(w) {
    w.__alPending = new Map();
    // Our listener is registered before the site's RPC client attaches its
    // own, so in-place mutation of e.data.result is seen by the site.
    w.addEventListener('message', (e) => {
      const d = e.data;
      if (DEBUG_RPC() && d && d.type === 'RPC' && d.result) {
        try {
          console.log(TAG, 'DBG RPC-in', d.id, 'result:', JSON.stringify(d.result.result).slice(0, 200),
            'entityTypes:', Object.keys(d.result.entities || {}).join(','));
        } catch (err) { /* ignore */ }
      }
      if (d && d.type === 'RPC' && d.id && w.__alPending.has(d.id)) {
        const meta = w.__alPending.get(d.id);
        w.__alPending.delete(d.id);
        if (d.result) {
          try {
            if (meta.kind === 'activityFeed') patchActivityFeed(d.result, meta);
            else if (meta.kind === 'notifications') patchNotifications(d.result, meta);
            else if (meta.kind === 'viewer') patchViewer(d.result);
            else if (meta.kind === 'listPreview') patchListPreview(d.result, meta);
            else if (meta.kind === 'search') patchSearchResult(d.result, meta);
            else if (meta.kind === 'quickSearch') patchQuickSearch(d.result, meta);
            else if (meta.kind === 'mediaBacklinks') patchMediaBacklinks(d.result, meta);
            else if (meta.kind === 'characterBacklinks') patchCharacterBacklinks(d.result, meta);
            else if (meta.kind === 'staffBacklinks') patchStaffBacklinks(d.result, meta);
            else if (meta.kind === 'studioBacklinks') patchStudioBacklinks(d.result, meta);
            else if (meta.kind === 'userReviews') patchUserReviews(d.result, meta);
            else if (meta.kind === 'mediaByIds') {
              const r = d.result;
              r.result = (Array.isArray(r.result) ? r.result : []).concat(meta.ids);
              r.entities = r.entities || {};
              r.entities.media = Object.assign(r.entities.media || {}, meta.media);
            }
            else patchListResult(d.result, meta);
          } catch (err) { console.warn(TAG, 'response patch failed', err); }
        }
      }
      if (d && d.type === 'RPC' && d.result) {
        try { patchGenericResponse(d.result); }
        catch (err) { console.warn(TAG, 'generic patch failed', err); }
      }
    });
    const nativePost = w.postMessage.bind(w);
    w.postMessage = function (msg, ...rest) {
      try {
        if (DEBUG_RPC() && msg && msg.method === 'fetch' && Array.isArray(msg.params)) {
          const [, q, v, , o] = msg.params;
          console.log(TAG, 'DBG RPC-out', msg.id, 'opts:', JSON.stringify(o || {}).slice(0, 200),
            'query:', String(q).replace(/\s+/g, ' ').slice(0, 300), 'vars:', JSON.stringify(v).slice(0, 300));
        }
        if (onOutgoing(w, msg)) { audit.handledLocal++; return; } // never hits the network
        // Tripwire: anything still going to the worker must be custom-id-free.
        if (msg && msg.method === 'fetch' && Array.isArray(msg.params)) {
          tripwire('worker', msg.params[1], msg.params[2] || {});
        }
      } catch (err) {
        console.warn(TAG, 'outgoing intercept failed', err);
      }
      return nativePost(msg, ...rest);
    };
  }

  // Some mutations (e.g. ToggleFavourite) bypass the worker and use a direct
  // main-thread GraphQLClient on window.fetch. Guard those too so a custom id
  // can never leak to the server.
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (url && url.includes('/graphql') && init && typeof init.body === 'string') {
        const body = JSON.parse(init.body);
        const vars = (body && body.variables) || {};
        const query = String((body && body.query) || '');
        const data = handleDirectGraphQL(query, vars);
        if (data !== null) {
          audit.handledLocal++;
          return Promise.resolve(new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        // Favourites reorder: strip custom ids, store the order locally, and
        // forward the cleaned mutation so real favourites still reorder.
        if (/animeIds|mangaIds|characterIds/.test(query)) {
          const cleaned = cleanFavouriteOrder(vars);
          if (cleaned) {
            audit.handledLocal++;
            const newInit = Object.assign({}, init, {
              body: JSON.stringify(Object.assign({}, body, { variables: cleaned })),
            });
            return nativeFetch.call(this, input, newInit);
          }
        }
        // Edit page dialogs ("Add Relation", and any other results:media
        // search) query the server directly; forward, then prepend the
        // viewer's matching custom entries so custom ↔ custom relations can
        // be made natively.
        const ctxRec = editPageRec();
        if (ctxRec && /results\s*:\s*media\s*\(/.test(query) && typeof vars.search === 'string' && vars.search.trim()) {
          tripwire('fetch', query, vars);
          const hits = editSearchHits(ctxRec, vars);
          const p = nativeFetch.apply(this, arguments);
          if (!hits.length) return p;
          return p.then((res) => res.json().then((j) => {
            try {
              const pg = j && j.data && j.data.Page;
              if (pg && Array.isArray(pg.results)) {
                const have = new Set(pg.results.map((m) => m && m.id));
                pg.results = hits.filter((rec) => !have.has(rec.id)).map(editSearchStub).concat(pg.results);
                if (pg.pageInfo && typeof pg.pageInfo.total === 'number') pg.pageInfo.total += hits.length;
              }
            } catch (e) { /* keep server payload */ }
            return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }).catch(() => nativeFetch.apply(window, arguments)));
        }
        tripwire('fetch', query, vars); // clean request → forwarded below
      }
    } catch (e) { /* fall through to the real fetch */ }
    return nativeFetch.apply(this, arguments);
  };

  // Custom entries matching an edit-page media search (title/synonym
  // substring, optional type), the entry being edited excluded.
  function editSearchHits(ctxRec, vars) {
    const q = normText(vars.search);
    if (!q) return [];
    return viewerRecs().filter((rec) => rec.id !== ctxRec.id
      && (!vars.type || rec.type === vars.type)
      && recSearchTitles(rec).some((t) => t.includes(q)));
  }
  function editSearchStub(rec) {
    const md = rec.media;
    const t = md.title || {};
    const cov = md.coverImage || {};
    return {
      id: rec.id, type: rec.type, format: md.format || null, status: md.status || null, isAdult: !!md.isAdult,
      title: { userPreferred: t.userPreferred, romaji: t.romaji || t.userPreferred, english: t.english || null, native: t.native || null },
      coverImage: { medium: cov.medium || cov.large || null, large: cov.large || cov.medium || null },
      startDate: md.startDate || { year: null, month: null, day: null },
      bannerImage: md.bannerImage || null,
    };
  }

  const NativeWorker = window.Worker;
  function PatchedWorker(url, opts) {
    if (DEBUG_RPC()) console.log(TAG, 'DBG Worker constructed:', String(url).slice(0, 200), JSON.stringify(opts || null));
    const w = new NativeWorker(url, opts);
    try {
      if (/worker\.js/i.test(String(url))) hookWorker(w);
    } catch (e) { console.warn(TAG, 'hook failed', e); }
    return w;
  }
  PatchedWorker.prototype = NativeWorker.prototype;
  Object.defineProperty(PatchedWorker, 'name', { value: 'Worker' });
  window.Worker = PatchedWorker;
  console.log(TAG, 'worker interception installed; run ALcustom.audit() to verify no custom traffic reaches AniList');

  /* ------------------------------------------------------------------ *
   * Vuex live sync (so changes appear without reloading the list)
   * ------------------------------------------------------------------ */

  function vueStore() {
    const app = document.querySelector('#app');
    const vm = app && app.__vue__;
    return vm ? vm.$store : null;
  }

  function entitiesState(store) {
    const s = store.state;
    if (s.entities && s.entities.listSection !== undefined) return s.entities;
    for (const k of Object.keys(s)) {
      if (s[k] && typeof s[k] === 'object' && s[k].entities) return s[k].entities;
    }
    return s.entities || null;
  }

  // Adds/removes rec's entry id in the store's listSection arrays to match
  // the entry's current status/custom lists. `remove` clears it everywhere.
  function syncSections(rec, remove) {
    const store = vueStore();
    if (!store) return;
    const ents = entitiesState(store);
    if (!ents || !ents.listSection) return;

    const typeL = rec.type.toLowerCase();
    const prefix = `${rec.ownerId}-${typeL}-`;
    const mlId = `${rec.ownerId}-${typeL}`;
    const desired = remove ? [] : sectionNamesFor(rec);
    const desiredNames = new Set(desired.map((d) => d.name));
    const patch = { listSection: {} };
    const seen = new Set();
    let changed = false;

    for (const [sid, sec] of Object.entries(ents.listSection)) {
      if (!sid.startsWith(prefix) || !sec || !Array.isArray(sec.entries)) continue;
      seen.add(sec.name);
      const has = sec.entries.includes(rec.entry.id);
      const want = desiredNames.has(sec.name);
      if (has && !want) {
        patch.listSection[sid] = Object.assign({}, sec, {
          entries: sec.entries.filter((id) => id !== rec.entry.id),
        });
        changed = true;
      } else if (!has && want) {
        patch.listSection[sid] = Object.assign({}, sec, {
          entries: sec.entries.concat([rec.entry.id]),
        });
        changed = true;
      }
    }

    const ml = ents.mediaList && ents.mediaList[mlId];
    const newSids = [];
    for (const d of desired) {
      if (seen.has(d.name)) continue;
      const sid = prefix + d.name;
      patch.listSection[sid] = {
        name: d.name,
        isCustomList: d.isCustomList,
        isCompletedList: d.isCompletedList,
        entries: [rec.entry.id],
      };
      newSids.push(sid);
      changed = true;
    }
    if (ml && newSids.length) {
      patch.mediaList = {
        [mlId]: Object.assign({}, ml, { lists: ml.lists.concat(newSids) }),
      };
    }

    if (!remove) {
      patch.listEntry = { [rec.entry.id]: entryEntity(rec) };
      patch.media = { [rec.id]: mediaEntity(rec) };
      changed = true;
    }

    if (changed) {
      try { store.commit('setEntities', patch); }
      catch (e) { console.warn(TAG, 'store commit failed', e); }
    }
  }

  /* ------------------------------------------------------------------ *
   * Metadata import providers (MangaBaka + MAL via Jikan)
   * ------------------------------------------------------------------ */

  const META_STATUS_MB = {
    releasing: 'RELEASING', completed: 'FINISHED', hiatus: 'HIATUS',
    cancelled: 'CANCELLED', upcoming: 'NOT_YET_RELEASED',
  };
  const META_STATUS_JIKAN = {
    Finished: 'FINISHED', Publishing: 'RELEASING', 'On Hiatus': 'HIATUS',
    Discontinued: 'CANCELLED', 'Not yet published': 'NOT_YET_RELEASED',
    'Finished Airing': 'FINISHED', 'Currently Airing': 'RELEASING', 'Not yet aired': 'NOT_YET_RELEASED',
  };
  const META_FORMAT_JIKAN = {
    Manga: 'MANGA', Manhwa: 'MANGA', Manhua: 'MANGA', Doujinshi: 'MANGA', 'One-shot': 'ONE_SHOT',
    Novel: 'NOVEL', 'Light Novel': 'NOVEL',
    TV: 'TV', 'TV Special': 'SPECIAL', Movie: 'MOVIE', OVA: 'OVA', ONA: 'ONA',
    Special: 'SPECIAL', Music: 'MUSIC', PV: 'ONA', CM: 'ONA',
  };

  const titleCase = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // Imported descriptions are plain text with markdown-lite (MangaBaka) or
  // newlines (MAL); AniList renders media.description as HTML, so convert:
  // escape, then **bold**/*italic*, then newlines -> <br>.
  function descToHtml(text) {
    if (!text) return null;
    let s = String(text)
      .replace(/\r\n/g, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
      .replace(/__([^_\n]+)__/g, '<b>$1</b>');
    return s.replace(/\n/g, '<br>');
  }

  // Jikan 504s when its own upstream (MyAnimeList) refuses to connect, often
  // intermittently for the same URL (jikan-me/jikan-rest#610), so one retry is
  // worth it. Exactly one: Jikan rate-limits (~3/s) and hammering a sustained
  // outage just converts 504s into 429s that then break its healthy endpoints
  // too. 4xx (including 429) never retries.
  async function metaFetchJson(url) {
    for (let attempt = 0; ; attempt++) {
      const res = await nativeFetch(url);
      if (res.ok) return res.json();
      if (res.status < 500 || attempt >= 1) throw new Error(httpErrText(res.status));
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  // Search errors render as "<source>: <text>", so keep these short and plain.
  function httpErrText(status) {
    if (status === 429) return 'rate limited, wait a moment (429)';
    if (status >= 500) return 'source unavailable (' + status + ')';
    if (status === 404) return 'not found (404)';
    if (status === 403) return 'refused (403)';
    return 'HTTP ' + status;
  }

  /* ------------------------------------------------------------------ *
   * Cross-origin requests through the script manager
   *
   * MangaDex, Dynasty Reader and RanobeDB send no CORS headers for
   * anilist.co, so window.fetch can never read them. GM_xmlhttpRequest
   * runs at extension level instead: no CORS, no cookies (anonymous), no
   * Referer, and it can return a Blob for images. It is feature-detected;
   * without it those providers report themselves unavailable and image
   * embedding falls back to a CORS fetch / image proxy.
   * ------------------------------------------------------------------ */
  const gmXHR = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest
    : (typeof GM === 'object' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest.bind(GM)
      : null;

  function gmRequest(url, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      if (!gmXHR) { reject(new Error('needs GM_xmlhttpRequest')); return; }
      let settled = false;
      const once = (fn) => (x) => { if (!settled) { settled = true; fn(x); } };
      const ok = once(resolve);
      const fail = once(reject);
      try {
        gmXHR({
          method: opts.method || 'GET',
          url,
          headers: Object.assign(
            { Accept: opts.accept || 'application/json, text/html;q=0.9, */*;q=0.8' },
            opts.headers || {}),
          data: opts.body,
          responseType: opts.responseType || 'text',
          anonymous: true,
          timeout: opts.timeout || 20000,
          onload: (r) => {
            if (r.status >= 200 && r.status < 300) ok(r);
            else fail(new Error(httpErrText(r.status)));
          },
          onerror: () => fail(new Error('network error')),
          ontimeout: () => fail(new Error('timed out')),
          onabort: () => fail(new Error('aborted')),
        });
      } catch (e) { fail(e); }
    });
  }

  async function gmJson(url, opts) {
    const r = await gmRequest(url, opts);
    try { return JSON.parse(r.responseText); } catch (e) { throw new Error('bad JSON'); }
  }

  // Provider descriptions arrive as HTML (Dynasty) or plain text; flatten to
  // text first so descToHtml() gets a clean input.
  function htmlToText(html) {
    if (!html) return '';
    const s = String(html)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|blockquote)>/gi, '\n');
    const doc = new DOMParser().parseFromString(s, 'text/html');
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Sources mix real genres with descriptors in one list; keep AniList's own
  // genre vocabulary as genres and turn everything else into tags.
  const AL_GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Hentai',
    'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance',
    'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
  const GENRE_CANON = new Map(AL_GENRES.map((g) => [g.toLowerCase().replace(/[^a-z]/g, ''), g]));
  GENRE_CANON.set('sciencefiction', 'Sci-Fi');
  GENRE_CANON.set('magicalgirls', 'Mahou Shoujo');
  GENRE_CANON.set('magicalgirl', 'Mahou Shoujo');
  function splitGenresTags(names) {
    const genres = [];
    const tags = [];
    for (const raw of names || []) {
      const n = String(raw || '').trim();
      if (!n) continue;
      const g = GENRE_CANON.get(n.toLowerCase().replace(/[^a-z]/g, ''));
      if (g) { if (!genres.includes(g)) genres.push(g); }
      else { const t = tagCase(n); if (!tags.includes(t)) tags.push(t); }
    }
    return { genres, tags };
  }
  // titleCase for tag names, but "Student x Teacher" keeps its lowercase x.
  const tagCase = (n) => titleCase(n).replace(/\bX\b/g, 'x');

  /* ------------------------------------------------------------------ *
   * Hotlink detection + image embedding
   *
   * Some hosts (Dynasty Reader, many image boards) answer 403 when the
   * Referer is anilist.co, so a cover/banner URL from them renders as a
   * broken image everywhere on AniList. Before a cover/banner URL is stored
   * it is test-loaded exactly the way AniList's own <img>/CSS would load it;
   * if that fails, the bytes are fetched out-of-band (GM_xmlhttpRequest →
   * CORS fetch without Referer → image proxy), downscaled on a canvas and
   * stored as a data: URI so the record is self-contained. Results are
   * cached per host for the session so healthy hosts cost one probe.
   * ------------------------------------------------------------------ */
  // Public image proxy (fetches without a Referer, answers with CORS, can
  // resize server-side). Used as the last-resort fetch path when there is no
  // GM_xmlhttpRequest and no CORS, and as the resizer when the browser's
  // canvas can't be trusted (see canvasReadbackTrusted). Only the image URL
  // is sent to it. Set to null to disable.
  const IMAGE_PROXY = (url, lim) => 'https://images.weserv.nl/?url=' + encodeURIComponent(url)
    + (lim ? `&w=${lim.w}&h=${lim.h}&fit=inside&we&output=jpg&q=${Math.round(lim.q * 100)}` : '');
  const EMBED_LIMITS = {
    cover: { w: 400, h: 600, q: 0.8 },
    banner: { w: 1900, h: 600, q: 0.75 },
  };
  const RAW_KEEP_BYTES = 150 * 1024; // files this small are stored verbatim (no re-encode)
  const RAW_MAX_BYTES = 400 * 1024;  // absolute cap for storing an un-resized file
  const hotlinkCache = new Map(); // host -> true (loads fine) | false (blocked) | 'decoy' (swaps the picture)

  // Firefox's fingerprinting protection (RFP, LibreWolf, Tor Browser; also
  // FPP's canvas randomization) answers canvas readbacks with noise or a
  // blank image unless the site was granted canvas access, so encoding a
  // cover through <canvas> would store garbage. Probe once per page: two
  // solid 32x32 fills must encode to tiny PNGs (noise doesn't compress) and
  // must differ from each other (a blank spoof makes them identical).
  let canvasTrust = false; // only a positive verdict is cached: the user may grant canvas mid-page
  function canvasReadbackTrusted() {
    if (canvasTrust) return true;
    try {
      const enc = (color) => {
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const x = c.getContext('2d');
        x.fillStyle = color; x.fillRect(0, 0, 32, 32);
        return c.toDataURL('image/png');
      };
      const a = enc('#ff0000');
      const b = enc('#0000ff');
      canvasTrust = a !== b && a.length < 400 && b.length < 400;
    } catch (e) { canvasTrust = false; }
    if (!canvasTrust) console.warn(TAG, 'canvas readback looks spoofed (fingerprinting protection); embedding will avoid <canvas>');
    return canvasTrust;
  }
  // Firefox only shows its canvas permission prompt for reads made during a
  // user gesture, so click handlers call this before their first await.
  const nudgeCanvasPermission = () => { try { canvasReadbackTrusted(); } catch (e) { /* probe only */ } };

  // Hosts that answer cross-site image loads with a decoy picture (HTTP 200,
  // "you can read this at …"), which a plain load test can't tell apart from
  // the real cover: always embed. Others are caught by the dimension check
  // in embedImage.
  const DECOY_HOSTS = ['uploads.mangadex.org'];
  const hostMatches = (host, list) => list.some((h) => host === h || host.endsWith('.' + h));

  // Load an image the way a page would and report {ok, w, h}; ok=false when
  // it errored (blocked / dead), null when undecided (slow). noReferrer loads
  // it Referer-less (cache-busted, so the browser doesn't reuse the other
  // variant), comparing the two exposes hosts that swap the picture for
  // hotlinks.
  function probeImage(url, noReferrer, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const img = new Image();
      const t = setTimeout(() => finish(null), timeoutMs || 8000);
      img.onload = () => { clearTimeout(t); finish({ ok: true, w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(t); finish({ ok: false }); };
      // Default: the same policy AniList's own image loads use, so the probe
      // sees exactly what the media page will see.
      img.referrerPolicy = noReferrer ? 'no-referrer' : 'strict-origin-when-cross-origin';
      img.src = noReferrer ? url + (url.includes('?') ? '&' : '?') + 'alce_nr=1' : url;
    });
  }

  // GM_xmlhttpRequest first (no CORS/Referer), then a plain CORS fetch.
  async function fetchBlobDirect(url, errs) {
    if (gmXHR) {
      try {
        const r = await gmRequest(url, { responseType: 'blob', accept: 'image/*,*/*;q=0.8' });
        if (r.response && r.response.size) return r.response;
        errs.push('empty response');
      } catch (e) { errs.push('GM: ' + e.message); }
    }
    try {
      const res = await nativeFetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (res.ok) return await res.blob();
      errs.push('fetch: ' + httpErrText(res.status));
    } catch (e) { errs.push('fetch: no CORS'); }
    return null;
  }

  async function fetchImageBlob(url) {
    const errs = [];
    const direct = await fetchBlobDirect(url, errs);
    if (direct) return direct;
    if (IMAGE_PROXY) {
      const viaProxy = await fetchBlobDirect(IMAGE_PROXY(url), errs);
      if (viaProxy) return viaProxy;
    }
    throw new Error(errs.join('; ') || 'no fetch path');
  }

  // Bytes as-is (FileReader, no canvas): the safe path when the browser
  // spoofs canvas readback, and the lossless path for small files anyway.
  function blobToRawDataUri(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('could not read image'));
      fr.readAsDataURL(blob);
    });
  }

  function dataUriToBlob(uri) {
    const m = String(uri || '').match(/^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/);
    if (!m) throw new Error('bad data URI');
    const mime = m[1] || 'application/octet-stream';
    if (m[3]) {
      const bin = atob(m[4].replace(/\s/g, ''));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    }
    return new Blob([decodeURIComponent(m[4])], { type: mime });
  }

  // Pick the encoding path and hand back bytes: small file → verbatim;
  // trusted canvas → resize here; spoofed canvas → let the image proxy resize
  // server-side; else as-is if not too big (any size when it is going to the
  // image host rather than into localStorage). Resolves { blob, note }.
  async function encodeImageBlob(blob, lim, url, hosted) {
    if (blob.size <= RAW_KEEP_BYTES) return { blob, note: '' };
    if (canvasReadbackTrusted()) return { blob: await blobToJpegBlob(blob, lim), note: '' };
    if (IMAGE_PROXY && !isDataUrl(url)) {
      const errs = [];
      const resized = await fetchBlobDirect(IMAGE_PROXY(url, lim), errs);
      if (resized && resized.size) {
        return { blob: resized, note: ' (canvas is spoofed by fingerprinting protection, resized via image proxy)' };
      }
    }
    if (hosted || blob.size <= RAW_MAX_BYTES) {
      return { blob, note: ' (canvas is spoofed by fingerprinting protection, stored un-resized)' };
    }
    throw new Error('canvas readback is spoofed by fingerprinting protection and the file is too large to store as-is. Allow canvas for anilist.co (or configure an image host) and try again');
  }

  function blobToJpegBlob(blob, lim) {
    return new Promise((resolve, reject) => {
      const src = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, lim.w / img.naturalWidth, lim.h / img.naturalHeight);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const enc = (q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('canvas encode failed'))), 'image/jpeg', q));
          enc(lim.q).then((b) => (b.size > 150 * 1024 ? enc(0.65) : b)).then(resolve, reject)
            .finally(() => URL.revokeObjectURL(src));
        } catch (e) { URL.revokeObjectURL(src); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('not a decodable image')); };
      img.src = src;
    });
  }

  const isDataUrl = (u) => /^data:/i.test(String(u || ''));

  /* --- optional self-hosted image host (al-custom-entry-images) --- */
  const imgHostBase = () => String(syncCfg.imgHost || '').trim().replace(/\/+$/, '');
  const imgHostConfigured = () => !!(imgHostBase() && syncCfg.imgToken);

  // POST the bytes; the server names the file by content hash and answers
  // with the public URL. GM_xmlhttpRequest first (no CORS involved), plain
  // fetch second (the server allows anilist.co).
  async function uploadToImageHost(blob) {
    const url = imgHostBase() + '/covers';
    const headers = { Authorization: 'Bearer ' + syncCfg.imgToken, 'Content-Type': blob.type || 'application/octet-stream' };
    let text;
    if (gmXHR) {
      const r = await gmRequest(url, { method: 'POST', headers, body: blob, accept: 'application/json' });
      text = r.responseText;
    } else {
      const res = await nativeFetch(url, { method: 'POST', headers, body: blob, mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(httpErrText(res.status));
      text = await res.text();
    }
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('bad response'); }
    if (!j || !isHttpUrl(j.url)) throw new Error(j && j.error ? j.error : 'no URL in response');
    return j.url;
  }

  // Store encoded bytes: on the image host when configured (a plain URL,
  // nothing in localStorage), else inline as a data: URI. Resolves
  // { stored, how } where `how` is the toast fragment.
  async function storeImageBytes(blob) {
    const kb = Math.round(blob.size / 1024);
    if (imgHostConfigured()) {
      try {
        return { stored: await uploadToImageHost(blob), how: `uploaded to your image host (${kb} KB)` };
      } catch (e) {
        toast(`Image host upload failed (${e.message}), embedding instead`, true);
      }
    }
    return { stored: await blobToRawDataUri(blob), how: `embedded as a ${kb} KB copy` };
  }

  // Store a cover/banner and remember the last real URL behind it
  // (md.coverSource / md.bannerSource), so an embedded copy can be redone or
  // re-added later even after the field was cleared or replaced.
  const isHttpUrl = (u) => /^https?:\/\//i.test(String(u || ''));
  // The remembered source is where the picture originally came from: a URL
  // on the image host is a *copy* (like a data: URI), so it never replaces
  // an existing source, and a real origin URL always wins over it.
  const onImageHost = (u) => { const b = imgHostBase(); return !!(b && isHttpUrl(u) && String(u).startsWith(b + '/')); };
  function rememberSource(current, stored, source) {
    const cand = [source, stored].filter((u) => isHttpUrl(u) && u !== DEFAULT_COVER);
    const origin = cand.find((u) => !onImageHost(u));
    if (origin) return origin;
    if (current && !onImageHost(current)) return current;
    return cand[0] || current || null;
  }
  function setCover(md, stored, source) {
    const c = stored || DEFAULT_COVER;
    md.coverImage = { extraLarge: c, large: c, medium: c, color: null };
    const src = rememberSource(md.coverSource, c, source);
    if (src) md.coverSource = src;
  }
  function setBanner(md, stored, source) {
    md.bannerImage = stored || null;
    const src = rememberSource(md.bannerSource, stored, source);
    if (src) md.bannerSource = src;
  }

  // Returns the URL to store: the input itself when it hotlinks fine (or
  // can't be judged), a data: URI when the host blocks hotlinking. With
  // opts.force the probe is skipped and the image is always embedded.
  async function embedImage(url, kind, opts) {
    const force = !!(opts && opts.force);
    if (!url || isDataUrl(url) || url === DEFAULT_COVER) return url;
    let host;
    try { host = new URL(url, location.href).host; } catch (e) { return url; }
    let why = ''; // toast wording: what was wrong with hotlinking (empty when forced)
    if (!force) {
      if (!host || host === location.host || host.endsWith('.anilist.co')) return url;
      const known = hotlinkCache.get(host);
      if (known === true) return url;
      if (known === 'decoy' || hostMatches(host, DECOY_HOSTS)) {
        why = 'host serves a placeholder to hotlinks, ';
      } else if (known === false) {
        why = 'host blocks hotlinking, ';
      } else {
        const ref = await probeImage(url, false);
        if (ref === null) return url; // slow host: don't guess, keep the URL
        if (!ref.ok) {
          hotlinkCache.set(host, false);
          why = 'host blocks hotlinking, ';
        } else {
          // Loads fine, but is it the real picture? A Referer-less load of
          // the same URL with different dimensions means the host swaps in
          // a decoy for hotlinks (MangaDex-style).
          const nr = await probeImage(url, true);
          if (nr && nr.ok && (nr.w !== ref.w || nr.h !== ref.h)) {
            hotlinkCache.set(host, 'decoy');
            why = 'host serves a placeholder to hotlinks, ';
          } else {
            hotlinkCache.set(host, true);
            return url;
          }
        }
      }
    }
    const label = kind === 'banner' ? 'Banner' : 'Cover';
    try {
      const src = await fetchImageBlob(url);
      const { blob, note } = await encodeImageBlob(src, EMBED_LIMITS[kind] || EMBED_LIMITS.cover, url, imgHostConfigured());
      const { stored, how } = await storeImageBytes(blob);
      toast(`${label}: ${why}${how}${note}`);
      return stored;
    } catch (e) {
      toast(`${label} could not be stored (${e.message})`, true);
      return url;
    }
  }
  const embedIfHotlinkBlocked = (url, kind) => embedImage(url, kind);

  // Post-write fixup for paths that store URLs synchronously (native edit
  // form, imports): swap blocked cover/banner for embedded copies, then
  // re-save and re-render. Resolves to whether anything changed.
  async function embedRecImages(rec) {
    if (!rec || !rec.media) return false;
    const md = rec.media;
    let changed = false;
    const c = md.coverImage && md.coverImage.large;
    const nc = await embedIfHotlinkBlocked(c, 'cover');
    if (nc && nc !== c) { setCover(md, nc, c); changed = true; }
    const b = md.bannerImage;
    const nb = await embedIfHotlinkBlocked(b, 'banner');
    if (nb && nb !== b) { setBanner(md, nb, b); changed = true; }
    if (changed) {
      touchRec(rec);
      saveDB();
      pushRecEntities(rec);
      syncSections(rec);
      commitSubmissionMedia({
        coverImage: { extraLarge: md.coverImage.large, large: md.coverImage.large, color: null },
        bannerImage: md.bannerImage,
      });
    }
    return changed;
  }

  function mbNormalize(d) {
    const syn = [];
    if (d.native_title && d.native_title !== d.title) syn.push(d.native_title);
    if (d.romanized_title && d.romanized_title !== d.title) syn.push(d.romanized_title);
    for (const arr of Object.values(d.secondary_titles || {})) {
      for (const t of arr || []) { if (t && t.title && t.title !== d.title) syn.push(t.title); }
    }
    const src = d.source || {};
    const fmt = d.type === 'novel' || d.type === 'light_novel' ? 'NOVEL'
      : (d.type === 'one_shot' ? 'ONE_SHOT' : 'MANGA');
    return {
      provider: 'MangaBaka',
      isAdult: mbIsAdult(d),
      malId: (src.my_anime_list && src.my_anime_list.id) || null,
      type: 'MANGA',
      title: d.title,
      synonyms: [...new Set(syn)],
      cover: (d.cover && d.cover.raw && d.cover.raw.url) || null,
      thumb: (d.cover && ((d.cover.x150 && d.cover.x150.x1) || (d.cover.raw && d.cover.raw.url))) || null,
      banner: null,
      description: descToHtml(d.description),
      format: fmt,
      mediaStatus: META_STATUS_MB[d.status] || 'RELEASING',
      episodes: null,
      chapters: parseInt(d.total_chapters, 10) || null,
      volumes: parseInt(d.final_volume, 10) || null,
      genres: (d.genres || []).map(titleCase),
      tags: (d.tags || []).map(titleCase),
      studio: null,
      year: d.year || null,
      authors: d.authors || [],
      subtitle: (d.type ? titleCase(d.type) : '') + (src.anilist && src.anilist.id ? ' · already on AniList' : ''),
      external: {
        mangabaka: d.id,
        mal: (src.my_anime_list && src.my_anime_list.id) || null,
        mangaupdates: (src.manga_updates && src.manga_updates.id) || null,
        anilist: (src.anilist && src.anilist.id) || null,
      },
    };
  }

  async function searchMangaBaka(q) {
    const j = await metaFetchJson('https://api.mangabaka.org/v1/series/search?q=' + encodeURIComponent(q));
    return (j.data || []).filter((d) => d.state !== 'merged').map(mbNormalize);
  }

  // AniList's isAdult means 18+ only; MangaBaka's "suggestive" stays safe.
  const MB_ADULT = new Set(['erotica', 'pornographic']);
  const mbIsAdult = (d) => MB_ADULT.has(d && d.content_rating);
  const jikanIsAdult = (d) => [...(d.genres || []), ...(d.explicit_genres || [])]
    .some((g) => g && (g.name === 'Hentai' || g.name === 'Erotica'));

  // Whether this AniList account has 18+ content enabled in its settings.
  function viewerShowsAdult() {
    try {
      const a = JSON.parse(localStorage.getItem('auth'));
      return !!(a && a.options && a.options.displayAdultContent);
    } catch (e) { return false; }
  }

  function jikanNormalize(d, anime) {
    const syn = [...(d.title_synonyms || [])];
    if (d.title_english && d.title_english !== d.title) syn.push(d.title_english);
    if (d.title_japanese) syn.push(d.title_japanese);
    return {
      provider: 'MAL',
      isAdult: jikanIsAdult(d),
      malId: d.mal_id,
      type: anime ? 'ANIME' : 'MANGA',
      title: d.title,
      synonyms: [...new Set(syn)],
      cover: (d.images && d.images.jpg && (d.images.jpg.large_image_url || d.images.jpg.image_url)) || null,
      thumb: (d.images && d.images.jpg && (d.images.jpg.small_image_url || d.images.jpg.image_url)) || null,
      banner: null,
      description: descToHtml(d.synopsis),
      format: META_FORMAT_JIKAN[d.type] || (anime ? 'TV' : 'MANGA'),
      mediaStatus: META_STATUS_JIKAN[d.status] || 'RELEASING',
      episodes: anime ? d.episodes || null : null,
      chapters: !anime ? d.chapters || null : null,
      volumes: !anime ? d.volumes || null : null,
      genres: [...(d.genres || []), ...(d.demographics || [])].map((g) => g.name),
      tags: (d.themes || []).map((g) => g.name),
      studio: (anime && d.studios && d.studios[0] && d.studios[0].name) || null,
      year: d.year
        || (d.published && d.published.prop && d.published.prop.from && d.published.prop.from.year)
        || (d.aired && d.aired.prop && d.aired.prop.from && d.aired.prop.from.year)
        || null,
      authors: (d.authors || []).map((a) => a.name),
      subtitle: d.type || '',
      external: { mal: d.mal_id },
    };
  }

  // MAL metadata comes from Tenrai, whose v1 schema is a continuation of
  // Jikan v4 (same `data[]` shapes, so the normalizers below are unchanged).
  // Jikan's public API 504s constantly via its MyAnimeList upstream and shuts
  // down 2026-10-01 (jikan-me/jikan-rest#610); Tenrai is its stated successor.
  const MAL_API = 'https://api.tenrai.org/v1/';

  async function searchJikan(q, type) {
    const anime = type === 'ANIME';
    const j = await metaFetchJson(
      MAL_API + (anime ? 'anime' : 'manga') + '?q=' + encodeURIComponent(q) + '&limit=8');
    return (j.data || []).map((d) => jikanNormalize(d, anime));
  }

  /* ------------------------------------------------------------------ *
   * Bulk import (Settings → Bulk import)
   *
   * A MAL list export (XML, also .xml.gz), a MangaBaka library (personal
   * access token) or a CSV become custom entries in one go, reusing the
   * provider normalizers above for metadata. Rows share one shape:
   *   { title, type, format, mediaStatus, episodes, chapters, volumes,
   *     cover, description, genres, tags, synonyms, year, isAdult,
   *     external: {mal, mangabaka, anilist},
   *     list: {status, progress, progressVolumes, score100, score, repeat,
   *            notes, startedAt, completedAt, private} }
   * Entries that exist on AniList are skipped by default (they belong on
   * the real list), as are rows already imported (same MAL / MangaBaka id).
   * ------------------------------------------------------------------ */
  const MAL_LIST_STATUS = {
    watching: 'CURRENT', reading: 'CURRENT', completed: 'COMPLETED', 'on-hold': 'PAUSED',
    dropped: 'DROPPED', 'plan to watch': 'PLANNING', 'plan to read': 'PLANNING',
  };
  const MB_LIST_STATE = {
    reading: 'CURRENT', rereading: 'REPEATING', completed: 'COMPLETED', dropped: 'DROPPED',
    paused: 'PAUSED', plan_to_read: 'PLANNING', considering: 'PLANNING',
  };
  const LIST_STATUS_ALIASES = Object.assign({
    current: 'CURRENT', watching: 'CURRENT', reading: 'CURRENT', repeating: 'REPEATING', rewatching: 'REPEATING',
    rereading: 'REPEATING', completed: 'COMPLETED', complete: 'COMPLETED', paused: 'PAUSED', 'on hold': 'PAUSED',
    'on-hold': 'PAUSED', dropped: 'DROPPED', planning: 'PLANNING', 'plan to read': 'PLANNING', 'plan to watch': 'PLANNING',
    ptw: 'PLANNING', ptr: 'PLANNING', plan_to_read: 'PLANNING', plan_to_watch: 'PLANNING',
  });
  const listStatusOf = (v) => (v ? LIST_STATUS_ALIASES[String(v).trim().toLowerCase()] || null : null);
  const isoToFuzzy = (v) => {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v || '').trim());
    if (!m || m[1] === '0000') return { year: null, month: null, day: null };
    return { year: +m[1], month: +m[2] || null, day: +m[3] || null };
  };
  // A 0–100 score in the viewer's list score format (inverse of score100).
  function scoreFrom100(rec, v) {
    if (!Number.isFinite(v) || v <= 0) return 0;
    const fmt = (ownerOpts(rec) || {}).scoreFormat || 'POINT_100';
    if (fmt === 'POINT_10_DECIMAL') return Math.round(v) / 10;
    if (fmt === 'POINT_10') return Math.round(v / 10);
    if (fmt === 'POINT_5') return Math.max(1, Math.round(v / 20));
    if (fmt === 'POINT_3') return v >= 75 ? 3 : (v >= 50 ? 2 : 1);
    return Math.round(v);
  }

  // --- MAL list export (https://myanimelist.net/panel.php?go=export) ---
  function parseMalXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('not a valid XML file');
    const nodes = Array.from(doc.querySelectorAll('anime, manga'));
    if (!nodes.length) throw new Error('no <anime> or <manga> items found');
    const txt = (n, tag) => { const e = n.querySelector(tag); return e ? (e.textContent || '').trim() : ''; };
    const num = (n, tag) => { const v = parseInt(txt(n, tag), 10); return Number.isFinite(v) ? v : 0; };
    const rows = [];
    for (const n of nodes) {
      const anime = n.tagName.toLowerCase() === 'anime';
      const type = anime ? 'ANIME' : 'MANGA';
      const malId = num(n, anime ? 'series_animedb_id' : 'series_mangadb_id');
      const title = txt(n, 'series_title');
      if (!title) continue;
      const status = MAL_LIST_STATUS[txt(n, 'my_status').toLowerCase()] || 'PLANNING';
      const rereading = num(n, anime ? 'my_rewatching' : 'my_rereading') === 1;
      rows.push({
        title, type,
        format: META_FORMAT_JIKAN[txt(n, 'series_type')] || (anime ? 'TV' : 'MANGA'),
        mediaStatus: null,
        episodes: anime ? num(n, 'series_episodes') || null : null,
        chapters: anime ? null : num(n, 'series_chapters') || null,
        volumes: anime ? null : num(n, 'series_volumes') || null,
        external: { mal: malId || null },
        list: {
          status: rereading && status === 'COMPLETED' ? 'REPEATING' : status,
          progress: num(n, anime ? 'my_watched_episodes' : 'my_read_chapters'),
          progressVolumes: anime ? null : num(n, 'my_read_volumes'),
          score100: num(n, 'my_score') * 10 || null,
          repeat: num(n, anime ? 'my_times_watched' : 'my_times_read'),
          notes: txt(n, 'my_comments') || null,
          startedAt: isoToFuzzy(txt(n, 'my_start_date')),
          completedAt: isoToFuzzy(txt(n, 'my_finish_date')),
          private: false,
        },
      });
    }
    return rows;
  }

  // --- CSV: header row, any column order, case-insensitive names. ---
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    const src = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    return rows;
  }
  const CSV_COLUMNS = {
    title: ['title', 'name', 'series', 'series_title'], type: ['type', 'media_type', 'kind'], format: ['format'],
    status: ['status', 'list_status', 'my_status', 'state'], progress: ['progress', 'episodes_watched', 'chapters_read', 'watched', 'read', 'my_watched_episodes', 'my_read_chapters'],
    progressVolumes: ['progress_volumes', 'volumes_read', 'my_read_volumes'], score: ['score', 'rating', 'my_score'],
    notes: ['notes', 'note', 'comments', 'my_comments'], startedAt: ['started', 'started_at', 'start_date', 'my_start_date'],
    completedAt: ['completed', 'completed_at', 'finish_date', 'end_date', 'my_finish_date'], repeat: ['repeat', 'rewatches', 'rereads', 'times_watched', 'times_read'],
    private: ['private'], cover: ['cover', 'cover_url', 'image', 'cover_image'], banner: ['banner', 'banner_url'],
    description: ['description', 'synopsis', 'summary'], genres: ['genres', 'genre'], tags: ['tags', 'tag'], synonyms: ['synonyms', 'alt_titles', 'alternative_titles'],
    episodes: ['episodes', 'total_episodes', 'series_episodes'], chapters: ['chapters', 'total_chapters', 'series_chapters'], volumes: ['volumes', 'total_volumes', 'series_volumes'],
    mediaStatus: ['media_status', 'release_status', 'publishing_status', 'airing_status'], year: ['year', 'start_year', 'release_year'],
    mal: ['mal', 'mal_id', 'myanimelist', 'series_animedb_id', 'series_mangadb_id'], mangabaka: ['mangabaka', 'mangabaka_id', 'mb_id'], anilist: ['anilist', 'anilist_id'],
    adult: ['adult', 'is_adult', 'isadult', 'nsfw'],
  };
  const MEDIA_STATUS_ALIASES = {
    finished: 'FINISHED', complete: 'FINISHED', completed: 'FINISHED', releasing: 'RELEASING', ongoing: 'RELEASING', publishing: 'RELEASING',
    airing: 'RELEASING', 'not yet released': 'NOT_YET_RELEASED', not_yet_released: 'NOT_YET_RELEASED', upcoming: 'NOT_YET_RELEASED',
    cancelled: 'CANCELLED', canceled: 'CANCELLED', hiatus: 'HIATUS',
  };
  function csvRows(text, defaultType) {
    const table = parseCsv(text);
    if (table.length < 2) throw new Error('needs a header row and at least one entry');
    const norm = (h) => String(h || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const header = table[0].map(norm);
    const col = {};
    for (const [key, names] of Object.entries(CSV_COLUMNS)) {
      const i = header.findIndex((h) => names.includes(h));
      if (i !== -1) col[key] = i;
    }
    if (col.title === undefined) throw new Error('no title column (accepted: ' + CSV_COLUMNS.title.join(', ') + ')');
    const get = (r, key) => (col[key] === undefined ? '' : String(r[col[key]] || '').trim());
    const num = (r, key) => { const v = parseFloat(get(r, key)); return Number.isFinite(v) ? v : null; };
    const listOf = (r, key) => get(r, key).split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    const rows = [];
    for (const r of table.slice(1)) {
      const title = get(r, 'title');
      if (!title) continue;
      const t = get(r, 'type').toUpperCase();
      const type = t.startsWith('ANIME') ? 'ANIME' : (t.startsWith('MANGA') || t === 'NOVEL' || t === 'LN' ? 'MANGA' : defaultType);
      const anime = type === 'ANIME';
      const fmt = get(r, 'format').toUpperCase().replace(/[\s-]+/g, '_');
      const genres = listOf(r, 'genres');
      const tags = listOf(r, 'tags');
      const bool = (v) => /^(1|true|yes|y)$/i.test(v);
      rows.push({
        title, type,
        format: FORMAT_OPTS[type].includes(fmt) ? fmt : (fmt === 'LIGHT_NOVEL' || fmt === 'LN' ? 'NOVEL' : (fmt === 'ONESHOT' ? 'ONE_SHOT' : null)),
        mediaStatus: MEDIA_STATUS_ALIASES[get(r, 'mediaStatus').toLowerCase()] || null,
        episodes: anime ? num(r, 'episodes') : null,
        chapters: anime ? null : num(r, 'chapters'),
        volumes: anime ? null : num(r, 'volumes'),
        cover: get(r, 'cover') || null, banner: get(r, 'banner') || null,
        description: get(r, 'description') ? descToHtml(get(r, 'description')) : null,
        genres, tags, synonyms: listOf(r, 'synonyms'),
        year: num(r, 'year'),
        isAdult: get(r, 'adult') ? bool(get(r, 'adult')) : undefined,
        external: { mal: num(r, 'mal'), mangabaka: num(r, 'mangabaka'), anilist: num(r, 'anilist') },
        list: {
          status: listStatusOf(get(r, 'status')) || 'PLANNING',
          progress: Math.max(0, Math.round(num(r, 'progress') || 0)),
          progressVolumes: anime ? null : Math.max(0, Math.round(num(r, 'progressVolumes') || 0)),
          score: num(r, 'score'), // in the viewer's own score format
          repeat: Math.max(0, Math.round(num(r, 'repeat') || 0)),
          notes: get(r, 'notes') || null,
          startedAt: isoToFuzzy(get(r, 'startedAt')),
          completedAt: isoToFuzzy(get(r, 'completedAt')),
          private: bool(get(r, 'private')),
        },
      });
    }
    return rows;
  }

  // --- MangaBaka library: personal access token (Settings → API on
  // mangabaka.org), scope library.read. The token is used for this import
  // only and never stored. Series details come from the public batch
  // endpoint so mbNormalize (and its "already on AniList" link) applies. ---
  async function mbApi(path, token) {
    const url = 'https://api.mangabaka.org' + path;
    const headers = token ? { 'x-api-key': token } : {};
    if (gmXHR) return gmJson(url, { headers });
    const res = await nativeFetch(url, { headers });
    if (!res.ok) throw new Error(httpErrText(res.status));
    return res.json();
  }
  async function fetchMangaBakaLibrary(token, onProgress) {
    const entries = [];
    for (let page = 1; page <= 200; page++) {
      if (onProgress) onProgress(`Loading MangaBaka library, page ${page}…`);
      const j = await mbApi(`/v2/my/library?limit=100&page=${page}`, token);
      const data = Array.isArray(j.data) ? j.data : [];
      for (const d of data) { const e = (d && d.entry) || d || {}; const sid = e.series_id || (d && d.series && d.series.id); if (sid) entries.push(Object.assign({}, e, { series_id: sid })); }
      if (!data.length || !(j.pagination && j.pagination.next)) break;
    }
    const rows = [];
    const ids = [...new Set(entries.map((e) => e.series_id))];
    const byId = {};
    for (let i = 0; i < ids.length; i += 50) {
      if (onProgress) onProgress(`Loading series details ${Math.min(i + 50, ids.length)}/${ids.length}…`);
      const j = await mbApi('/v1/series/batch?' + ids.slice(i, i + 50).map((id) => 'id=' + id).join('&'), null);
      for (const d of (Array.isArray(j.data) ? j.data : [])) if (d && d.id) byId[d.id] = d;
    }
    for (const e of entries) {
      const d = byId[e.series_id];
      if (!d) continue;
      const r = mbNormalize(d);
      rows.push(Object.assign(r, {
        list: {
          status: MB_LIST_STATE[e.state] || 'PLANNING',
          progress: Math.max(0, Math.round(e.progress_chapter || 0)),
          progressVolumes: Math.max(0, Math.round(e.progress_volume || 0)),
          score100: Number.isFinite(e.rating) && e.rating > 0 ? e.rating : null,
          repeat: Math.max(0, Math.round(e.number_of_rereads || 0)),
          notes: e.note || null,
          startedAt: isoToFuzzy(e.start_date),
          completedAt: isoToFuzzy(e.finish_date),
          private: !!e.is_private,
        },
      }));
    }
    return rows;
  }

  // Which of these MAL ids exist on AniList (Page.media(idMal_in), 50 a call).
  async function anilistMalIds(type, malIds) {
    const found = new Set();
    const ids = [...new Set(malIds.filter((v) => Number.isFinite(v) && v > 0))];
    for (let i = 0; i < ids.length; i += 50) {
      const res = await nativeFetch.call(window, '/graphql', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'query($ids:[Int],$type:MediaType){Page(perPage:50){media(idMal_in:$ids,type:$type){idMal}}}', variables: { ids: ids.slice(i, i + 50), type } }),
      });
      const j = await res.json();
      for (const m of ((j.data && j.data.Page && j.data.Page.media) || [])) if (m && m.idMal) found.add(m.idMal);
      if (i + 50 < ids.length) await new Promise((r) => setTimeout(r, 700));
    }
    return found;
  }

  // One row → one custom entry (no activity). Returns the record.
  function importRow(row, ownerId) {
    const list = row.list || {};
    const rec = createRec({
      ownerId, type: row.type, title: row.title, quiet: true,
      format: row.format || (row.type === 'ANIME' ? 'TV' : 'MANGA'),
      mediaStatus: row.mediaStatus || 'FINISHED',
      status: list.status || 'PLANNING',
      episodes: row.episodes || null, chapters: row.chapters || null, volumes: row.volumes || null,
      cover: row.cover || DEFAULT_COVER, banner: row.banner || null,
    });
    applyImportToRec(rec, Object.assign({ mediaStatus: rec.media.status }, row, { format: row.format || rec.media.format, mediaStatus: row.mediaStatus || rec.media.status }));
    const e = rec.entry;
    if (list.progress) e.progress = list.progress;
    if (rec.type === 'MANGA' && list.progressVolumes) e.progressVolumes = list.progressVolumes;
    if (Number.isFinite(list.score) && list.score > 0) e.score = list.score;
    else if (Number.isFinite(list.score100) && list.score100 > 0) e.score = scoreFrom100(rec, list.score100);
    if (list.repeat) e.repeat = list.repeat;
    if (list.notes) e.notes = list.notes;
    // Dates come from the source only (no "today" stamps on a migration).
    const empty = { year: null, month: null, day: null };
    e.startedAt = list.startedAt && list.startedAt.year ? list.startedAt : empty;
    e.completedAt = list.completedAt && list.completedAt.year ? list.completedAt : empty;
    if (list.private) e.private = true;
    rec.imported = { at: nowSec(), from: row.provider || (row.external && row.external.mal ? 'MAL' : 'CSV') };
    touchRec(rec);
    return rec;
  }
  const importedBefore = (row) => allRecs().some((r) => r.external && (
    (row.external && row.external.mangabaka && r.external.mangabaka === row.external.mangabaka)
    || (row.external && row.external.mal && r.type === row.type && r.external.mal === row.external.mal)));

  // Runs the import: skips, creates, then (MAL rows) fills in metadata from
  // the MAL API one entry at a time and embeds covers. onProgress(text).
  async function runBulkImport(rows, opts, onProgress) {
    const ownerId = opts.ownerId;
    const out = { added: 0, onAniList: 0, dupes: 0, failed: 0, recs: [] };
    let onAL = new Set();
    if (opts.skipOnAniList) {
      for (const type of ['ANIME', 'MANGA']) {
        const ids = rows.filter((r) => r.type === type && r.external && r.external.mal && !(r.external.anilist)).map((r) => r.external.mal);
        if (!ids.length) continue;
        if (onProgress) onProgress(`Checking ${ids.length} ${type.toLowerCase()} entr${ids.length === 1 ? 'y' : 'ies'} against AniList…`);
        const f = await anilistMalIds(type, ids);
        for (const id of f) onAL.add(type + ':' + id);
      }
    }
    for (const row of rows) {
      try {
        const ext = row.external || {};
        if (opts.skipOnAniList && (ext.anilist || (ext.mal && onAL.has(row.type + ':' + ext.mal)))) { out.onAniList++; continue; }
        if (importedBefore(row)) { out.dupes++; continue; }
        out.recs.push(importRow(row, ownerId));
        out.added++;
      } catch (e) { out.failed++; console.warn(TAG, 'import row failed', row.title, e); }
    }
    saveDB();
    // Metadata: MAL rows carry only a title; ask the MAL API for the rest.
    const needMeta = out.recs.filter((r) => r.external && r.external.mal && !r.external.mangabaka && !r.media.description);
    for (let i = 0; i < needMeta.length; i++) {
      const rec = needMeta[i];
      if (onProgress) onProgress(`Fetching details ${i + 1}/${needMeta.length}: ${rec.media.title.userPreferred}`);
      try {
        const j = await metaFetchJson(MAL_API + (rec.type === 'ANIME' ? 'anime/' : 'manga/') + rec.external.mal);
        if (j && j.data) {
          const n = jikanNormalize(j.data, rec.type === 'ANIME');
          const keepStatus = rec.media.status;
          applyImportToRec(rec, n);
          if (!n.mediaStatus) rec.media.status = keepStatus;
        }
      } catch (e) { /* keep the bare record */ }
      await new Promise((r) => setTimeout(r, 1100));
    }
    for (const rec of out.recs) embedRecImages(rec).catch(() => {});
    saveDB();
    if (out.added) setTimeout(() => { try { syncNow(); } catch (e) { /* not configured */ } }, 500);
    return out;
  }

  // Read a dropped/picked file as text; .gz is gunzipped (MAL exports).
  async function readImportFile(file) {
    if (/\.gz$/i.test(file.name) && typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('gzip');
      return new Response(file.stream().pipeThrough(ds)).text();
    }
    return file.text();
  }

  // MAL names come as "Last, First"; entries show them as entered, so flip.
  const malName = (name) => (String(name).includes(', ')
    ? String(name).split(', ').reverse().join(' ')
    : String(name));

  async function fetchJikanCharacters(malId, type) {
    const anime = type === 'ANIME';
    const j = await metaFetchJson(
      MAL_API + (anime ? 'anime' : 'manga') + '/' + malId + '/characters');
    return (j.data || [])
      .filter((c) => c.role === 'Main' || c.role === 'Supporting')
      .sort((a, b) => (a.role === 'Main' ? 0 : 1) - (b.role === 'Main' ? 0 : 1))
      .slice(0, 15)
      .map((c) => ({
        name: malName((c.character && c.character.name) || '?'),
        role: c.role === 'Main' ? 'MAIN' : 'SUPPORTING',
        image: (c.character && c.character.images && c.character.images.jpg
          && c.character.images.jpg.image_url) || null,
      }));
  }

  /* --- MangaDex --------------------------------------------------- */
  const MD_API = 'https://api.mangadex.org/';
  const MD_STATUS = { ongoing: 'RELEASING', completed: 'FINISHED', hiatus: 'HIATUS', cancelled: 'CANCELLED' };
  const mdText = (o) => (o && (o.en || o['ja-ro'] || o.ja || Object.values(o)[0])) || '';
  const intId = (v) => (v ? parseInt(v, 10) || null : null);

  function mdNormalize(d) {
    const a = d.attributes || {};
    const rels = d.relationships || [];
    const title = mdText(a.title);
    const syn = [];
    for (const t of a.altTitles || []) { const v = mdText(t); if (v && v !== title) syn.push(v); }
    const groups = { genre: [], theme: [], format: [], content: [] };
    for (const t of a.tags || []) {
      const g = t.attributes && t.attributes.group;
      const n = t.attributes && mdText(t.attributes.name);
      if (n && groups[g]) groups[g].push(n);
    }
    const split = splitGenresTags([...groups.genre, ...groups.theme]);
    const oneShot = groups.format.includes('Oneshot');
    const coverRel = rels.find((r) => r.type === 'cover_art' && r.attributes && r.attributes.fileName);
    const cover = coverRel ? `https://uploads.mangadex.org/covers/${d.id}/${coverRel.attributes.fileName}` : null;
    const authors = rels
      .filter((r) => (r.type === 'author' || r.type === 'artist') && r.attributes && r.attributes.name)
      .map((r) => r.attributes.name);
    const links = a.links || {};
    const finished = a.status === 'completed';
    return {
      provider: 'MangaDex',
      isAdult: a.contentRating === 'erotica' || a.contentRating === 'pornographic',
      malId: intId(links.mal),
      type: 'MANGA',
      title,
      synonyms: [...new Set(syn)],
      cover,
      thumb: cover ? cover + '.256.jpg' : null,
      banner: null,
      description: descToHtml(mdText(a.description)),
      format: oneShot ? 'ONE_SHOT' : 'MANGA',
      mediaStatus: MD_STATUS[a.status] || 'RELEASING',
      episodes: null,
      chapters: finished ? (parseInt(a.lastChapter, 10) || (oneShot ? 1 : null)) : null,
      volumes: finished ? (parseInt(a.lastVolume, 10) || null) : null,
      genres: split.genres,
      tags: [...split.tags, ...groups.format.filter((f) => f !== 'Oneshot')],
      studio: null,
      year: a.year || null,
      authors: [...new Set(authors)],
      subtitle: (groups.format.includes('Doujinshi') ? 'Doujinshi' : (oneShot ? 'One-shot' : 'Manga'))
        + (links.al ? ' · already on AniList' : ''),
      external: { mangadex: d.id, mal: intId(links.mal), anilist: intId(links.al) },
    };
  }

  async function searchMangaDex(q) {
    const p = new URLSearchParams({ title: q, limit: '8', 'order[relevance]': 'desc' });
    for (const inc of ['cover_art', 'author', 'artist']) p.append('includes[]', inc);
    for (const cr of ['safe', 'suggestive', 'erotica', 'pornographic']) p.append('contentRating[]', cr);
    const j = await gmJson(MD_API + 'manga?' + p.toString());
    return (j.data || []).map(mdNormalize).filter((r) => r.title);
  }

  /* --- Dynasty Reader --------------------------------------------- */
  // No search API: the HTML search page is parsed for rows, and the picked
  // row is hydrated from Dynasty's per-item JSON (/series|chapters|
  // anthologies/<slug>.json). Standalone chapters are one-shots/doujins;
  // numbered chapters of a series are dropped (the series itself is listed).
  const DYN = 'https://dynasty-scans.com';
  const DYN_STATUS = {
    Completed: 'FINISHED', Ongoing: 'RELEASING', 'On Hiatus': 'HIATUS', Hiatus: 'HIATUS',
    Dropped: 'CANCELLED', Cancelled: 'CANCELLED', Abandoned: 'CANCELLED', Licensed: 'RELEASING',
  };
  const DYN_KIND_LABEL = { chapters: 'One-shot', series: 'Series', anthologies: 'Anthology' };
  const dynTags = (tags, type) => (tags || []).filter((t) => t && t.type === type).map((t) => t.name);

  function dynNormalize(kind, slug, d) {
    const chapter = kind === 'chapters';
    const general = dynTags(d.tags, 'General');
    const nsfw = general.some((n) => /^(nsfw|explicit)$/i.test(n));
    const split = splitGenresTags(general.filter((n) => !/^(nsfw|explicit)$/i.test(n)));
    const doujin = dynTags(d.tags, 'Doujin');
    const scan = dynTags(d.tags, 'Scanlator');
    const chapters = chapter ? [] : (d.taggings || []).filter((x) => x && x.permalink);
    const volumes = chapter ? 0 : (d.taggings || []).filter((x) => x && x.header && /volume/i.test(x.header)).length;
    const cover = chapter
      ? (d.pages && d.pages[0] && d.pages[0].url ? DYN + d.pages[0].url : null)
      : (d.cover ? DYN + String(d.cover).replace('/medium/', '/original/') : null);
    const released = chapter ? d.released_on
      : (chapters.map((c) => c.released_on).filter(Boolean).sort()[0] || null);
    const status = chapter ? 'FINISHED' : (DYN_STATUS[dynTags(d.tags, 'Status')[0]] || 'RELEASING');
    const finished = status === 'FINISHED';
    const facts = [];
    if (doujin.length) facts.push(doujin.join(', ') + ' doujin');
    if (chapter && d.pages) facts.push(d.pages.length + ' pages');
    if (scan.length) facts.push('scanlation: ' + scan.join(', '));
    const text = [htmlToText(d.description), facts.length ? facts.join(' · ') + ' (Dynasty Reader)' : null]
      .filter(Boolean).join('\n\n');
    return {
      provider: 'Dynasty',
      isAdult: nsfw,
      malId: null,
      type: 'MANGA',
      title: chapter ? d.title : d.name,
      synonyms: (d.aliases || []).slice(),
      cover,
      thumb: cover,
      banner: null,
      description: descToHtml(text),
      format: chapter ? 'ONE_SHOT' : 'MANGA',
      mediaStatus: status,
      episodes: null,
      chapters: chapter ? 1 : (finished && chapters.length ? chapters.length : null),
      volumes: chapter ? null : (finished && volumes ? volumes : null),
      genres: split.genres,
      // Dynasty tags are sparse (often just a genre + a pairing), so the
      // doujin parent and "Doujinshi" are added as low-rank tags too.
      tags: [
        ...split.tags,
        ...dynTags(d.tags, 'Pairing').map((n) => n + ':70'),
        ...doujin.map((n) => n + ':60'),
        ...(doujin.length ? ['Doujinshi:60'] : []),
      ],
      studio: null,
      year: released ? parseInt(String(released).slice(0, 4), 10) || null : null,
      authors: dynTags(d.tags, 'Author'),
      subtitle: [DYN_KIND_LABEL[kind], doujin.length ? doujin[0] + ' doujin' : null].filter(Boolean).join(' · '),
      external: { dynasty: kind + '/' + slug },
    };
  }

  async function searchDynasty(q) {
    const p = new URLSearchParams({ q });
    for (const c of ['Series', 'Anthology', 'Chapter']) p.append('classes[]', c);
    const r = await gmRequest(DYN + '/search?' + p.toString(), { accept: 'text/html' });
    const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
    const out = [];
    for (const dd of doc.querySelectorAll('dl.chapter-list dd')) {
      const a = dd.querySelector('a.name');
      const m = a && (a.getAttribute('href') || '').match(/^\/(series|chapters|anthologies)\/([^/?#]+)/);
      if (!m) continue;
      const kind = m[1];
      const slug = m[2];
      const title = a.textContent.trim();
      if (!title) continue;
      if (kind === 'chapters' && /\b(?:ch|chapter|vol|volume)\.?\s*\d+/i.test(title)) continue;
      const authors = [...dd.querySelectorAll('a[href^="/authors/"]')].map((x) => x.textContent.trim());
      const doujin = [...dd.querySelectorAll('small.doujin_tags a')]
        .map((x) => x.textContent.replace(/\s+Doujin$/, '').trim()).filter(Boolean);
      const rel = (dd.textContent.match(/released\s+\w+\s+\d+\s+'(\d\d)/) || [])[1];
      const labels = [...dd.querySelectorAll('span.tags a.label')].map((x) => x.textContent.trim());
      out.push({
        provider: 'Dynasty',
        isAdult: labels.some((l) => /^nsfw$/i.test(l)),
        malId: null,
        type: 'MANGA',
        title,
        synonyms: [],
        cover: null,
        thumb: null,
        banner: null,
        description: null,
        format: kind === 'chapters' ? 'ONE_SHOT' : 'MANGA',
        mediaStatus: kind === 'chapters' ? 'FINISHED' : 'RELEASING',
        episodes: null,
        chapters: null,
        volumes: null,
        genres: [],
        tags: [],
        studio: null,
        year: rel ? 2000 + parseInt(rel, 10) : null,
        authors,
        subtitle: [DYN_KIND_LABEL[kind], doujin.length ? doujin[0] + ' doujin' : null].filter(Boolean).join(' · '),
        external: { dynasty: kind + '/' + slug },
        hydrate: async () => dynNormalize(kind, slug, await gmJson(`${DYN}/${kind}/${slug}.json`)),
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  /* --- RanobeDB (light novels) ------------------------------------ */
  const RDB = 'https://ranobedb.org';
  const RDB_STATUS = {
    ongoing: 'RELEASING', completed: 'FINISHED', hiatus: 'HIATUS', stalled: 'HIATUS',
    cancelled: 'CANCELLED', unknown: 'RELEASING',
  };
  const rdbImg = (img) => (img && img.filename ? 'https://images.ranobedb.org/' + img.filename : null);
  const rdbYear = (n) => { const y = parseInt(String(n || '').slice(0, 4), 10); return y > 1000 && y < 9000 ? y : null; };
  // RanobeDB's `title` is in the series' display language; AniList-style
  // userPreferred is romaji, so use that unless the display title is English.
  const rdbTitle = (s) => ((s.lang === 'en' && s.title) || s.romaji || s.title || s.romaji_orig || s.title_orig || '');

  function rdbLite(s) {
    const cover = rdbImg(s.book && s.book.image);
    const title = rdbTitle(s);
    return {
      provider: 'RanobeDB',
      isAdult: !!(s.book && s.book.image && s.book.image.nsfw),
      malId: null,
      type: 'MANGA',
      title,
      synonyms: [...new Set([s.romaji, s.romaji_orig, s.title_orig].filter((x) => x && x !== title))],
      cover,
      thumb: cover,
      banner: null,
      description: null,
      format: 'NOVEL',
      mediaStatus: 'RELEASING',
      episodes: null,
      chapters: null,
      volumes: (s.volumes && s.volumes.count) || s.c_num_books || null,
      genres: [],
      tags: [],
      studio: null,
      year: rdbYear(s.c_start_date),
      authors: [],
      subtitle: 'Light Novel',
      external: { ranobedb: s.id },
      hydrate: async () => rdbFull(await gmJson(`${RDB}/api/v0/series/${s.id}`), cover),
    };
  }

  function rdbFull(j, coverFromSearch) {
    const s = j.series || j;
    const title = rdbTitle(s);
    const status = RDB_STATUS[s.publication_status] || 'RELEASING';
    const split = splitGenresTags((s.tags || []).filter((t) => t.ttype === 'genre').map((t) => t.name));
    const tags = (s.tags || []).filter((t) => t.ttype !== 'genre').map((t) => tagCase(t.name));
    const titles = (s.titles || []).flatMap((t) => [t.title, t.romaji]);
    const aliases = String(s.aliases || '').split('\n');
    const staff = (s.staff || [])
      .filter((x) => x.role_type === 'author' || x.role_type === 'artist')
      .map((x) => x.romaji || x.name).filter(Boolean);
    const books = s.books || [];
    const cover = rdbImg(books[0] && books[0].image) || coverFromSearch;
    return {
      provider: 'RanobeDB',
      isAdult: books.some((b) => b.image && b.image.nsfw),
      malId: intId(s.mal_id),
      type: 'MANGA',
      title,
      synonyms: [...new Set([s.romaji, s.romaji_orig, s.title_orig, ...titles, ...aliases]
        .map((x) => (x || '').trim()).filter((x) => x && x !== title))],
      cover,
      thumb: cover,
      banner: null,
      description: descToHtml(htmlToText(s.description
        || (s.book_description && s.book_description.description) || '')),
      format: 'NOVEL',
      mediaStatus: status,
      episodes: null,
      chapters: null,
      volumes: status === 'FINISHED' ? (s.c_num_books || books.length || null) : null,
      genres: split.genres,
      tags: [...split.tags, ...tags],
      studio: null,
      year: rdbYear(s.start_date || s.c_start_date),
      authors: [...new Set(staff)],
      subtitle: 'Light Novel' + (s.anilist_id ? ' · already on AniList' : ''),
      external: { ranobedb: s.id, mal: intId(s.mal_id), anilist: intId(s.anilist_id) },
    };
  }

  async function searchRanobeDB(q) {
    const j = await gmJson(`${RDB}/api/v0/series?q=${encodeURIComponent(q)}&limit=8`);
    return (j.series || []).filter((s) => !s.hidden).map(rdbLite).filter((r) => r.title);
  }

  // Minimal blurhash decoder (MangaBaka ships a blurhash per image); paints
  // an instant placeholder canvas while the real thumbnail loads.
  const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
  function bh83(str, from, len) {
    let v = 0;
    for (let i = from; i < from + len; i++) v = v * 83 + B83.indexOf(str[i]);
    return v;
  }
  const bhSrgb = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const bhByte = (v) => {
    v = Math.max(0, Math.min(1, v));
    return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
  };
  function blurhashCanvas(hash, w, h) {
    try {
      if (!hash || hash.length < 6) return null;
      const sizeFlag = bh83(hash, 0, 1);
      const ny = Math.floor(sizeFlag / 9) + 1;
      const nx = (sizeFlag % 9) + 1;
      const maxVal = (bh83(hash, 1, 1) + 1) / 166;
      const dc = bh83(hash, 2, 4);
      const colors = [[bhSrgb(dc >> 16), bhSrgb((dc >> 8) & 255), bhSrgb(dc & 255)]];
      const ac = (q) => { const t = (q - 9) / 9; return Math.sign(t) * t * t * maxVal; };
      for (let i = 1; i < nx * ny; i++) {
        const v = bh83(hash, 4 + i * 2, 2);
        colors.push([ac(Math.floor(v / 361)), ac(Math.floor(v / 19) % 19), ac(v % 19)]);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0; let g = 0; let b = 0;
          for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
              const basis = Math.cos((Math.PI * x * i) / w) * Math.cos((Math.PI * y * j) / h);
              const c = colors[i + j * nx];
              r += c[0] * basis; g += c[1] * basis; b += c[2] * basis;
            }
          }
          const p = (x + y * w) * 4;
          img.data[p] = bhByte(r);
          img.data[p + 1] = bhByte(g);
          img.data[p + 2] = bhByte(b);
          img.data[p + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return canvas;
    } catch (e) { return null; }
  }

  // Provider jobs for a search; each resolves/fails independently so one
  // source being down never hides the other's results.
  function metaSearchJobs(q, type) {
    const jobs = [{ name: 'MAL', run: () => searchJikan(q, type) }];
    if (type === 'MANGA') {
      jobs.unshift({ name: 'MangaBaka', run: () => searchMangaBaka(q) });
      // No CORS for anilist.co on these: they go through GM_xmlhttpRequest.
      jobs.push(
        { name: 'MangaDex', gm: true, run: () => searchMangaDex(q) },
        { name: 'Dynasty', gm: true, run: () => searchDynasty(q) },
        { name: 'RanobeDB', gm: true, run: () => searchRanobeDB(q) },
      );
    }
    return jobs;
  }

  /* ------------------------------------------------------------------ *
   * UI: floating "+" button + creation modal on own list pages
   * ------------------------------------------------------------------ */

  const STATUS_OPTS = (anime) => [
    ['CURRENT', anime ? 'Watching' : 'Reading'],
    ['PLANNING', 'Planning'],
    ['COMPLETED', 'Completed'],
    ['REPEATING', anime ? 'Rewatching' : 'Rereading'],
    ['PAUSED', 'Paused'],
    ['DROPPED', 'Dropped'],
  ];
  const FORMAT_OPTS = {
    ANIME: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'],
    MANGA: ['MANGA', 'NOVEL', 'ONE_SHOT'],
  };
  const MEDIA_STATUS_OPTS = [
    ['FINISHED', 'Finished'],
    ['RELEASING', 'Releasing'],
    ['NOT_YET_RELEASED', 'Not Yet Released'],
    ['CANCELLED', 'Cancelled'],
    ['HIATUS', 'Hiatus'],
  ];
  const DEFAULT_COVER = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/default.jpg';
  const DEFAULT_CHAR_IMG = 'https://s4.anilist.co/file/anilistcdn/character/large/default.jpg';
  const CHAR_ROLES = [['MAIN', 'Main'], ['SUPPORTING', 'Supporting'], ['BACKGROUND', 'Background']];

  // AniList profile colors -> rgb triplets (donators can set a custom hex).
  const PROFILE_COLORS = {
    blue: '61,180,242', purple: '192,99,255', pink: '252,157,214',
    orange: '239,136,26', red: '225,51,51', green: '76,202,81', gray: '103,123,148',
  };
  function profileColor() {
    try {
      const a = JSON.parse(localStorage.getItem('auth'));
      const c = a && a.options && a.options.profileColor;
      if (c && c.startsWith('#')) return c;
      return `rgb(${PROFILE_COLORS[c] || PROFILE_COLORS.blue})`;
    } catch (e) { return `rgb(${PROFILE_COLORS.blue})`; }
  }

  const CSS = `
  .alce-side-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px;
    height: 30px; margin: 20px 0 0 12px; border-radius: 4px; color: #fff; font-size: 20px;
    font-weight: 600; line-height: 1; cursor: pointer; user-select: none;
    background: var(--alce-accent, rgb(61,180,242)); vertical-align: top; }
  .alce-side-btn:hover { opacity: .85; }
  .alce-gear-btn { font-size: 15px; }
  .alce-side-btn svg { height: 14px; width: 14px; color: #fff; vertical-align: middle; margin: 0; }
  /* Native controls that are dead ends on a custom entry: the submission
     Edit link (ours replaces it), the Stats/Social tabs, and the
     always-empty Threads section. (Write Review works: reviews are local.) */
  html.alce-custom-media .nav .link[href$="/stats"],
  html.alce-custom-media .nav .link[href$="/social"] { display: none; }
  html.alce-custom-media .grid-section-wrap > div:has(> .threads) { display: none; }
  /* Every value here is measured from a sidebar .ranking row ("#18 Highest
     Rated All Time") so this button renders as one of them: 34.4px tall, with
     the icon pinned at the 12px padding edge. */
  .alce-edit-media-btn { background: rgb(var(--color-foreground, 21 31 46));
    color: rgb(var(--color-text, 159 173 189)); border-radius: 3px; padding: 8px 12px;
    margin-bottom: 16px; text-align: left; font-size: 1.2rem; font-weight: 500;
    line-height: 18.4px; cursor: pointer; user-select: none; transition: .15s; }
  /* Ranking rows tint the icon (gold star, red heart) independently of the
     row's text colour, so the icon carries the accent, not the label. */
  .alce-btn-icon { height: 8px; width: 13px; vertical-align: -0.5px; margin-right: 4px;
    color: var(--alce-accent, rgb(61,180,242)); }
  /* A ranking row's .rank-text is an inline-block filling the width left over
     after the icon, with its label centred inside, so the icon stays pinned
     left while the text sits centred in the remaining space. */
  .alce-btn-label { display: inline-block; width: calc(100% - 17px); text-align: center; }
  /* Ranking rows highlight by turning their label AniList blue on hover (the
     card and the icon keep their colours), over a .15s transition. */
  .alce-edit-media-btn:hover { color: rgb(61,180,242); }
  /* Mobile fallback for the button above: AniList hides .rankings at 760px,
     so a square edit shortcut sits beside the favourite heart instead. */
  .alce-edit-actions-btn { display: none; }
  @media (max-width: 760px) {
    /* The native actions row is a "1fr 35px" grid (list button, heart); widen
       it to a third 35px track so the shortcut sits beside the heart. */
    .actions:has(.alce-edit-actions-btn) { grid-template-columns: 1fr 35px 35px; }
    .alce-edit-actions-btn { display: inline-flex; align-items: center; justify-content: center;
      width: 35px; height: 35px; border-radius: 3px;
      cursor: pointer; background: var(--alce-accent, rgb(61,180,242)); }
    .alce-edit-actions-btn .alce-btn-icon { margin: 0; height: 10px; width: 16px; color: #fff; }
  }
  /* The site's message toasts (which our toast() uses) get element-ui's
     running popup z-index, which can end up under our overlays; keep them
     on top of everything, like the fallback toasts. */
  .el-message { z-index: 3001 !important; }
  .alce-overlay { position: fixed; inset: 0; z-index: 2001; background: rgba(0,0,0,.5);
    display: flex; align-items: flex-start; justify-content: center; overflow-y: auto; }
  /* Modal shell in AniList's dialog idiom: foreground card, a header bar
     with title + close, an optional tab strip, then a padded body. */
  /* Same shell as AniList's list editor dialog (measured): a darker header
     band holding the title, the close cross at top-right and, in the manage
     modal, the section tabs (media-page nav idiom: active tab is blue), over
     a foreground-coloured body; 4px radius, the editor's shadow. */
  .alce-modal { margin: 8vh 20px 40px; width: 640px; max-width: 95vw; border-radius: 4px; overflow: hidden;
    background: rgb(var(--color-foreground, 21 31 46)); color: rgb(var(--color-text, 159 173 189));
    font-size: 1.3rem; padding: 0; box-shadow: 0 2px 33px rgba(0,0,0,.48); }
  .alce-modal-top { background: rgb(var(--color-foreground-grey, 15 22 31)); position: relative; }
  .alce-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: 24px 56px 20px 24px; }
  .alce-modal-head h2 { color: rgb(var(--color-text, 159 173 189)); font-size: 1.6rem; margin: 0; font-weight: 500; }
  .alce-modal-sub { font-size: 1.2rem; color: rgb(var(--color-text-light, 122 133 143)); margin-top: 5px; line-height: 1.5; }
  .alce-modal-close { position: absolute; top: 14px; right: 16px; border: none; background: transparent;
    color: rgb(var(--color-text-light, 122 133 143)); font-size: 1.5rem; cursor: pointer; padding: 6px 8px;
    border-radius: 3px; line-height: 1; transition: color .15s; }
  .alce-modal-close:hover { color: rgb(var(--color-text, 159 173 189)); }
  .alce-modal-body { padding: 24px; }
  .alce-modal h2 { color: rgb(var(--color-text, 159 173 189)); font-size: 1.5rem; margin: 0 0 20px;
    font-weight: 600; }
  .alce-tabs { display: flex; gap: 22px; padding: 0 24px; overflow-x: auto; }
  .alce-tab { padding: 0 0 12px; font-size: 1.3rem; font-weight: 500; cursor: pointer; white-space: nowrap;
    color: rgb(var(--color-text-light, 122 133 143)); transition: color .15s; }
  .alce-tab:hover { color: rgb(var(--color-text, 159 173 189)); }
  .alce-tab.active { color: var(--alce-accent, rgb(61,180,242)); }
  .alce-tab-body { padding: 24px; }
  .alce-section { margin-top: 22px; }
  .alce-section:first-child { margin-top: 0; }
  .alce-section-title { font-size: 1.1rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    color: rgb(var(--color-text-light, 122 133 143)); margin-bottom: 8px; }
  .alce-section .alce-sync-status { margin-top: 0; }
  /* Quick-search idiom: dark rounded box, magnifier at the left, 1.5rem
     semi-bold input on a transparent background. */
  .alce-search { display: grid; grid-template-columns: 14px auto; align-items: center; gap: 12px;
    background: rgb(var(--color-background, 11 22 34)); border-radius: 6px; padding: 0 15px; margin-bottom: 14px; }
  .alce-search svg { width: 14px; height: 14px; color: rgb(var(--color-text-light, 122 133 143)); margin: 0; }
  .alce-search input { border: none; outline: none; background: transparent; height: 46px; padding: 0; width: 100%;
    font-size: 1.5rem; font-weight: 600; color: rgb(var(--color-text, 159 173 189)); font-family: inherit; }
  .alce-search input::placeholder { color: rgb(var(--color-text-light, 122 133 143)); font-weight: 600; }
  /* Media list (table view) idiom: transparent rows on the foreground card,
     40px covers in a 60px cell, 1.4rem cells, Status / Type columns, and the
     whole row turning blue on hover. */
  .alce-list { max-height: 420px; overflow-y: auto; border-radius: 4px; }
  .alce-list-head, .alce-list-row { display: flex; align-items: center; font-size: 1.4rem; }
  .alce-list-head { font-weight: 500; color: rgb(var(--color-text, 159 173 189)); padding: 4px 0 8px; }
  .alce-list-head .alce-col-status, .alce-list-head .alce-col-type, .alce-list-head .alce-col-progress { color: rgb(var(--color-text, 159 173 189)); }
  .alce-list-row { cursor: pointer; border-radius: 4px; transition: background-color .15s, color .15s; min-height: 50px; padding: 5px 0; box-sizing: border-box; }
  .alce-list-row:hover { background: var(--alce-accent, rgb(61,180,242)); color: #fff; }
  .alce-list-row:hover .alce-list-owner, .alce-list-row:hover .alce-col-status, .alce-list-row:hover .alce-col-type { color: rgba(255,255,255,.85); }
  .alce-col-cover { flex: none; width: 55px; padding-left: 5px; box-sizing: border-box; }
  .alce-list-cover { width: 40px; height: 40px; border-radius: 3px;
    background: rgb(var(--color-background, 11 22 34)) 50% 50% / cover no-repeat; }
  .alce-col-title { flex: 1; min-width: 0; padding: 0 15px; }
  /* Long titles wrap onto a second line like the real list's rows do. */
  .alce-list-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    line-height: 1.35; overflow-wrap: anywhere; }
  .alce-list-owner { font-size: 1.1rem; color: rgb(var(--color-text-light, 122 133 143)); padding-top: 2px; }
  .alce-col-progress { flex: none; width: 84px; padding: 0 10px; box-sizing: border-box; color: rgb(var(--color-text, 159 173 189)); }
  .alce-col-status { flex: none; width: 96px; padding: 0 10px; box-sizing: border-box; color: rgb(var(--color-text, 159 173 189)); }
  .alce-col-type { flex: none; width: 92px; padding: 0 10px; box-sizing: border-box; color: rgb(var(--color-text, 159 173 189)); }
  .alce-col-actions { flex: none; width: 104px; display: flex; gap: 6px; padding: 0 10px 0 4px; box-sizing: border-box; justify-content: flex-end; }
  .alce-list-row:hover .alce-col-progress { color: rgba(255,255,255,.85); }
  /* Row actions: quiet at rest, and their own solid button on hover: pen /
     download fill with the profile colour (white on an already-highlighted
     row), the trash fills red. */
  .alce-list-row .alce-item-act { background: transparent; opacity: 1; color: rgb(var(--color-text-light, 122 133 143)); transition: background-color .15s, color .15s; }
  .alce-list-row .alce-item-act:hover { color: #fff; background: var(--alce-accent, rgb(61,180,242)); }
  .alce-list-row:hover .alce-item-act { color: rgba(255,255,255,.9); }
  .alce-list-row:hover .alce-item-act:hover { color: var(--alce-accent, rgb(61,180,242)); background: #fff; }
  .alce-list-row .alce-item-del { background: transparent; color: rgb(232,93,117); opacity: 1; transition: background-color .15s, color .15s; }
  .alce-list-row .alce-item-del:hover, .alce-list-row:hover .alce-item-del:hover { background: rgb(232,93,117); color: #fff; }
  .alce-list-row:hover .alce-item-del { color: #fff; }
  @media (max-width: 640px) { .alce-col-status, .alce-col-type, .alce-col-progress { display: none; } }
  .alce-item-act { width: 26px; height: 26px; border: none; border-radius: 4px; flex-shrink: 0;
    background: rgb(var(--color-foreground, 21 31 46)); color: rgb(var(--color-text, 159 173 189));
    cursor: pointer; font-size: 1.3rem; line-height: 1; opacity: .85; }
  .alce-item-act:hover { opacity: 1; color: var(--alce-accent, rgb(61,180,242)); }
  .alce-item-act svg { height: 11px; width: 11px; margin: 0; color: inherit; vertical-align: middle; }
  .alce-section .alce-io-btns + .alce-sync-status { margin-top: 12px; }
  /* Status card rows: coloured state dot, bold label + message, an optional
     action button at the right. */
  .alce-status-card { margin-top: 14px; background: rgb(var(--color-background, 11 22 34)); border-radius: 4px; padding: 4px 14px; }
  .alce-status-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; font-size: 1.3rem; }
  .alce-status-row + .alce-status-row { border-top: 1px solid rgba(var(--color-text, 159 173 189), .06); }
  .alce-status-dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: rgb(var(--color-text-light, 122 133 143)); }
  .alce-status-row[data-state="ok"] .alce-status-dot { background: rgb(var(--color-green, 76 202 81)); box-shadow: 0 0 0 3px rgba(76,202,81,.18); }
  .alce-status-row[data-state="busy"] .alce-status-dot { background: rgb(247,191,99); animation: alce-pulse 1s ease-in-out infinite; }
  .alce-status-row[data-state="bad"] .alce-status-dot { background: rgb(232,93,117); box-shadow: 0 0 0 3px rgba(232,93,117,.18); }
  @keyframes alce-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .alce-status-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .alce-status-main b { font-weight: 600; color: rgb(var(--color-text, 159 173 189)); }
  .alce-status-text { font-size: 1.2rem; color: rgb(var(--color-text-light, 122 133 143)); overflow-wrap: anywhere; }
  .alce-status-row[data-state="bad"] .alce-status-text { color: rgb(232,93,117); }
  .alce-status-act { flex: none; border: none; border-radius: 4px; height: 30px; padding: 0 12px; min-width: 84px; font-size: 1.2rem; cursor: pointer;
    background: rgb(var(--color-foreground, 21 31 46)); color: rgb(var(--color-text, 159 173 189)); }
  .alce-status-act:hover { color: #fff; background: var(--alce-accent, rgb(61,180,242)); }
  .alce-report { margin-top: 6px; }
  .alce-report-row { display: flex; gap: 12px; align-items: baseline; padding: 6px 0; font-size: 1.2rem;
    border-bottom: 1px solid rgba(var(--color-text, 159 173 189), .06); }
  .alce-report-row:last-child { border-bottom: none; }
  .alce-report-kind { flex: none; min-width: 130px; color: rgb(var(--color-text-light, 122 133 143)); }
  .alce-report-row.ok .alce-report-kind { color: rgb(var(--color-green, 76 202 81)); }
  .alce-report-row.bad .alce-report-kind { color: rgb(232,93,117); }
  .alce-report-row.removed .alce-report-kind { color: rgb(232,93,117); }
  .alce-report-row.new .alce-report-kind { color: rgb(var(--color-green, 76 202 81)); }
  .alce-report-title { min-width: 0; overflow-wrap: anywhere; }
  .alce-check b { color: rgb(var(--color-text, 159 173 189)); font-weight: 600; }
  .alce-check-desc { font-size: 1.2rem; color: rgb(var(--color-text-light, 122 133 143)); margin-top: 2px; }
  .alce-modal-confirm { width: 440px; }
  .alce-modal-manage { width: 760px; }
  .alce-confirm-text { font-size: 1.3rem; line-height: 1.5; margin-bottom: 16px; }
  .alce-btn.alce-danger:disabled { opacity: .45; cursor: default; }
  .alce-section textarea + .alce-io-btns { margin-top: 10px; }
  @media (max-width: 640px) { .alce-modal-head, .alce-modal-body, .alce-tab-body { padding-left: 16px; padding-right: 16px; } }
  .alce-field { margin-bottom: 16px; }
  .alce-field label { display: block; font-size: 1.4rem; font-weight: 500; margin-bottom: 8px;
    color: rgb(var(--color-text, 159 173 189)); }
  .alce-field input, .alce-field select, .alce-field textarea { width: 100%; box-sizing: border-box;
    border: none; border-radius: 4px; height: 40px; padding: 0 15px; font-size: 1.4rem;
    color: rgb(var(--color-text, 159 173 189)); background: rgb(var(--color-background, 11 22 34));
    outline: none; }
  .alce-field select, .alce-char-row select, .alce-cover-lang { appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' stroke='%23748aa1' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat; background-position: right 12px center; padding-right: 30px; cursor: pointer; }
  .alce-field textarea { height: auto; resize: vertical; min-height: 90px; padding: 10px 15px;
    font-family: inherit; }
  .alce-chars { margin-bottom: 16px; }
  .alce-char-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
  .alce-char-row input, .alce-char-row select { border: none; border-radius: 4px; height: 34px;
    padding: 0 10px; font-size: 1.3rem; color: rgb(var(--color-text, 159 173 189));
    background-color: rgb(var(--color-background, 11 22 34)); outline: none; min-width: 0; }
  .alce-char-row select { padding-right: 26px; }
  .alce-char-row .c-name { flex: 3; }
  .alce-char-row .c-role { flex: 2; }
  .alce-char-row .c-img { flex: 3; }
  .alce-char-row button { background: none; border: none; color: rgb(232,93,117); cursor: pointer;
    font-size: 1.2rem; padding: 0 2px; }
  .alce-add-char { background: rgb(var(--color-background, 11 22 34)); border: none; border-radius: 4px;
    color: rgb(var(--color-text, 159 173 189)); cursor: pointer; font-size: 1.3rem; padding: 0 16px; height: 36px; }
  .alce-add-char:hover { color: #fff; }
  .alce-row { display: flex; gap: 10px; }
  .alce-row .alce-field { flex: 1; }
  .alce-img-field-row { display: flex; gap: 8px; align-items: stretch; }
  .alce-img-field-row input { flex: 1; min-width: 0; }
  .alce-embed-btn { flex: none; border: none; border-radius: 4px; padding: 0 14px; cursor: pointer;
    font-size: 1.3rem; font-weight: 500; color: #fff; background: var(--alce-accent, rgb(61,180,242)); }
  .alce-embed-btn:hover { opacity: .85; }
  .alce-embed-btn:disabled { opacity: .5; cursor: default; }
  .alce-btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  .alce-btn { border: none; border-radius: 4px; padding: 0 18px; height: 36px; cursor: pointer; font-size: 1.3rem; font-weight: 500; }
  .alce-btn.primary { background: var(--alce-accent, rgb(61,180,242)); color: #fff; }
  .alce-btn.primary:hover { opacity: .85; }
  .alce-btn.plain { background: transparent; color: rgb(var(--color-text-light, 122 133 143)); }
  .alce-manage { margin-top: 18px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 14px; }
  .alce-manage-title { font-size: 1.4rem; font-weight: 500; color: rgb(var(--color-text, 159 173 189));
    margin-bottom: 8px; }
  .alce-manage-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 1.3rem; }
  .alce-manage-row span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alce-manage-row button { background: none; border: none; color: rgb(232,93,117); cursor: pointer; font-size: 1.2rem; }
  .alce-io button, .alce-move button, .alce-sync button, .alce-panel-btns button, .alce-section .alce-io-btns button {
    background: rgb(var(--color-background, 11 22 34)); border: none; border-radius: 4px;
    color: rgb(var(--color-text, 159 173 189)); cursor: pointer; font-size: 1.3rem; padding: 0 16px; height: 36px; }
  .alce-io button:hover, .alce-move button:hover, .alce-sync button:hover,
  .alce-panel-btns button:hover, .alce-section .alce-io-btns button:hover { color: #fff; }
  .alce-io button.blue, .alce-move button.blue, .alce-sync button.blue, .alce-panel-btns button.blue,
  .alce-section .alce-io-btns button.blue { background: var(--alce-accent, rgb(61,180,242)); color: #fff; }
  .alce-io button.blue:hover, .alce-move button.blue:hover, .alce-sync button.blue:hover,
  .alce-panel-btns button.blue:hover, .alce-section .alce-io-btns button.blue:hover { opacity: .85; }
  .alce-section .alce-io-btns { display: flex; gap: 8px; flex-wrap: wrap; }
  .alce-section .alce-io-btns button:disabled { opacity: .6; cursor: default; }
  .alce-section .alce-io-btns button.alce-danger { background: rgb(232,93,117); color: #fff; }
  .alce-section textarea { width: 100%; box-sizing: border-box; height: 72px; border: none; border-radius: 4px;
    background: rgb(var(--color-background, 11 22 34)); color: rgb(var(--color-text, 159 173 189));
    padding: 8px 10px; font-size: 1.2rem; margin-top: 10px; display: none; font-family: monospace; }
  .alce-panel-btns { display: flex; gap: 10px; margin-top: 4px; }
  .alce-edit-panel { margin-bottom: 25px; font-size: 1.3rem; color: rgb(var(--color-text, 159 173 189)); }
  .alce-edit-panel h2 { font-size: 1.4rem; font-weight: 500; margin: 0 0 10px;
    color: rgb(var(--color-text, 159 173 189)); }
  .alce-edit-panel-card { background: rgb(var(--color-foreground, 21 31 46)); border-radius: 3px;
    padding: 20px; }
  /* Labels inside the panel match the native form's (13px/400, 5px gap)
     rather than the list editor's heavier ones. */
  .alce-edit-panel .alce-field label { font-size: 1.3rem; font-weight: 400; margin-bottom: 5px; }
  /* Native-style item rows (modelled on the edit page's character rows):
     cover thumb, title + sub-line, red delete button on the right. */
  .alce-item-row { display: flex; align-items: center; gap: 10px;
    background: rgb(var(--color-background, 11 22 34)); border-radius: 3px;
    padding: 6px 10px; margin-bottom: 8px; font-size: 1.3rem; }
  .alce-item-row.link { cursor: pointer; }
  .alce-item-cover { width: 32px; height: 32px; border-radius: 3px; flex-shrink: 0;
    background: rgb(var(--color-foreground, 21 31 46)) 50% 50% / cover no-repeat; }
  .alce-item-text { flex: 1; min-width: 0; }
  .alce-item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alce-item-sub { font-size: 1.1rem; color: rgb(var(--color-text-light, 122 133 143));
    padding-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alce-item-del { width: 26px; height: 26px; border: none; border-radius: 4px; flex-shrink: 0;
    background: rgb(232,93,117); color: #fff; cursor: pointer; opacity: .85; }
  .alce-item-del:hover { opacity: 1; }
  .alce-item-del svg { height: 11px; width: 11px; margin: 0; color: #fff; vertical-align: middle; }
  button.alce-danger { background: rgb(232,93,117); color: #fff; border: none; border-radius: 4px;
    padding: 0 16px; height: 36px; font-size: 1.3rem; cursor: pointer; }
  button.alce-danger:hover { opacity: .9; color: #fff; }
  .alce-hinted { cursor: help; }
  .alce-toasts { position: fixed; top: 74px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    z-index: 3000; pointer-events: none; max-width: calc(100vw - 30px); }
  .alce-toast { transform: translateY(-8px);
    width: max-content; max-width: 100%; box-sizing: border-box; text-align: center;
    padding: 11px 20px; border-radius: 4px; font-size: 1.3rem; font-weight: 500;
    background: rgb(214,240,206); color: rgb(64,110,50); box-shadow: 0 2px 12px rgba(0,0,0,.25);
    opacity: 0; transition: opacity .25s, transform .25s; pointer-events: none; }
  .alce-toast.err { background: rgb(246,215,215); color: rgb(168,56,68); }
  .alce-toast.show { opacity: 1; transform: translateY(0); }
  .alce-io { margin-top: 14px; }
  .alce-io textarea { width: 100%; box-sizing: border-box; height: 60px; border: none; border-radius: 4px;
    background: rgb(var(--color-background, 11 22 34)); color: rgb(var(--color-text, 159 173 189));
    padding: 8px 10px; font-size: 1.2rem; margin-top: 10px; display: none; }
  .alce-io .alce-io-btns { display: flex; gap: 10px; }
  .alce-move { margin-top: 16px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 14px; }
  .alce-move .alce-io-btns { display: flex; gap: 10px; }
  .alce-sync { margin-top: 16px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 14px; }
  .alce-sync .alce-io-btns { display: flex; gap: 10px; }
  .alce-sync-status { font-size: 1.2rem; margin: 6px 0 10px; color: rgb(var(--color-text-light, 122 133 143)); }
  .alce-check { display: flex; gap: 10px; align-items: flex-start; font-size: 1.3rem; cursor: pointer; margin: 8px 0 4px;
    color: rgb(var(--color-text, 159 173 189)); }
  .alce-check input { margin-top: 3px; flex: none; }
  .alce-import { margin-bottom: 14px; }
  .alce-import-results { max-height: 280px; overflow-y: auto; margin-top: 6px;
    border-radius: 4px; }
  /* Rows mirror AniList's quick-search .result rows: 40px square cover in a
     grid, 1.5rem/600 name over a 1.2rem info line, solid blue hover that
     turns the text white. */
  .alce-import-row { display: grid; grid-template-columns: 40px auto max-content; align-items: center;
    padding: 10px 12px; cursor: pointer; font-size: 1.5rem; font-weight: 600;
    color: rgb(var(--color-text, 159 173 189)); transition: background-color .15s, color .15s; }
  .alce-import-row:first-child { border-radius: 4px 4px 0 0; }
  .alce-import-row:last-child { border-radius: 0 0 4px 4px; }
  .alce-import-row:hover { background: rgb(61,180,242); color: #fff; }
  .alce-import-row:hover .alce-import-sub { color: rgba(255,255,255,.8); }
  .alce-import-cover { width: 40px; height: 40px; border-radius: 3px; overflow: hidden;
    background: rgb(var(--color-background, 11 22 34)) 50% 50% / cover no-repeat; }
  .alce-import-cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .alce-import-text { min-width: 0; padding: 0 10px; }
  .alce-import-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alce-import-sub { font-size: 1.2rem; font-weight: 500; padding-top: 3px;
    color: rgb(var(--color-text-light, 122 133 143)); transition: color .15s;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alce-import-badge { font-size: 1rem; font-weight: 500; padding: 2px 6px; border-radius: 3px;
    background: var(--alce-accent, rgb(61,180,242)); color: #fff; }
  .alce-import-err { color: rgb(232,93,117); font-size: 1.1rem; padding: 2px 4px; }
  .alce-import-status { font-size: 1.1rem; color: rgb(var(--color-text-light, 122 133 143)); margin-top: 4px; }
  .alce-covers { margin: -8px 0 16px; }
  .alce-cover-btn { background: rgb(var(--color-background, 11 22 34)); border: none; border-radius: 4px;
    color: rgb(var(--color-text, 159 173 189)); cursor: pointer;
    font-size: 1.3rem; padding: 0 16px; height: 36px; margin-right: 10px; }
  .alce-cover-btn:hover { color: #fff; }
  .alce-cover-lang { border: none; border-radius: 4px; padding: 0 26px 0 12px; height: 36px; font-size: 1.3rem;
    color: rgb(var(--color-text, 159 173 189)); background-color: rgb(var(--color-background, 11 22 34)); }
  .alce-cover-grid { display: flex; flex-wrap: wrap; gap: 8px; max-height: 240px; overflow-y: auto; margin-top: 8px; }
  .alce-cover-cell { width: 72px; cursor: pointer; text-align: center; }
  .alce-cover-thumb { position: relative; width: 72px; height: 102px; border-radius: 4px; overflow: hidden;
    border: 2px solid transparent; box-sizing: border-box; background: rgb(var(--color-background, 11 22 34)); }
  .alce-cover-thumb canvas, .alce-cover-thumb img { position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; }
  .alce-cover-thumb img { opacity: 0; transition: opacity .15s; }
  .alce-cover-thumb img.ld { opacity: 1; }
  .alce-cover-cell.sel .alce-cover-thumb { border-color: var(--alce-accent, rgb(61,180,242)); }
  .alce-cover-cell span { display: block; font-size: 1rem; color: rgb(var(--color-text-light, 122 133 143));
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;

  function routeInfo() {
    const m = location.pathname.match(/^\/user\/([^/]+)\/(animelist|mangalist)/);
    if (!m) return null;
    return { userName: m[1], type: m[2] === 'animelist' ? 'ANIME' : 'MANGA' };
  }

  function currentOwner() {
    const r = routeInfo();
    if (!r) return null;
    for (const o of Object.values(db.owners)) {
      if (o.name && o.name.toLowerCase() === r.userName.toLowerCase()) return o;
    }
    return null;
  }

  // Native submission editor URL for a custom entry; media details are
  // edited there (the script prefills the form and applies submits locally).
  const editHref = (rec) => `/edit/${rec.type === 'ANIME' ? 'anime' : 'manga'}/${rec.id}`;
  const mediaHref = (rec) => `/${rec.type === 'ANIME' ? 'anime' : 'manga'}/${rec.id}`;

  // The native edit page's Submit ends with a "Submission successfully
  // sent" toast and a push to "/" (non-mods). For a custom entry nothing
  // was submitted, so while a local submit is fresh the toast reads as a
  // local save and the push goes back to the entry page instead.
  let lastLocalSubmit = null;
  const noteLocalSubmit = (rec) => { lastLocalSubmit = { rec, at: Date.now() }; };
  const localSubmitFresh = () => !!(lastLocalSubmit && Date.now() - lastLocalSubmit.at < 15000);
  let submitHooksInstalled = false;
  function installSubmitHooks() {
    if (submitHooksInstalled) return;
    const app = document.querySelector('#app');
    const vm = app && app.__vue__;
    if (!vm || !vm.$router) return;
    let P = vm;
    while (P && !Object.prototype.hasOwnProperty.call(P, '$notify')) P = Object.getPrototypeOf(P);
    if (P && typeof P.$notify === 'function') {
      const origNotify = P.$notify;
      P.$notify = function (opts) {
        try {
          if (opts && typeof opts === 'object' && localSubmitFresh()
            && /^(Submission successfully sent|Entry successfully updated)$/.test(String(opts.message || ''))) {
            opts = Object.assign({}, opts, { message: 'Custom entry saved locally' });
          }
        } catch (e) { /* ignore */ }
        return origNotify.call(this, opts);
      };
    }
    const router = vm.$router;
    const origPush = router.push;
    router.push = function (loc, ...rest) {
      try {
        const path = typeof loc === 'string' ? loc : (loc && loc.path);
        if ((path === '/' || path === '/home') && localSubmitFresh() && /^\/edit\/(anime|manga)\/\d+/.test(location.pathname)) {
          const target = mediaHref(lastLocalSubmit.rec);
          lastLocalSubmit = null;
          loc = typeof loc === 'string' ? target : Object.assign({}, loc, { path: target });
        }
      } catch (e) { /* ignore */ }
      return origPush.call(this, loc, ...rest);
    };
    submitHooksInstalled = true;
  }

  // Custom media id in the current /anime/<id> or /manga/<id> route, if any.
  function mediaRouteRec() {
    const m = location.pathname.match(/^\/(anime|manga)\/(\d+)/);
    if (!m) return null;
    const id = parseInt(m[2], 10);
    return isCustomId(id) ? recById(id) : null;
  }

  // On a custom entry's edit page, pre-seed the "submission sources" field in
  // the store so the native Submit passes AniList's client-side validation
  // without the user typing anything. Harmless: the SaveMedia it feeds into is
  // intercepted locally and never sent.
  function fillSubmissionSources() {
    if (!editPageRec()) return;
    const store = vueStore();
    if (!store || !store.state.mediaSubmission) return;
    const media = store.state.mediaSubmission.media;
    if (media && (!media.submissionSources || media.submissionSources === '')) {
      try {
        store.commit('mediaSubmission/updateMedia', { key: 'submissionSources', value: 'Local custom entry (not submitted)' });
      } catch (e) { /* ignore */ }
    }
  }

  // Keep the "+" button next to the list sidebar's random-entry button, and
  // an Edit button in the rankings slot of a custom entry's media page.
  // Late injection, general repair. The hooks patch responses on their way
  // into the store; when the page's first queries ran before the hooks
  // existed, their responses reached the store unpatched. Every store-level
  // patcher is idempotent (membership checks or value markers), so running
  // them against the store on the UI tick repairs whatever the initial
  // queries brought, whenever they arrive, without caring which request
  // was missed: statistics + activity history, search pages, relation /
  // character / staff / studio backlinks, profile favourites. Lists, home
  // previews and feeds are repaired by selfHeal (timed after load), and a
  // custom page that 404'd is re-routed there.
  function healFromStore() {
    if (!vueStore()) return;
    try { tickNotifications(false); } catch (e) { /* best effort */ }
    for (const fn of [healUserStatistics, healSearchPages, healBacklinks, healFavourites, healNotifications]) {
      try { fn(); } catch (e) { /* best effort */ }
    }
  }

  function ensureButtons() {
    fillSubmissionSources();
    try { installSubmitHooks(); } catch (e) { /* best effort */ }
    healFromStore();
    try { ensureEditPanel(); } catch (e) { /* best effort */ }
    const sideBtn = document.querySelector('.alce-side-btn');
    if (routeInfo() && !sideBtn) {
      const host = document.querySelector('.filters .random-btn');
      if (host) {
        host.insertAdjacentElement('afterend',
          el('div', { class: 'alce-side-btn alce-gear-btn', title: 'Manage Custom Entries', onclick: () => openManageModal() },
            svgIcon(ICON_WRENCH)));
        host.insertAdjacentElement('afterend',
          el('div', { class: 'alce-side-btn', title: 'Add Custom Entry', onclick: () => openModal() }, '+'));
      }
    } else if (!routeInfo() && sideBtn) {
      for (const b of document.querySelectorAll('.alce-side-btn')) b.remove();
    }

    const rec = mediaRouteRec();
    document.documentElement.classList.toggle('alce-custom-media', !!rec);
    const editBtn = document.querySelector('.alce-edit-media-btn');
    const actionsBtn = document.querySelector('.alce-edit-actions-btn');
    const goEdit = () => { const r = mediaRouteRec(); if (r) location.assign(editHref(r)); };
    if (rec) {
      const sidebar = document.querySelector('.media .sidebar, .sidebar');
      if (sidebar && !editBtn) {
        const rankings = sidebar.querySelector('.rankings');
        const btn = el('div', { class: 'alce-edit-media-btn', onclick: goEdit },
          svgIcon(ICON_TAG), el('span', { class: 'alce-btn-label' }, 'Edit Custom Entry'));
        if (rankings) rankings.insertAdjacentElement('afterbegin', btn);
        else sidebar.insertAdjacentElement('afterbegin', btn);
      }
      // The rankings block (and the button above) is display: none at mobile
      // widths, so a square shortcut joins the list/favourite actions row too.
      const fav = document.querySelector('.actions .favourite');
      const actions = fav ? fav.parentElement : document.querySelector('.media .actions');
      if (actions && !actionsBtn) {
        actions.appendChild(el('div', {
          class: 'alce-edit-actions-btn', title: 'Edit Custom Entry', onclick: goEdit,
        }, svgIcon(ICON_TAG)));
      }
    } else {
      if (editBtn) editBtn.remove();
      if (actionsBtn) actionsBtn.remove();
    }
  }

  // Horizontal tag: rounded body, tapering to a rounded point on the right.
  // Drawn here rather than taken from an icon set; Font Awesome's fa-tag is
  // diagonal, and the flat sets that have a straight one are licensed.
  // The viewBox is cropped to the glyph (not padded to a square) so sizing by
  // height matches the FA icons beside it; a square box would letterbox this
  // wide shape down to ~7px tall against their 10.5-12px.
  const ICON_TAG = {
    viewBox: '0 0 474 288',
    d: 'M32 0h304l138 132a16 16 0 0 1 0 24L336 288H32a32 32 0 0 1-32-32V32A32 32 0 0 1 32 0z',
  };

  // Font Awesome 5 free-solid fa-search (CC BY 4.0), the quick search's icon.
  const ICON_SEARCH = {
    viewBox: '0 0 512 512',
    d: 'M505 442.7L405.3 343c-4.5-4.5-10.6-7-17-7H372c27.6-35.3 44-79.7 44-128C416 93.1 322.9 0 208 0S0 93.1 0 208s93.1 208 208 208c48.3 0 92.7-16.4 128-44v16.3c0 6.4 2.5 12.5 7 17l99.7 99.7c9.4 9.4 24.6 9.4 33.9 0l28.3-28.3c9.4-9.4 9.4-24.6.1-34zM208 336c-70.7 0-128-57.2-128-128 0-70.7 57.2-128 128-128 70.7 0 128 57.2 128 128 0 70.7-57.2 128-128 128z',
  };
  // Font Awesome 5 free-solid fa-pen and fa-download (CC BY 4.0).
  const ICON_PEN = {
    viewBox: '0 0 512 512',
    d: 'M290.74 93.24l128.02 128.02-277.99 277.99-114.14 12.6C11.35 513.54-1.56 500.62.14 485.34l12.7-114.22 277.9-277.88zm207.2-19.06l-60.11-60.11c-18.75-18.75-49.16-18.75-67.91 0l-56.55 56.55 128.02 128.02 56.55-56.55c18.75-18.76 18.75-49.16 0-67.91z',
  };
  const ICON_DOWNLOAD = {
    viewBox: '0 0 512 512',
    d: 'M216 0h80c13.3 0 24 10.7 24 24v168h87.7c17.8 0 26.7 21.5 14.1 34.1L269.7 378.3c-7.5 7.5-19.8 7.5-27.3 0L90.1 226.1c-12.6-12.6-3.7-34.1 14.1-34.1H192V24c0-13.3 10.7-24 24-24zm296 376v112c0 13.3-10.7 24-24 24H24c-13.3 0-24-10.7-24-24V376c0-13.3 10.7-24 24-24h146.7l49 49c20.1 20.1 52.5 20.1 72.6 0l49-49H488c13.3 0 24 10.7 24 24zm-124 88c0-11-9-20-20-20s-20 9-20 20 9 20 20 20 20-9 20-20zm64 0c0-11-9-20-20-20s-20 9-20 20 9 20 20 20 20-9 20-20z',
  };
  // Font Awesome free-solid fa-trash (CC BY 4.0).
  const ICON_TRASH = {
    viewBox: '0 0 448 512',
    d: 'M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64s14.3 32 32 32h384c17.7 0 32-14.3 32-32s-14.3-32-32-32h-96l-7.2-14.3C305.7 6.8 294.7 0 282.9 0H165.1c-11.8 0-22.8 6.8-29.9 17.7zM416 128H32l21.2 339c1.6 25.3 22.6 45 47.9 45h245.8c25.3 0 46.3-19.7 47.9-45L416 128z',
  };

  // AniList-style toast (top centre, auto-dismisses) instead of dumping
  // results into a status line under the button.
  // Toasts stack in a fixed column (newest at the bottom) so several fired
  // together, "cover embedded" + "entry saved", stay readable.
  function toastHost() {
    let host = document.querySelector('.alce-toasts');
    if (!host) {
      host = el('div', { class: 'alce-toasts' });
      document.body.appendChild(host);
    }
    return host;
  }
  // Toasts use AniList's own message component (the green "Submission
  // successfully sent" style) whenever the app is up; the DOM fallback
  // below covers the moments before it is.
  function toast(msg, isError) {
    const vm = document.querySelector('#app') && document.querySelector('#app').__vue__;
    if (vm && typeof vm.$notify === 'function') {
      try {
        vm.$notify({ type: isError ? 'error' : 'success', message: msg, duration: isError ? 5000 : 3200 });
        return;
      } catch (e) { /* fall through to the DOM toast */ }
    }
    const t = el('div', { class: 'alce-toast' + (isError ? ' err' : '') }, (isError ? '✕ ' : '✓ ') + msg);
    toastHost().appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, isError ? 5000 : 3200);
  }

  // Font Awesome 5 free-solid fa-wrench (CC BY 4.0).
  const ICON_WRENCH = {
    viewBox: '0 0 512 512',
    d: 'M507.73 109.1c-2.24-9.03-13.54-12.09-20.12-5.51l-74.36 74.36-67.88-11.31-11.31-67.88 74.36-74.36c6.62-6.62 3.43-17.9-5.66-20.16-47.38-11.74-99.55.91-136.58 37.93-39.64 39.64-50.55 97.1-34.05 147.2L18.74 402.76c-24.99 24.99-24.99 65.51 0 90.5 24.99 24.99 65.51 24.99 90.5 0l213.21-213.21c50.12 16.71 107.47 5.68 147.37-34.22 37.07-37.07 49.7-89.32 37.91-136.73zM64 472c-13.25 0-24-10.75-24-24 0-13.26 10.75-24 24-24s24 10.74 24 24c0 13.25-10.75 24-24 24z',
  };

  // Inline SVG icon in AniList's own sidebar style (12px, currentColor).
  function svgIcon(icon) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', icon.viewBox);
    svg.setAttribute('class', 'alce-btn-icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', icon.d);
    svg.appendChild(path);
    return svg;
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function field(labelText, input) {
    return el('div', { class: 'alce-field' }, el('label', {}, labelText), input);
  }

  function select(opts, value) {
    const s = el('select');
    for (const [v, label] of opts) {
      const o = el('option', { value: v }, label);
      if (v === value) o.selected = true;
      s.appendChild(o);
    }
    return s;
  }

  // "Name:rank, Other Name" -> tag objects (rank defaults to 100).
  function parseTags(str) {
    return String(str || '').split(',').map((s) => s.trim()).filter(Boolean).map((s, i) => {
      const mm = s.match(/^(.*?):(\d{1,3})$/);
      return {
        id: ID_BASE + i,
        name: mm ? mm[1].trim() : s,
        rank: mm ? parseInt(mm[2], 10) : 100,
        isMediaSpoiler: false, isGeneralSpoiler: false, isAdult: false,
        category: null, description: null, userId: null,
      };
    });
  }

  // Push the full media entity set (characters, tags, page entities…) so
  // open media pages update live after an edit.
  function pushRecEntities(rec) {
    const store = vueStore();
    if (!store) return;
    try { store.commit('setEntities', richMediaResult(rec).entities); }
    catch (err) { console.warn(TAG, 'content commit failed', err); }
  }

  /* --- shared UI builders (create modal + edit-page panel) --- */

  // Debounced multi-source search; onPick(result, {setStatus}) applies it.
  // Rows may carry hydrate(): an async fetch of the full record (sources
  // whose search results are thin), onPick callers await it before applying.
  function buildImportSearch(type, onPick) {
    let searchToken = 0;
    let importTimer = null;
    const results = el('div', { class: 'alce-import-results' });
    const statusEl = el('div', { class: 'alce-import-status' });
    const sources = type === 'ANIME' ? 'MAL' : 'MangaBaka · MangaDex · Dynasty · RanobeDB · MAL';
    const input = el('input', { type: 'text', spellcheck: 'false', placeholder: 'Title…' });
    const api = { setStatus: (t) => { statusEl.textContent = t; } };

    function importRow(r) {
      // Info line in the quick-search style: "2003 Manga · Kiyohiko Azuma".
      const sub = [[r.year, r.subtitle].filter(Boolean).join(' '),
        r.authors && r.authors.length ? r.authors.slice(0, 2).join(', ') : null]
        .filter(Boolean).join(' · ');
      const cover = el('div', { class: 'alce-import-cover' });
      // An <img> with no Referer, so thumbnails from hotlink-blocking or
      // decoy-serving hosts (Dynasty, MangaDex) still show the real picture.
      // referrerpolicy must be set before src, or the request may already be
      // in flight with the default policy.
      if (r.thumb) {
        cover.appendChild(el('img', {
          referrerpolicy: 'no-referrer', loading: 'lazy', alt: '',
          onerror: (e) => e.target.remove(),
          src: r.thumb,
        }));
      }
      return el('div', { class: 'alce-import-row', onclick: () => { results.textContent = ''; onPick(r, api); } },
        cover,
        el('div', { class: 'alce-import-text' },
          el('div', { class: 'alce-import-title', title: r.title }, r.title),
          el('div', { class: 'alce-import-sub' }, sub)),
        el('span', { class: 'alce-import-badge' }, r.provider),
      );
    }

    function runImportSearch() {
      const q = input.value.trim();
      if (q.length < 3) { results.textContent = ''; statusEl.textContent = ''; return; }
      const token = ++searchToken;
      statusEl.textContent = 'Searching…';
      results.textContent = '';
      const all = metaSearchJobs(q, type);
      const missing = all.filter((j) => j.gm && !gmXHR).map((j) => j.name);
      const jobs = all.filter((j) => !(j.gm && !gmXHR));
      let done = 0;
      if (missing.length) {
        results.appendChild(el('div', { class: 'alce-import-err' },
          `${missing.join(', ')}: unavailable: GM_xmlhttpRequest is missing (update the script so its new @grant header is applied)`));
      }
      for (const job of jobs) {
        job.run().then((rs) => {
          if (token !== searchToken) return;
          for (const r of rs) results.appendChild(importRow(r));
        }).catch((e) => {
          if (token !== searchToken) return;
          results.appendChild(el('div', { class: 'alce-import-err' }, `${job.name}: ${e.message}`));
        }).then(() => {
          if (token !== searchToken) return;
          done++;
          if (done === jobs.length) {
            statusEl.textContent = results.querySelector('.alce-import-row')
              ? 'Select an entry to import.' : 'No results.';
          }
        });
      }
    }
    input.addEventListener('input', () => {
      clearTimeout(importTimer);
      importTimer = setTimeout(runImportSearch, 450);
    });

    const root = el('div', { class: 'alce-import' }, field(type === 'ANIME' ? 'Search database' : 'Search databases', input), statusEl, results);
    return { root, setStatus: api.setStatus };
  }

  // MangaBaka volume/season cover art picker, paged 24 at a time.
  // onPick(url) receives the chosen full-size cover URL.
  function buildCoverPicker(onPick) {
    let series = null;
    let next = null;
    let loaded = false;
    let firstPage = null;
    const grid = el('div', { class: 'alce-cover-grid', style: 'display:none' });
    const lang = el('select', { class: 'alce-cover-lang', style: 'display:none' });
    const btn = el('button', {
      class: 'alce-cover-btn', style: 'display:none',
      onclick: (e) => { e.preventDefault(); toggle(); },
    }, 'Choose Cover…');
    const more = el('button', {
      class: 'alce-cover-btn', style: 'display:none',
      onclick: (e) => { e.preventDefault(); loadPage(); },
    }, 'Load More');
    lang.addEventListener('change', () => applyFilter());

    function setSeries(id) {
      series = id || null;
      next = null;
      loaded = false;
      firstPage = null;
      grid.textContent = '';
      grid.style.display = 'none';
      lang.textContent = '';
      lang.style.display = 'none';
      more.style.display = 'none';
      btn.style.display = series ? 'inline' : 'none';
      btn.textContent = 'Choose Cover…';
      if (!series) return;
      // Prefetch the first page and warm its thumbnails so the grid is
      // instant by the time "Choose Cover…" is clicked. Thumb latency is
      // almost all server TTFB, so warming in parallel hides it.
      const p = metaFetchJson(`https://api.mangabaka.org/v1/series/${series}/images`);
      firstPage = p;
      p.then((j) => {
        for (const it of j.data || []) {
          const u = it.image && it.image.x150 && it.image.x150.x1;
          if (u) { const im = new Image(); im.src = u; }
        }
      }).catch(() => { if (firstPage === p) firstPage = null; });
    }

    function applyFilter() {
      const v = lang.value;
      for (const cell of grid.querySelectorAll('.alce-cover-cell')) {
        cell.style.display = (!v || v === 'all' || cell.dataset.lang === v) ? '' : 'none';
      }
    }

    async function loadPage() {
      const url = next || `https://api.mangabaka.org/v1/series/${series}/images`;
      more.style.display = 'none';
      btn.textContent = 'Loading covers…';
      try {
        const first = !next && firstPage;
        if (first) firstPage = null;
        const j = await (first || metaFetchJson(url));
        btn.textContent = 'Choose Cover…';
        for (const it of (j.data || []).filter((x) => x.image && x.image.raw && x.image.raw.url)) {
          const label = `${it.type === 'season' ? 'S' : 'Vol'} ${it.index || '?'} · ${String(it.language || '?').toUpperCase()}`;
          const im = el('img', {
            onload: () => im.classList.add('ld'),
            decoding: 'async',
            src: (it.image.x150 && it.image.x150.x1) || it.image.raw.url,
          });
          if (im.complete) im.classList.add('ld');
          const thumb = el('div', { class: 'alce-cover-thumb' });
          const ph = blurhashCanvas(it.image.raw.blurhash, 18, 26);
          if (ph) thumb.appendChild(ph);
          thumb.appendChild(im);
          const cell = el('div', {
            class: 'alce-cover-cell',
            title: label,
            onclick: () => {
              onPick(it.image.raw.url);
              for (const c of grid.querySelectorAll('.alce-cover-cell.sel')) c.classList.remove('sel');
              cell.classList.add('sel');
            },
          },
          thumb,
          el('span', {}, label));
          cell.dataset.lang = it.language || '?';
          grid.appendChild(cell);
        }
        grid.appendChild(more); // keep the pager at the end
        const langs = j.available_languages || [];
        if (langs.length > 1 && !lang.childElementCount) {
          lang.appendChild(el('option', { value: 'all' }, 'All languages'));
          for (const l of langs) lang.appendChild(el('option', { value: l }, String(l).toUpperCase()));
          if (grid.style.display !== 'none') lang.style.display = '';
        }
        next = (j.pagination && j.pagination.next) || null;
        if (next) {
          const total = (j.pagination && j.pagination.count) || 0;
          const shown = grid.querySelectorAll('.alce-cover-cell').length;
          more.textContent = `Load More (${total - shown} more)`;
          more.style.display = '';
        }
        applyFilter();
      } catch (e) {
        btn.textContent = `Covers failed: ${e.message}`;
      }
    }

    function toggle() {
      if (!series) return;
      const hidden = grid.style.display === 'none';
      grid.style.display = hidden ? '' : 'none';
      lang.style.display = hidden && lang.childElementCount ? '' : 'none';
      if (hidden && !loaded) { loaded = true; loadPage(); }
    }

    return { root: el('div', { class: 'alce-covers' }, btn, lang, grid), setSeries };
  }

  /* ------------------------------------------------------------------ *
   * Custom tools panel on the native submission editor (/edit/<type>/<id>):
   * metadata import, cover picker, and the fields the native form has no
   * local handling for (tags, studio).
   * ------------------------------------------------------------------ */

  // Mirror values into the open submission form so the user sees them.
  function commitSubmissionMedia(patch) {
    const store = vueStore();
    if (!store || !store.state.mediaSubmission || !store.state.mediaSubmission.media) return false;
    try {
      for (const [k, v] of Object.entries(patch)) {
        store.commit('mediaSubmission/updateMedia', { key: k, value: v });
      }
      return true;
    } catch (e) {
      console.warn(TAG, 'submission commit failed', e);
      return false;
    }
  }

  function importCommitPatch(rec) {
    const md = rec.media;
    return {
      title: { romaji: md.title.romaji || null, english: md.title.english || null, native: md.title.native || null },
      status: md.status,
      format: md.format,
      episodes: md.episodes,
      chapters: md.chapters,
      volumes: md.volumes,
      description: md.description,
      genres: (md.genres || []).slice(),
      synonyms: (md.synonyms || []).slice(),
      coverImage: { extraLarge: md.coverImage.extraLarge, large: md.coverImage.large, color: null },
      bannerImage: md.bannerImage || null,
      startDate: Object.assign({}, md.startDate),
    };
  }

  // Apply an import pick straight to the record (the edit page saves
  // immediately; the form is just a preview that can refine afterwards).
  function applyImportToRec(rec, r) {
    const md = rec.media;
    const t = r.title;
    md.title = { userPreferred: t, romaji: t, english: t, native: t };
    if (FORMAT_OPTS[rec.type].includes(r.format)) md.format = r.format;
    md.status = r.mediaStatus;
    if (rec.type === 'ANIME') {
      if (r.episodes) md.episodes = r.episodes;
    } else {
      if (r.chapters) md.chapters = r.chapters;
      if (r.volumes) md.volumes = r.volumes;
    }
    if (r.cover) setCover(md, r.cover, r.cover);
    if (r.description) md.description = r.description;
    if (r.genres && r.genres.length) md.genres = r.genres.slice();
    if (r.tags && r.tags.length) md.tags = parseTags(r.tags.join(', '));
    if (rec.type === 'ANIME' && r.studio) md.studioName = r.studio;
    md.synonyms = r.synonyms || [];
    if (r.year && !(md.startDate && md.startDate.year)) {
      md.startDate = { year: r.year, month: null, day: null };
    }
    if (r.isAdult !== undefined) md.isAdult = !!r.isAdult;
    rec.external = Object.assign({}, rec.external, r.external);
    touchRec(rec);
    saveDB();
  }

  // MangaBaka relationship buckets -> AniList relation types, plus the
  // reciprocal type written onto custom targets so links go both ways.
  const MB_REL_TYPES = {
    prequel: 'PREQUEL', sequel: 'SEQUEL', side_story: 'SIDE_STORY',
    spin_off: 'SPIN_OFF', main_story: 'PARENT', alternative: 'ALTERNATIVE',
    adaptation: 'ADAPTATION', adapted_from: 'SOURCE', parody: 'OTHER', other: 'OTHER',
  };
  // Derivative works point back at their main series with PARENT (AniList
  // convention, e.g. a special's page labels the main series "Parent" while
  // the main series labels the special "Other"/"Side Story").
  const INVERSE_REL = {
    SEQUEL: 'PREQUEL', PREQUEL: 'SEQUEL', SIDE_STORY: 'PARENT', SPIN_OFF: 'PARENT',
    PARENT: 'SIDE_STORY', ALTERNATIVE: 'ALTERNATIVE', ADAPTATION: 'SOURCE',
    SOURCE: 'ADAPTATION', OTHER: 'PARENT', CHARACTER: 'CHARACTER', SUMMARY: 'PARENT',
    COMPILATION: 'CONTAINS', CONTAINS: 'COMPILATION', SAME_UNIVERSE: 'SAME_UNIVERSE',
  };
  const REL_LABELS = {
    PREQUEL: 'Prequel', SEQUEL: 'Sequel', SIDE_STORY: 'Side Story', SPIN_OFF: 'Spin-Off',
    PARENT: 'Parent', ALTERNATIVE: 'Alternative', ADAPTATION: 'Adaptation',
    SOURCE: 'Source', OTHER: 'Other', CHARACTER: 'Character', SUMMARY: 'Summary',
    COMPILATION: 'Compilation', CONTAINS: 'Contains', SAME_UNIVERSE: 'Same Universe',
  };

  function buildEditPanel(rec) {
    const anime = rec.type === 'ANIME';
    const md = rec.media;

    // Quick edit: the common fields in one place (the native form below has
    // the long tail: per-language titles, dates, synonyms, characters…).
    const title = el('input', { type: 'text' });
    const format = select(FORMAT_OPTS[rec.type].map((f) => [f, FMT_LABEL[f] || f]), md.format);
    const mediaStatus = select(MEDIA_STATUS_OPTS, md.status);
    const eps = el('input', { type: 'number', min: '0', placeholder: 'unknown' });
    const vols = el('input', { type: 'number', min: '0', placeholder: 'unknown' });
    const cover = el('input', { type: 'text', placeholder: 'https://…' });
    const banner = el('input', { type: 'text', placeholder: 'https://… (optional)' });
    const description = el('textarea', { placeholder: 'Synopsis… (basic HTML like <br> and <i> works)' });
    const genres = el('input', { type: 'text', placeholder: 'Action, Comedy, …' });
    const tagsIn = el('input', { type: 'text', placeholder: 'Iyashikei:94, Female Protagonist' });
    const studioIn = el('input', { type: 'text', placeholder: 'e.g. Studio Ghibli' });

    // Embedded (data:) images are tens of KB of base64; show a marker in the
    // URL field instead and keep the stored image unless a new URL is typed.
    const EMBEDDED = '[embedded image, paste a URL to replace]';
    const showImg = (u) => (isDataUrl(u) ? EMBEDDED : (u || ''));
    const fillFromRec = () => {
      title.value = md.title.userPreferred || '';
      format.value = md.format || (anime ? 'TV' : 'MANGA');
      mediaStatus.value = md.status || 'FINISHED';
      eps.value = (anime ? md.episodes : md.chapters) || '';
      vols.value = (!anime && md.volumes) || '';
      cover.value = showImg((md.coverImage.large !== DEFAULT_COVER && md.coverImage.large) || '');
      banner.value = showImg(md.bannerImage || '');
      cover.title = md.coverSource ? 'Source: ' + md.coverSource : '';
      banner.title = md.bannerSource ? 'Source: ' + md.bannerSource : '';
      description.value = md.description || '';
      genres.value = (md.genres || []).join(', ');
      tagsIn.value = (md.tags || []).map((t) => `${t.name}:${t.rank}`).join(', ');
      studioIn.value = md.studioName || '';
    };
    fillFromRec();

    const saveQuick = async (e) => {
      const btn = e && e.currentTarget;
      if (btn) { if (btn.disabled) return; btn.disabled = true; }
      nudgeCanvasPermission();
      try {
        const cv = cover.value.trim();
        const bv = banner.value.trim();
        const [c, b] = await Promise.all([
          cv === EMBEDDED ? md.coverImage.large : embedIfHotlinkBlocked(cv || DEFAULT_COVER, 'cover'),
          bv === EMBEDDED ? md.bannerImage : embedIfHotlinkBlocked(bv || null, 'banner'),
        ]);
        const t = title.value.trim() || md.title.userPreferred;
        md.title = { userPreferred: t, romaji: t, english: t, native: t };
        md.format = format.value;
        md.status = mediaStatus.value;
        if (anime) md.episodes = intOrNull(eps.value);
        else { md.chapters = intOrNull(eps.value); md.volumes = intOrNull(vols.value); }
        const cc = c || DEFAULT_COVER;
        setCover(md, cc, cv === EMBEDDED ? null : cv);
        setBanner(md, b || null, bv === EMBEDDED ? null : bv);
        md.description = description.value.trim() || null;
        md.genres = genres.value.split(',').map((s) => s.trim()).filter(Boolean);
        md.tags = parseTags(tagsIn.value);
        if (anime) md.studioName = studioIn.value.trim() || null;
        logRevision(rec, 'EDIT', { title: revisionValue(md.title.userPreferred), format: revisionValue(md.format), status: revisionValue(md.status), description: 'Modified', genres: 'Modified', tags: 'Modified' });
        touchRec(rec);
        saveDB();
        commitSubmissionMedia(importCommitPatch(rec));
        pushRecEntities(rec);
        syncSections(rec);
        fillFromRec();
        toast('Custom entry saved');
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    // "Embed" next to the image fields: force-embed the URL in the field
    // (even from hosts that hotlink fine), or, when the field is empty /
    // shows the embedded marker, re-embed from the remembered source URL -
    // e.g. after granting canvas access, or to bring an embed back after
    // the field was cleared.
    const embedNow = async (kind, input, e) => {
      const btn = e && e.currentTarget;
      if (btn && btn.disabled) return;
      nudgeCanvasPermission();
      const typed = input.value.trim();
      const source = typed && typed !== EMBEDDED ? typed
        : (kind === 'cover' ? md.coverSource : md.bannerSource);
      if (!isHttpUrl(source)) { toast('No image URL to embed, paste one first', true); return; }
      if (btn) { btn.disabled = true; btn.textContent = imgHostConfigured() ? 'Uploading…' : 'Embedding…'; }
      try {
        const data = await embedImage(source, kind, { force: true });
        if (!isDataUrl(data)) return; // failure already toasted
        if (kind === 'cover') setCover(md, data, source); else setBanner(md, data, source);
        touchRec(rec);
        saveDB();
        commitSubmissionMedia(kind === 'cover'
          ? { coverImage: { extraLarge: data, large: data, color: null } }
          : { bannerImage: data });
        pushRecEntities(rec);
        syncSections(rec);
        fillFromRec();
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = embedLabel(); }
      }
    };
    const embedLabel = () => (imgHostConfigured() ? 'Upload' : 'Embed');
    const embedBtn = (kind, input) => el('button', {
      class: 'alce-embed-btn',
      title: imgHostConfigured()
        ? 'Upload this image to your image host and store its URL (re-uploads from the remembered source when the field is empty)'
        : 'Store this image inside the entry as a data: URI (re-embeds from the remembered source when the field is empty)',
      onclick: (e) => { e.preventDefault(); embedNow(kind, input, e); },
    }, embedLabel());
    const imgField = (label, input, kind) => el('div', { class: 'alce-field alce-img-field' },
      el('label', {}, label),
      el('div', { class: 'alce-img-field-row' }, input, embedBtn(kind, input)));

    const covers = buildCoverPicker((picked) => {
      embedIfHotlinkBlocked(picked, 'cover').then((url) => {
        cover.value = showImg(url);
        setCover(rec.media, url, picked);
        touchRec(rec);
        saveDB();
        commitSubmissionMedia({ coverImage: { extraLarge: url, large: url, color: null } });
        pushRecEntities(rec);
        toast('Cover saved');
      });
    });
    covers.setSeries(rec.external && rec.external.mangabaka);

    const search = buildImportSearch(rec.type, async (r, ui) => {
      if (r.hydrate) {
        ui.setStatus(`Fetching details from ${r.provider}…`);
        try { r = await r.hydrate(); } catch (e) { ui.setStatus(`${r.provider}: ${e.message}`); return; }
      }
      applyImportToRec(rec, r);
      await embedRecImages(rec);
      fillFromRec();
      commitSubmissionMedia(importCommitPatch(rec));
      covers.setSeries(rec.external && rec.external.mangabaka);
      pushRecEntities(rec);
      const base = `Imported "${r.title}" from ${r.provider} and saved.`;
      if (!r.malId) { ui.setStatus(base); return; }
      ui.setStatus(base + ' Fetching characters (MAL)…');
      try {
        const chars = await fetchJikanCharacters(r.malId, rec.type);
        if (chars.length) {
          rec.characters = chars.map((c) => ({
            id: ID_BASE + (++db.seq), name: c.name, role: c.role, image: c.image,
          }));
          touchRec(rec);
          saveDB();
          pushRecEntities(rec);
        }
        ui.setStatus(base + (chars.length
          ? ` ${chars.length} characters saved. Reload to see them in the Characters section.`
          : ' No characters on MAL.'));
      } catch (e) {
        ui.setStatus(base + ` Characters failed: ${e.message}`);
      }
    });

    // --- airing schedule (anime): AniList's own form only shows this
    // section to mods, so the panel generates one locally (first episode's
    // date/time, interval, count) into media.airingSchedule. ---
    const schedList = el('div');
    const schedAt = el('input', { type: 'datetime-local' });
    const schedEvery = el('input', { type: 'number', min: '1', value: '7' });
    const schedCount = el('input', { type: 'number', min: '1', value: String(rec.media.episodes || 12) });
    const schedStart = el('input', { type: 'number', min: '1', value: '1' });
    const fmtAir = (t) => new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const renderSched = () => {
      schedList.textContent = '';
      const items = airingScheduleOf(rec);
      const now = nowSec();
      for (const a of items) {
        schedList.appendChild(el('div', { class: 'alce-item-row' },
          el('div', { class: 'alce-item-text' },
            el('div', { class: 'alce-item-title' }, `Episode ${a.episode}`),
            el('div', { class: 'alce-item-sub' }, fmtAir(a.airingAt) + (a.airingAt <= now ? ' · aired' : ''))),
          el('button', { class: 'alce-item-del', title: 'Remove', onclick: () => { handleSaveAiringSchedule(rec, { airingSchedule: items.filter((x) => x !== a) }); renderSched(); } }, svgIcon(ICON_TRASH)),
        ));
      }
      if (!items.length) schedList.appendChild(el('div', { class: 'alce-sync-status' }, 'None. Generate one below: the entry page and home cards then show the next episode\'s countdown, and aired episodes show up in your notifications.'));
      if (items.length) {
        const first = items[0];
        const d = new Date(first.airingAt * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        schedAt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        schedStart.value = String(first.episode);
        schedCount.value = String(items.length);
        if (items.length > 1) schedEvery.value = String(Math.max(1, Math.round((items[1].airingAt - first.airingAt) / 86400)));
      }
    };
    const generateSched = () => {
      const t0 = schedAt.value ? Math.floor(new Date(schedAt.value).getTime() / 1000) : NaN;
      const every = parseInt(schedEvery.value, 10);
      const count = parseInt(schedCount.value, 10);
      const start = parseInt(schedStart.value, 10) || 1;
      if (!Number.isFinite(t0)) { toast('Set the first episode\'s air date and time', true); schedAt.focus(); return; }
      if (!(every > 0) || !(count > 0) || count > 500) { toast('Check the interval and episode count', true); return; }
      const items = [];
      for (let i = 0; i < count; i++) items.push({ airingAt: t0 + i * every * 86400, episode: start + i });
      handleSaveAiringSchedule(rec, { airingSchedule: items });
      renderSched();
      toast(`Airing schedule saved: ${count} episode${count === 1 ? '' : 's'}`);
    };
    if (anime) renderSched();
    const schedBlock = anime ? [
      el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'Airing Schedule'),
      schedList,
      el('div', { class: 'alce-row' },
        field('First episode airs', schedAt),
        field('Every (days)', schedEvery),
        field('Episodes', schedCount),
        field('Starting at episode', schedStart)),
      el('div', { class: 'alce-panel-btns' },
        el('button', { class: 'blue', onclick: generateSched }, 'Generate'),
        el('button', { onclick: () => { if (!airingScheduleOf(rec).length) return; handleSaveAiringSchedule(rec, { airingSchedule: [] }); renderSched(); toast('Airing schedule cleared'); } }, 'Clear'),
      ),
    ] : [];

    // --- recommendations manager ---
    const itemRow = (media, fallbackName, sub, onRemove) => {
      const cover = el('div', { class: 'alce-item-cover' });
      const cu = media && media.coverImage && (media.coverImage.medium || media.coverImage.large);
      if (cu && cu !== DEFAULT_COVER) cover.style.backgroundImage = 'url("' + String(cu).replace(/"/g, '') + '")';
      return el('div', { class: 'alce-item-row' },
        cover,
        el('div', { class: 'alce-item-text' },
          el('div', { class: 'alce-item-title' }, (media && media.title && media.title.userPreferred) || fallbackName),
          el('div', { class: 'alce-item-sub' }, sub)),
        el('button', { class: 'alce-item-del', title: 'Remove', onclick: onRemove }, svgIcon(ICON_TRASH)),
      );
    };

    const recList = el('div');
    const renderRecs = () => {
      recList.textContent = '';
      for (const rr of rec.recs || []) {
        const target = isCustomId(rr.target) ? recById(rr.target) : null;
        recList.appendChild(itemRow(
          target ? target.media : rr.media,
          '#' + rr.target,
          target ? 'Custom entry' : 'AniList entry',
          () => {
            rec.recs = (rec.recs || []).filter((x) => x !== rr);
            touchRec(rec);
            saveDB();
            pushRecEntities(rec);
            renderRecs();
          },
        ));
      }
      if (!(rec.recs || []).length) {
        recList.appendChild(el('div', { class: 'alce-sync-status' },
          'None yet. Use Add Recommendation on the entry page; other custom entries show up in its search.'));
      }
    };
    renderRecs();

    // Auto-grab from MangaBaka's similar-series data (entries that link to a
    // real AniList id become native recommendation cards).
    // Both fetchers share one re-entrancy guard: a second click while a run
    // is in flight would interleave two loops racing the same dedup checks.
    let mbBusy = false;

    const recsBtn = el('button', { onclick: () => fetchMbRecs() }, 'Fetch From MangaBaka');
    const relsBtn = el('button', { onclick: () => fetchMbRels() }, 'Fetch Relations From MangaBaka');

    const fetchMbRecs = async () => {
      if (mbBusy) return;
      mbBusy = true;
      recsBtn.textContent = 'Fetching…';
      try {
        const j = await metaFetchJson(`https://api.mangabaka.org/v1/series/${rec.external.mangabaka}/similar`);
        rec.recs = rec.recs || [];
        let added = 0;
        const showAdult = viewerShowsAdult();
        for (const it of (j.data || [])) {
          const s = it.series;
          const alId = s && s.source && s.source.anilist && s.source.anilist.id;
          if (!alId || alId === rec.id || rec.recs.some((x) => x.target === alId)) continue;
          if (mbIsAdult(s) && !showAdult) continue;
          const cov = (s.cover && s.cover.raw && s.cover.raw.url) || null;
          db.seq += 1;
          rec.recs.push({
            id: ID_BASE + db.seq,
            target: alId,
            rating: 1,
            userRating: 'RATE_UP',
            media: {
              id: alId,
              title: { userPreferred: s.title },
              type: rec.type,
              format: s.type === 'novel' || s.type === 'light_novel' ? 'NOVEL'
                : (s.type === 'one_shot' ? 'ONE_SHOT' : 'MANGA'),
              status: META_STATUS_MB[s.status] || null,
              bannerImage: null,
              coverImage: { large: cov, medium: cov },
              isAdult: mbIsAdult(s),
            },
          });
          added++;
          if (added >= 10) break;
        }
        touchRec(rec);
        saveDB();
        pushRecEntities(rec);
        renderRecs();
        if (added) toast(`Added ${added} recommendations from MangaBaka`);
        else toast('No new recommendations found on MangaBaka', true);
      } catch (e) {
        toast(`MangaBaka similar failed: ${e.message}`, true);
      } finally {
        mbBusy = false;
        recsBtn.textContent = 'Fetch From MangaBaka';
      }
    };

    // --- relations manager ---
    const relList = el('div');
    const renderRels = () => {
      relList.textContent = '';
      for (const rl of rec.relations || []) {
        const target = isCustomId(rl.target) ? recById(rl.target) : null;
        relList.appendChild(itemRow(
          target ? target.media : rl.media,
          '#' + rl.target,
          (REL_LABELS[rl.type] || rl.type) + (target ? ' · Custom entry' : ' · AniList entry'),
          () => {
            rec.relations = (rec.relations || []).filter((x) => x !== rl);
            dropReciprocalRelation(rec, rl);
            logRevision(rec, 'EDIT', { relations: 'Modified' });
            touchRec(rec);
            saveDB();
            pushRecEntities(rec);
            renderRels();
          },
        ));
      }
      if (!(rec.relations || []).length) {
        relList.appendChild(el('div', { class: 'alce-sync-status' },
          'None yet. Add Relation in the form\'s Relations section below (Submit to save), or Fetch From MangaBaka, which links sequels/prequels/side stories: to another custom entry when one matches, to the real AniList entry when it exists, and otherwise creates a custom entry from the MangaBaka data.'));
      }
    };
    renderRels();

    // --- staff + external links managers: the native form adds them (its
    // Staff / External Links sections, Submit to save) but only shows a
    // delete control to data mods, so removal lives here. ---
    const staffList = el('div');
    const renderStaff = () => {
      staffList.textContent = '';
      for (const st of rec.staff || []) {
        const name = staffNameOf(st).userPreferred;
        staffList.appendChild(itemRow(
          { title: { userPreferred: name }, coverImage: { medium: st.image || null } },
          name,
          (st.role || 'No role') + (st.isCustom ? ' · Local staff' : ' · AniList staff'),
          () => {
            rec.staff = (rec.staff || []).filter((x) => x !== st);
            touchRec(rec);
            saveDB();
            pushRecEntities(rec);
            renderStaff();
          },
        ));
      }
      if (!(rec.staff || []).length) {
        staffList.appendChild(el('div', { class: 'alce-sync-status' },
          'None yet. Use Add Staff / Create New Staff in the form\'s Staff section below, then Submit.'));
      }
    };
    renderStaff();

    const charList = el('div');
    const renderChars = () => {
      charList.textContent = '';
      for (const c of rec.characters || []) {
        charList.appendChild(itemRow(
          { title: { userPreferred: c.name || 'Unnamed' }, coverImage: { medium: c.image || null } },
          c.name || 'Unnamed',
          (c.role || 'MAIN') + (isCustomId(c.id) ? ' · Local character' : ' · AniList character'),
          () => {
            rec.characters = (rec.characters || []).filter((x) => x !== c);
            logRevision(rec, 'EDIT', { characters: 'Modified' });
            touchRec(rec);
            saveDB();
            pushRecEntities(rec);
            renderChars();
          },
        ));
      }
      if (!(rec.characters || []).length) {
        charList.appendChild(el('div', { class: 'alce-sync-status' },
          'None yet. Use Add Characters / Create New Character in the form\'s Characters section below, then Submit.'));
      }
    };
    renderChars();

    const studioList = el('div');
    const renderStudios = () => {
      studioList.textContent = '';
      for (const st of studiosOf(rec)) {
        studioList.appendChild(itemRow(null, st.name || 'Studio #' + st.studioId,
          (st.isMain ? 'Main studio' : 'Studio') + (st.isCustom ? ' · Local studio' : ' · AniList studio'),
          () => { removeStudioLink(rec, st.id); renderStudios(); fillFromRec(); }));
      }
      if (!studiosOf(rec).length) {
        studioList.appendChild(el('div', { class: 'alce-sync-status' },
          'None yet. Type a studio in the Studio field above, or use Add Studios in the form\'s Studios section below, then Submit.'));
      }
    };
    renderStudios();

    const linkList = el('div');
    const renderLinks = () => {
      linkList.textContent = '';
      for (const l of md.externalLinks || []) {
        linkList.appendChild(itemRow(null, l.site || 'Link', l.url + (l.notes ? ' · ' + l.notes : ''), () => {
          md.externalLinks = (md.externalLinks || []).filter((x) => x !== l);
          touchRec(rec);
          saveDB();
          pushRecEntities(rec);
          renderLinks();
        }));
      }
      if (!(md.externalLinks || []).length) {
        linkList.appendChild(el('div', { class: 'alce-sync-status' },
          'None yet. Use Add Link in the form\'s External Links section below, then Submit.'));
      }
    };
    renderLinks();

    const fetchMbRels = async () => {
      if (mbBusy) return;
      mbBusy = true;
      relsBtn.textContent = 'Fetching…';
      try {
        const j = await metaFetchJson(`https://api.mangabaka.org/v1/series/${rec.external.mangabaka}`);
        rec.relations = rec.relations || [];
        // relationships_v2 is a superset of the v1 buckets (it also carries
        // parody edges, i.e. most doujinshi); fall back to v1 when absent.
        const v2 = (j.data && j.data.relationships_v2) || [];
        const jobs = [];
        if (v2.length) {
          for (const r of v2) {
            if (r && r.to_series_id) jobs.push({ mbId: r.to_series_id, type: MB_REL_TYPES[r.relation_type] || 'OTHER', raw: r.relation_type });
          }
        } else {
          const buckets = (j.data && j.data.relationships) || {};
          for (const [mbType, ids] of Object.entries(buckets)) {
            const type = MB_REL_TYPES[mbType] || 'OTHER';
            for (const mbId of ids || []) jobs.push({ mbId, type, raw: mbType });
          }
        }
        // The array is not ordered by importance, so sort story-relevant
        // types ahead of parody doujins before applying the cap (stable
        // sort keeps MangaBaka's order within each type).
        const RELS_FIRST = ['sequel', 'prequel', 'main_story', 'side_story', 'spin_off',
          'alternative', 'adaptation', 'adapted_from', 'other', 'parody'];
        const prio = (raw) => { const i = RELS_FIRST.indexOf(raw); return i === -1 ? RELS_FIRST.length : i; };
        jobs.sort((a, b) => prio(a.raw) - prio(b.raw));
        // Cursor, not a cap: edges remember their MangaBaka id, so each run
        // fetches only unprocessed relations, one batch at a time. Franchise
        // monsters with dozens of relations just take a few clicks.
        const known = new Set((rec.relations || []).map((x) => x.mb).filter(Boolean));
        const pending = jobs.filter((job) => !known.has(job.mbId));
        const batch = pending.slice(0, 25);
        const showAdult = viewerShowsAdult();
        let added = 0;
        let created = 0;
        let skippedAdult = 0;
        let failed = 0;
        for (const job of batch) {
          let target = null;
          let stub = null;
          let targetRec = allRecs().find((x) => x.external && x.external.mangabaka === job.mbId);
          if (targetRec) {
            if (targetRec.media.isAdult && !showAdult) { skippedAdult++; continue; }
            target = targetRec.id;
          } else {
            let dj;
            // One related series failing to load must not abort the rest.
            try { dj = await metaFetchJson(`https://api.mangabaka.org/v1/series/${job.mbId}`); }
            catch (e) { failed++; continue; }
            const s = dj.data;
            if (!s || s.state === 'merged') continue;
            if (mbIsAdult(s) && !showAdult) { skippedAdult++; continue; }
            const alId = s.source && s.source.anilist && s.source.anilist.id;
            if (alId) {
              target = alId;
              const norm = mbNormalize(s);
              stub = {
                id: alId,
                title: { userPreferred: s.title },
                type: 'MANGA',
                format: norm.format,
                status: norm.mediaStatus,
                bannerImage: null,
                coverImage: { large: norm.cover, medium: norm.thumb || norm.cover },
                isAdult: norm.isAdult,
              };
            } else {
              // Not on AniList: create a custom entry from the MangaBaka
              // data. status null = media-only record, on no list until the
              // user adds it from its page (like any related media).
              const r = mbNormalize(s);
              const nr = createRec({
                ownerId: rec.ownerId, type: 'MANGA',
                title: r.title, format: r.format, mediaStatus: r.mediaStatus,
                status: null, episodes: null,
                chapters: r.chapters, volumes: r.volumes,
                cover: r.cover || DEFAULT_COVER, banner: null,
              });
              applyImportToRec(nr, r);
              embedRecImages(nr).catch(() => {});
              target = nr.id;
              targetRec = nr;
              created++;
            }
          }
          if (target === rec.id) continue;
          const dup = rec.relations.find((x) => x.target === target);
          if (dup) {
            if (!dup.mb) dup.mb = job.mbId; // backfill pre-cursor edges
            continue;
          }
          db.seq += 1;
          rec.relations.push({ id: ID_BASE + db.seq, type: job.type, target, media: stub, mb: job.mbId });
          if (targetRec) { // custom target: write the reciprocal edge
            targetRec.relations = targetRec.relations || [];
            if (!targetRec.relations.some((x) => x.target === rec.id)) {
              db.seq += 1;
              targetRec.relations.push({
                id: ID_BASE + db.seq, type: INVERSE_REL[job.type] || 'OTHER', target: rec.id, media: null,
              });
              touchRec(targetRec);
            }
          }
          added++;
        }
        // MangaBaka's type field is coarser than AniList's (one-shots are
        // plain "manga" there), so for targets that exist on AniList fetch
        // the authoritative format/status/cover in one clean query.
        // Progressive like the batch loop: only edges not yet enriched, at
        // most one page per run, so huge sets converge across clicks.
        const realIds = rec.relations
          .filter((x) => !isCustomId(x.target) && !(x.media && x.media.format))
          .map((x) => x.target)
          .slice(0, 50);
        if (realIds.length) {
          try {
            const resp = await nativeFetch('/graphql', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: 'query($ids:[Int]){Page(perPage:50){media(id_in:$ids){id type format status(version:2)title{userPreferred}coverImage{large medium}bannerImage isAdult}}}',
                variables: { ids: realIds },
              }),
            }).then((r) => r.json());
            for (const m of (resp.data && resp.data.Page && resp.data.Page.media) || []) {
              const rl = rec.relations.find((x) => x.target === m.id);
              if (rl) rl.media = m;
            }
          } catch (e) { /* stubs stay MangaBaka-based */ }
        }
        touchRec(rec);
        saveDB();
        pushRecEntities(rec);
        renderRels();
        const adultNote = skippedAdult
          ? ` Skipped ${skippedAdult} adult relation${skippedAdult === 1 ? '' : 's'} (18+ is disabled in your AniList settings).`
          : '';
        const failNote = failed ? ` ${failed} failed to load; run again to retry.` : '';
        const leftover = pending.length - batch.length;
        const moreNote = leftover ? ` ${leftover} more to process; run again for the next batch.` : '';
        if (added) toast(`Added ${added} relations${created ? ` (created ${created} new custom entr${created === 1 ? 'y' : 'ies'})` : ''}.` + adultNote + failNote + moreNote);
        else toast('No new relations found on MangaBaka.' + adultNote + failNote + moreNote, !!(failed || skippedAdult));
      } catch (e) {
        toast(`MangaBaka relations failed: ${e.message}`, true);
      } finally {
        mbBusy = false;
        relsBtn.textContent = 'Fetch Relations From MangaBaka';
      }
    };

    return el('div', { class: 'alce-edit-panel' },
      el('h2', {}, 'Custom Entry Tools'),
      el('div', { class: 'alce-edit-panel-card' },
        search.root,
        field('Title', title),
        el('div', { class: 'alce-row' },
          field('Format', format),
          field('Release Status', mediaStatus),
          field(anime ? 'Episodes' : 'Chapters', eps),
          ...(anime ? [] : [field('Volumes', vols)])),
        imgField('Cover Image URL', cover, 'cover'),
        covers.root,
        imgField('Banner Image URL', banner, 'banner'),
        field('Description', description),
        el('div', { class: 'alce-row' },
          field('Genres', genres),
          field('Tags (name:rank)', tagsIn),
          ...(anime ? [field('Studio', studioIn)] : [])),
        el('div', { class: 'alce-panel-btns' },
          el('button', { class: 'blue', onclick: saveQuick }, 'Save'),
        ),
        ...schedBlock,
        el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'Recommendations'),
        recList,
        ...(rec.external && rec.external.mangabaka ? [el('div', { class: 'alce-panel-btns' }, recsBtn)] : []),
        el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'Relations'),
        relList,
        ...(rec.external && rec.external.mangabaka ? [el('div', { class: 'alce-panel-btns' }, relsBtn)] : []),
        el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'Characters'),
        charList,
        el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'Staff'),
        staffList,
        ...(anime ? [el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'Studios'), studioList] : []),
        el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'External Links'),
        linkList,
      ));
  }

  // Keep the tools panel mounted above the native submission form while a
  // custom entry's edit page is open (the form renders asynchronously).
  // Shown only on the General section; the sidebar nav marks the current
  // section with span.active.
  function panelBelongsOnScreen(panel) {
    const active = document.querySelector('.page-group span.active');
    const display = (!active || active.textContent.trim() === 'General') ? '' : 'none';
    if (panel.style.display === display) return;
    panel.style.display = display;
    // The form's Characters / Staff lists render through an in-view scroll
    // loader that only re-checks on scroll/resize; hiding the tall panel
    // moves their sentinel into view without either, so nudge it.
    requestAnimationFrame(() => { try { window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ } });
  }
  // Sidebar section clicks: re-evaluate right away instead of on the next
  // 600 ms tick (the section mounts, and checks its viewport, immediately).
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.page-group')) return;
    setTimeout(() => { const panel = document.querySelector('.alce-edit-panel'); if (panel) panelBelongsOnScreen(panel); }, 0);
    setTimeout(() => { try { window.dispatchEvent(new Event('scroll')); } catch (err) { /* ignore */ } }, 250);
  }, true);

  // The native relation dropdown lacks PARENT (the site derives it server-
  // side); custom ↔ custom reciprocals use it, so offer it on custom entries.
  function ensureRelationOptions() {
    for (const node of document.querySelectorAll('.relation-row')) {
      const vm = node.__vue__;
      const opts = vm && vm.$data && vm.$data.relationOptions;
      if (Array.isArray(opts) && !opts.includes('PARENT')) opts.push('PARENT');
    }
  }

  function ensureEditPanel() {
    const rec = editPageRec();
    const existing = document.querySelector('.alce-edit-panel');
    if (!rec) {
      if (existing) existing.remove();
      return;
    }
    try { ensureRelationOptions(); } catch (e) { /* best effort */ }
    if (existing) {
      if (existing.dataset.recId === String(rec.id)) {
        panelBelongsOnScreen(existing);
        return;
      }
      existing.remove();
    }
    const anchor = Array.from(document.querySelectorAll('.page-content h2'))
      .find((h) => /submission sources/i.test(h.textContent || ''));
    if (!anchor || !anchor.parentElement) return; // form not rendered yet
    const panel = buildEditPanel(rec);
    panel.dataset.recId = String(rec.id);
    anchor.parentElement.insertBefore(panel, anchor);
    panelBelongsOnScreen(panel);
  }

  // Create a new custom entry. Media details are edited afterwards on the
  // native submission editor (/edit/<type>/<id>); list fields (score, notes,
  // progress) via the native list editor that opens on Create.
  function openModal() {
    const route = routeInfo();
    const type = route ? route.type : 'ANIME';
    const anime = type === 'ANIME';
    const owner = currentOwner();
    if (!owner) {
      alertBox('Open your anime or manga list once so the script can learn your user id, then try again.');
      return;
    }

    const title = el('input', { type: 'text', placeholder: 'e.g. My Backlog OVA' });
    const format = select(FORMAT_OPTS[type].map((f) => [f, FMT_LABEL[f] || f]), anime ? 'TV' : 'MANGA');
    const mediaStatus = select(MEDIA_STATUS_OPTS, 'FINISHED');
    const status = select(STATUS_OPTS(anime), 'PLANNING');
    const epsLabel = anime ? 'Episodes' : 'Chapters';
    const eps = el('input', { type: 'number', min: '0', placeholder: 'unknown' });
    const vols = el('input', { type: 'number', min: '0', placeholder: 'unknown' });
    const cover = el('input', { type: 'text', placeholder: 'https://… (optional)' });
    const banner = el('input', { type: 'text', placeholder: 'https://… (optional)' });

    // --- extra media content ---
    const description = el('textarea', { placeholder: 'Synopsis… (basic HTML like <br> and <i> works)' });
    const genres = el('input', { type: 'text', placeholder: 'Action, Comedy, …' });
    const tags = el('input', { type: 'text', placeholder: 'Iyashikei:94, Female Protagonist' });
    const studio = el('input', { type: 'text', placeholder: anime ? 'e.g. Studio Ghibli' : '' });

    const charsWrap = el('div');
    function addCharRow(c) {
      const row = el('div', { class: 'alce-char-row' },
        el('input', { class: 'c-name', type: 'text', placeholder: 'Character name' }),
        (() => {
          const s = select(CHAR_ROLES, (c && c.role) || 'MAIN');
          s.className = 'c-role';
          return s;
        })(),
        el('input', { class: 'c-img', type: 'text', placeholder: 'Image URL (optional)' }),
        el('button', { title: 'Remove', onclick: (e) => { e.preventDefault(); row.remove(); } }, '✕'),
      );
      if (c) {
        if (c.id) row.dataset.charId = c.id; // imported chars get ids on save
        row.querySelector('.c-name').value = c.name;
        if (c.image && c.image !== DEFAULT_CHAR_IMG) row.querySelector('.c-img').value = c.image;
      }
      charsWrap.appendChild(row);
    }
    const charsSection = el('div', { class: 'alce-chars' },
      el('div', { class: 'alce-field' }, el('label', {}, 'Characters')),
      charsWrap,
      el('button', { class: 'alce-add-char', onclick: (e) => { e.preventDefault(); addCharRow(); } }, '+ Add Character'),
    );

    function readChars() {
      const out = [];
      for (const row of charsWrap.querySelectorAll('.alce-char-row')) {
        const name = row.querySelector('.c-name').value.trim();
        if (!name) continue;
        const cid = row.dataset.charId ? parseInt(row.dataset.charId, 10) : ID_BASE + (++db.seq);
        out.push({
          id: cid,
          name,
          role: row.querySelector('.c-role').value,
          image: row.querySelector('.c-img').value.trim() || null,
        });
      }
      return out;
    }

    function applyContent(rec) {
      const md = rec.media;
      md.description = description.value.trim() || null;
      md.genres = genres.value.split(',').map((s) => s.trim()).filter(Boolean);
      md.tags = parseTags(tags.value);
      md.studioName = anime ? (studio.value.trim() || null) : null;
      rec.characters = readChars();
      if (imported) {
        md.synonyms = imported.synonyms || [];
        if (imported.year && !(md.startDate && md.startDate.year)) {
          md.startDate = { year: imported.year, month: null, day: null };
        }
        rec.external = Object.assign({}, rec.external, imported.external);
      }
    }

    /* --- metadata import + cover picker (shared builders) --- */
    let imported = null;
    const covers = buildCoverPicker((url) => { cover.value = url; });
    const search = buildImportSearch(type, async (r, ui) => {
      if (r.hydrate) {
        ui.setStatus(`Fetching details from ${r.provider}…`);
        try { r = await r.hydrate(); } catch (e) { ui.setStatus(`${r.provider}: ${e.message}`); return; }
      }
      imported = r;
      title.value = r.title;
      if (FORMAT_OPTS[type].includes(r.format)) format.value = r.format;
      mediaStatus.value = r.mediaStatus;
      if (anime) {
        if (r.episodes) eps.value = r.episodes;
      } else {
        if (r.chapters) eps.value = r.chapters;
        if (r.volumes) vols.value = r.volumes;
      }
      if (r.cover) cover.value = r.cover;
      if (r.description) description.value = r.description;
      if (r.genres.length) genres.value = r.genres.join(', ');
      if (r.tags.length) tags.value = r.tags.join(', ');
      if (anime && r.studio) studio.value = r.studio;
      covers.setSeries(r.external && r.external.mangabaka);
      const base = `Imported "${r.title}" from ${r.provider}.`;
      if (!r.malId) { ui.setStatus(base); return; }
      ui.setStatus(base + ' Fetching characters (MAL)…');
      try {
        const chars = await fetchJikanCharacters(r.malId, type);
        if (imported !== r) return; // superseded by a later pick
        if (chars.length) {
          charsWrap.textContent = '';
          for (const c of chars) addCharRow(c);
        }
        ui.setStatus(base + (chars.length ? ` ${chars.length} characters added.` : ' No characters on MAL.'));
      } catch (e) {
        if (imported === r) ui.setStatus(base + ` Characters failed: ${e.message}`);
      }
    });
    const overlay = el('div', { class: 'alce-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
    overlay.appendChild(el('div', { class: 'alce-modal alce-modal-create' },
      el('div', { class: 'alce-modal-top' },
        modalHead(`Add Custom ${anime ? 'Anime' : 'Manga'} Entry`, overlay, 'Pick an import result to fill the form, or type everything by hand. Nothing is saved until Create.')),
      el('div', { class: 'alce-modal-body' },
        search.root,
        field('Title', title),
        el('div', { class: 'alce-row' }, field('Format', format), field('List Status', status)),
        el('div', { class: 'alce-row' },
          field('Release Status', mediaStatus),
          field(epsLabel, eps),
          ...(anime ? [] : [field('Volumes', vols)])),
        field('Cover Image URL', cover),
        covers.root,
        field('Banner Image URL', banner),
        field('Description', description),
        el('div', { class: 'alce-row' }, field('Genres', genres), field('Tags (name:rank)', tags)),
        ...(anime ? [field('Studio', studio)] : []),
        charsSection,
        el('div', { class: 'alce-btns' },
          el('button', { class: 'alce-btn plain', onclick: () => overlay.remove() }, 'Cancel'),
          el('button', {
            class: 'alce-btn primary',
            onclick: async (e) => {
              const t = title.value.trim();
              if (!t) { title.focus(); return; }
              const btn = e.currentTarget;
              if (btn.disabled) return;
              nudgeCanvasPermission();
              btn.disabled = true;
              btn.textContent = 'Creating…';
              try {
                // Cover/banner from hotlink-blocking hosts get embedded now,
                // so the entry never renders with a broken image.
                const [coverUrl, bannerUrl] = await Promise.all([
                  embedIfHotlinkBlocked(cover.value.trim() || DEFAULT_COVER, 'cover'),
                  embedIfHotlinkBlocked(banner.value.trim() || null, 'banner'),
                ]);
                const rec = createRec({
                  ownerId: owner.id, type,
                  title: t,
                  format: format.value,
                  mediaStatus: mediaStatus.value,
                  status: status.value,
                  episodes: anime ? intOrNull(eps.value) : null,
                  chapters: !anime ? intOrNull(eps.value) : null,
                  volumes: !anime ? intOrNull(vols.value) : null,
                  cover: coverUrl || DEFAULT_COVER,
                  banner: bannerUrl || null,
                });
                setCover(rec.media, coverUrl, cover.value.trim());
                setBanner(rec.media, bannerUrl, banner.value.trim());
                applyContent(rec);
                saveDB();
                overlay.remove();
                syncSections(rec);
                // Open the native list editor so everything else (score,
                // notes, custom lists, dates, favourite…) is edited natively.
                const store = vueStore();
                if (store) store.dispatch('medialistEditor/open', rec.id);
              } finally {
                btn.disabled = false;
                btn.textContent = 'Create';
              }
            },
          }, 'Create'),
        ),
      ),
    ));
    document.body.appendChild(overlay);
    title.focus();
  }

  // Manage modal (wrench button), laid out like AniList's own dialogs: a
  // header bar, a tab strip (Entries · Sync · Images · Settings, plus Debug
  // when developer options are on) and one section per tab.
  let manageTab = 'entries';
  function openManageModal() {
    const body = el('div', { class: 'alce-tab-body' });
    const overlay = el('div', { class: 'alce-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
    const tabs = el('div', { class: 'alce-tabs' });
    const subtitle = () => `${allRecs().length} entr${allRecs().length === 1 ? 'y' : 'ies'} · v${window.__ALCE_VERSION || ''}`;
    const head = modalHead('Custom Entries', overlay, subtitle);
    const modal = el('div', { class: 'alce-modal alce-modal-manage' },
      el('div', { class: 'alce-modal-top' }, head, tabs),
      body,
    );
    overlay.appendChild(modal);
    const render = () => {
      const sub = head.querySelector('.alce-modal-sub');
      if (sub) sub.textContent = subtitle();
      renderManage(body, overlay, tabs, render);
    };
    render();
    document.body.appendChild(overlay);
  }

  // Shared modal header: title, optional subtitle, close button.
  function modalHead(title, overlay, subtitle) {
    const sub = typeof subtitle === 'function' ? subtitle() : subtitle;
    return el('div', { class: 'alce-modal-head' },
      el('div', { class: 'alce-modal-titles' },
        el('h2', {}, title),
        ...(sub ? [el('div', { class: 'alce-modal-sub' }, sub)] : [])),
      el('button', { class: 'alce-modal-close', title: 'Close', onclick: () => overlay.remove() }, '✕'),
    );
  }

  // Reassign every custom entry and activity (plus the previous owner's
  // replies) to another known account. touchRec/touchAct make the migrated
  // versions win the cross-device sync merge.
  function migrateAllTo(targetId) {
    let moved = 0;
    for (const rec of allRecs()) {
      if (rec.ownerId === targetId) continue;
      rec.ownerId = targetId;
      touchRec(rec);
      moved++;
    }
    for (const a of Object.values(db.activities)) {
      if (a.ownerId === targetId) continue;
      const prev = a.ownerId;
      a.ownerId = targetId;
      for (const r of a.replies || []) { if (r.userId === prev) r.userId = targetId; }
      touchAct(a);
    }
    saveDB();
    return moved;
  }

  // One entry (plus its activities) as an importable database slice.
  function exportSlice(recs) {
    const ids = new Set(recs.map((r) => r.id));
    const out = { version: DB_VERSION, seq: db.seq, owners: {}, entries: {}, activities: {}, deleted: {}, favOrder: {} };
    for (const r of recs) { out.entries[r.id] = r; if (db.owners[r.ownerId]) out.owners[r.ownerId] = db.owners[r.ownerId]; }
    for (const [id, a] of Object.entries(db.activities)) if (ids.has(a.mediaId)) out.activities[id] = a;
    return JSON.stringify(packDB(out));
  }

  const timeAgo = (t) => {
    const d = Math.max(0, nowSec() - t);
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
    return `${Math.floor(d / 86400)} d ago`;
  };

  function renderManage(container, overlay, tabsEl, rerender) {
    container.textContent = '';
    const TABS = [['entries', 'Entries'], ['sync', 'Sync'], ['images', 'Images'], ['settings', 'Settings']];
    if (debugEnabled()) TABS.push(['debug', 'Debug']);
    if (!TABS.some(([k]) => k === manageTab)) manageTab = 'entries';
    if (tabsEl) {
      tabsEl.textContent = '';
      for (const [key, label] of TABS) {
        tabsEl.appendChild(el('div', {
          class: 'alce-tab' + (manageTab === key ? ' active' : ''),
          onclick: () => { manageTab = key; rerender(); },
        }, label));
      }
    }
    const section = (title, ...children) => el('div', { class: 'alce-section' },
      ...(title ? [el('div', { class: 'alce-section-title' }, title)] : []), ...children);
    const hint = (text) => el('div', { class: 'alce-sync-status' }, text);
    const btnRow = (...btns) => el('div', { class: 'alce-io-btns' }, ...btns);

    if (manageTab === 'entries') renderEntriesTab(container, overlay, rerender, section, hint, btnRow);
    else if (manageTab === 'sync') renderSyncTab(container, rerender, section, hint, btnRow);
    else if (manageTab === 'images') renderImagesTab(container, section, hint, btnRow);
    else if (manageTab === 'settings') renderSettingsTab(container, rerender, section, hint, btnRow);
    else if (manageTab === 'debug') renderDebugTab(container, section, hint, btnRow);
  }

  /* --- Entries tab: filterable list with per-row edit / export / delete. --- */
  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg || 'Copied to clipboard'); }
    catch (e) { toast('Copy failed (clipboard blocked by the browser)', true); }
  }
  function renderEntriesTab(container, overlay, rerender, section, hint, btnRow) {
    const listOwner = syncCfg.listOwner; // 'all' or an owner id (Settings › Accounts)
    const recs = allRecs().filter((r) => !listOwner || listOwner === 'all' || String(r.ownerId) === String(listOwner))
      .slice().sort((a, b) => recTime(b) - recTime(a));
    // Search box in the quick search's idiom, list in the media list's
    // table idiom (40px cover cell, title, Status / Type columns, whole row
    // turns blue on hover), plus the row actions.
    const filter = el('input', { type: 'text', placeholder: recs.length ? `Search ${recs.length} entr${recs.length === 1 ? 'y' : 'ies'}` : 'No custom entries yet', spellcheck: 'false' });
    const searchBox = el('div', { class: 'alce-search' }, svgIcon(ICON_SEARCH), filter);
    const list = el('div', { class: 'alce-list' });
    const renderList = () => {
      list.textContent = '';
      const q = normText(filter.value);
      const shown = recs.filter((rec) => !q || recSearchTitles(rec).some((t) => t.includes(q)));
      if (shown.length) {
        list.appendChild(el('div', { class: 'alce-list-head' },
          el('div', { class: 'alce-col-cover' }),
          el('div', { class: 'alce-col-title' }, 'Title'),
          el('div', { class: 'alce-col-progress' }, 'Progress'),
          el('div', { class: 'alce-col-status' }, 'Status'),
          el('div', { class: 'alce-col-type' }, 'Type'),
          el('div', { class: 'alce-col-actions' })));
      }
      for (const rec of shown) {
        const total = rec.type === 'ANIME' ? rec.media.episodes : rec.media.chapters;
        const progress = rec.entry.status ? `${rec.entry.progress || 0}${total ? '/' + total : ''}` : '';
        const cover = el('div', { class: 'alce-list-cover' });
        const cu = rec.media.coverImage && (rec.media.coverImage.medium || rec.media.coverImage.large);
        if (cu && cu !== DEFAULT_COVER) cover.style.backgroundImage = 'url("' + String(cu).replace(/"/g, '') + '")';
        const status = rec.entry.status ? ((STATUS_OPTS(rec.type === 'ANIME').find((o) => o[0] === rec.entry.status) || [])[1] || rec.entry.status) : 'Not on a list';
        const type = FMT_LABEL[rec.media.format] || rec.media.format || (rec.type === 'ANIME' ? 'Anime' : 'Manga');
        list.appendChild(el('div', { class: 'alce-list-row', onclick: () => location.assign(mediaHref(rec)) },
          el('div', { class: 'alce-col-cover' }, cover),
          el('div', { class: 'alce-col-title' },
            el('div', { class: 'alce-list-title' }, rec.media.title.userPreferred)),
          el('div', { class: 'alce-col-progress' }, progress),
          el('div', { class: 'alce-col-status' }, status),
          el('div', { class: 'alce-col-type' }, type),
          el('div', { class: 'alce-col-actions' },
            el('button', {
              class: 'alce-item-act', title: 'Edit',
              onclick: (e) => { e.stopPropagation(); location.assign(editHref(rec)); },
            }, svgIcon(ICON_PEN)),
            el('button', {
              class: 'alce-item-act', title: 'Copy as JSON',
              onclick: (e) => { e.stopPropagation(); copyText(exportSlice([rec]), `Copied "${rec.media.title.userPreferred}" as JSON`); },
            }, svgIcon(ICON_DOWNLOAD)),
            el('button', {
              class: 'alce-item-del',
              title: 'Delete',
              onclick: (e) => {
                e.stopPropagation();
                markDeleted(rec.id);
                delete db.entries[rec.id];
                deleteActivitiesFor(rec);
                saveDB();
                syncSections(rec, true);
                syncHomePreview(rec, true);
                const store = vueStore();
                if (store) store.commit('deleteEntity', { type: 'listEntry', id: rec.entry.id });
                rerender();
                toast(`Deleted "${rec.media.title.userPreferred}"`);
              },
            }, svgIcon(ICON_TRASH))),
        ));
      }
      if (!shown.length) list.appendChild(hint(recs.length ? 'No entry matches.' : 'Press + on your anime or manga list to create one.'));
    };
    filter.addEventListener('input', renderList);
    renderList();
    container.appendChild(section(null, searchBox, list));
  }

  // GitHub-style confirmation: the action button only arms once the word is
  // typed. Resolves true when confirmed, false when dismissed.
  function confirmModal(opts) {
    return new Promise((resolve) => {
      const word = opts.word || 'confirm';
      const overlay = el('div', { class: 'alce-overlay', onclick: (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } } });
      const input = el('input', { type: 'text', placeholder: word, spellcheck: 'false', autocomplete: 'off' });
      const go = el('button', { class: 'alce-btn alce-danger', disabled: 'disabled' }, opts.actionLabel || 'Confirm');
      input.addEventListener('input', () => { if (input.value.trim().toLowerCase() === word) go.removeAttribute('disabled'); else go.setAttribute('disabled', 'disabled'); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.hasAttribute('disabled')) go.click(); if (e.key === 'Escape') { overlay.remove(); resolve(false); } });
      go.addEventListener('click', () => { if (go.hasAttribute('disabled')) return; overlay.remove(); resolve(true); });
      overlay.appendChild(el('div', { class: 'alce-modal alce-modal-confirm' },
        el('div', { class: 'alce-modal-top' }, modalHead(opts.title || 'Are you sure?', overlay)),
        el('div', { class: 'alce-modal-body' },
          el('div', { class: 'alce-confirm-text' }, opts.message || ''),
          el('div', { class: 'alce-field' }, el('label', {}, `Type '${word}' to continue`), input),
          el('div', { class: 'alce-btns' },
            el('button', { class: 'alce-btn plain', onclick: () => { overlay.remove(); resolve(false); } }, 'Cancel'),
            go)),
      ));
      overlay.querySelector('.alce-modal-close').addEventListener('click', () => resolve(false));
      document.body.appendChild(overlay);
      input.focus();
    });
  }

  /* --- Sync tab: GitHub sync, encryption, last pull report. --- */
  function renderSyncTab(container, rerender, section, hint, btnRow) {
    const repoIn = el('input', { type: 'text', placeholder: 'user/repo (private)', spellcheck: 'false' });
    repoIn.value = syncCfg.repo || '';
    const tokIn = el('input', { type: 'password', placeholder: 'Fine-grained token (Contents: read & write on that repo only)' });
    tokIn.value = syncCfg.token || '';
    const passIn = el('input', { type: 'password', placeholder: 'Never stored. Use the same passphrase on every device.' });
    // Status card: a sync row (state dot, message, Sync now) and an
    // encryption row (lock, state, Disable), instead of two lines of text.
    const statusText = el('span', { class: 'alce-status-text' },
      syncConfigured() ? (syncCfg.lastStatus || 'Configured, not synced yet') : 'Not configured');
    syncStatusEl = statusText;
    const syncRow = el('div', { class: 'alce-status-row', 'data-state': !syncConfigured() ? 'off' : (syncCfg.lastStatusError ? 'bad' : (syncCfg.lastStatus ? 'ok' : 'off')) },
      el('span', { class: 'alce-status-dot' }),
      el('div', { class: 'alce-status-main' }, el('b', {}, 'Sync'), statusText));
    const encText = el('span', { class: 'alce-status-text' }, 'Checking…');
    const disableBtn = el('button', { class: 'alce-status-act', style: 'display:none' }, 'Disable');
    const encRow = el('div', { class: 'alce-status-row', 'data-state': 'off' },
      el('span', { class: 'alce-status-dot' }),
      el('div', { class: 'alce-status-main' }, el('b', {}, 'Encryption'), encText),
      disableBtn);
    const refreshEnc = async () => {
      let on = !!syncKey;
      if (!on) { try { on = !!(await idbGetKey()); } catch (e) { /* ignore */ } }
      encText.textContent = on ? 'On · AES-256-GCM, key kept in this browser' : 'Off · set a passphrase above and press Save & Sync Now';
      encRow.dataset.state = on ? 'ok' : 'off';
      disableBtn.style.display = on ? '' : 'none';
    };
    const finish = () => { refreshEnc(); if (syncCfg.lastStatus) toast(syncCfg.lastStatus, !!syncCfg.lastStatusError); };
    disableBtn.addEventListener('click', () => {
      dropEncryption = true;
      syncNow('manual').then(finish);
    });
    const syncNowBtn = el('button', { class: 'alce-status-act', onclick: () => { if (!syncConfigured()) { toast('Configure the repository and token first', true); return; } syncNow('manual').then(finish); } }, 'Sync now');
    syncRow.appendChild(syncNowBtn);
    refreshEnc();
    container.appendChild(section('GitHub sync',
      hint('One JSON file in a private repo, pushed on every change and merged on every page load. The token stays in this browser.'),
      field('Repository', repoIn),
      field('Access token', tokIn),
      field('Encryption passphrase (optional)', passIn),
      btnRow(
        el('button', {
          class: 'blue',
          onclick: () => {
            syncCfg.repo = repoIn.value.trim();
            syncCfg.token = tokIn.value.trim();
            saveSyncCfg();
            if (passIn.value) {
              pendingPassphrase = passIn.value;
              passIn.value = '';
              dropEncryption = false;
            }
            if (syncConfigured()) syncNow('manual').then(finish);
            else { setSyncStatus('Not configured'); syncRow.dataset.state = 'off'; }
          },
        }, 'Save & Sync Now'),
      ),
      el('div', { class: 'alce-status-card' }, syncRow, encRow),
    ));

    // Last pull report: which records the merge took from the other side.
    const rep = syncCfg.lastMerge;
    const KIND = { new: 'added from remote', updated: 'remote version won', removed: 'deleted on remote' };
    container.appendChild(section('Last pull',
      ...(rep && rep.at ? [
        hint(`${timeAgo(rep.at)}: ${rep.items.length + (rep.more || 0)} entr${rep.items.length + (rep.more || 0) === 1 ? 'y' : 'ies'} changed${rep.activities ? `, ${rep.activities} activit${rep.activities === 1 ? 'y' : 'ies'}` : ''}.`),
        ...(rep.items.length ? [el('div', { class: 'alce-report' },
          ...rep.items.map((it) => el('div', { class: 'alce-report-row ' + it.kind },
            el('span', { class: 'alce-report-kind' }, KIND[it.kind] || it.kind),
            el('span', { class: 'alce-report-title' }, it.title))),
          ...(rep.more ? [hint(`… and ${rep.more} more`)] : []))] : []),
      ] : [hint('No pull has changed anything yet on this device.')]),
    ));
  }

  /* --- Images tab: image host + migration of embedded images. --- */
  function renderImagesTab(container, section, hint, btnRow) {
    const imgHostIn = el('input', { type: 'text', placeholder: 'https://sync.manga.example.com', spellcheck: 'false' });
    imgHostIn.value = syncCfg.imgHost || '';
    const imgTokIn = el('input', { type: 'password', placeholder: 'UPLOAD_TOKEN of the image host' });
    imgTokIn.value = syncCfg.imgToken || '';
    let embedded = 0;
    let embeddedBytes = 0;
    for (const rec of allRecs()) {
      const md = rec.media || {};
      for (const u of [md.coverImage && md.coverImage.large, md.bannerImage]) if (isDataUrl(u)) { embedded++; embeddedBytes += String(u).length; }
    }
    const imgStatus = el('div', { class: 'alce-sync-status' }, imgHostConfigured()
      ? 'Configured. Images that cannot be hotlinked are uploaded there instead of embedded.'
      : 'Not configured: images that cannot be hotlinked are embedded as data: URIs (they count against the ~5 MB localStorage quota).');
    const migrateBtn = el('button', {}, `Upload embedded images${embedded ? ` (${embedded}, ${Math.round(embeddedBytes / 1024)} KB)` : ''}`);
    let migrating = false;
    migrateBtn.addEventListener('click', async () => {
      if (migrating) return;
      if (!imgHostConfigured()) { toast('Configure and save the image host first', true); return; }
      migrating = true;
      migrateBtn.disabled = true;
      let done = 0;
      let failed = 0;
      let seen = 0;
      const jobs = [];
      for (const rec of allRecs()) {
        const md = rec.media || {};
        if (isDataUrl(md.coverImage && md.coverImage.large)) jobs.push({ rec, kind: 'cover', uri: md.coverImage.large });
        if (isDataUrl(md.bannerImage)) jobs.push({ rec, kind: 'banner', uri: md.bannerImage });
      }
      if (!jobs.length) { imgStatus.textContent = 'No embedded images to upload.'; migrating = false; migrateBtn.disabled = false; return; }
      for (const job of jobs) {
        seen++;
        imgStatus.textContent = `Uploading ${seen}/${jobs.length}…`;
        try {
          const u = await uploadToImageHost(dataUriToBlob(job.uri));
          const md = job.rec.media;
          if (job.kind === 'cover') setCover(md, u, md.coverSource); else setBanner(md, u, md.bannerSource);
          touchRec(job.rec);
          done++;
        } catch (e) {
          failed++;
          console.warn(TAG, 'image upload failed for', job.rec.id, job.kind, e);
        }
      }
      if (done) saveDB();
      imgStatus.textContent = `Moved ${done} image${done === 1 ? '' : 's'} to the image host${failed ? `, ${failed} failed (see console)` : ''}. Reload to see them.`;
      migrating = false;
      migrateBtn.disabled = false;
    });
    container.appendChild(section('Image host',
      hint('A self-hosted al-custom-entry-images server for covers that cannot be hotlinked. Uploads are public at unguessable URLs.'),
      field('Base URL', imgHostIn),
      field('Upload token', imgTokIn),
      btnRow(
        el('button', {
          class: 'blue',
          onclick: async () => {
            syncCfg.imgHost = imgHostIn.value.trim().replace(/\/+$/, '');
            syncCfg.imgToken = imgTokIn.value.trim();
            saveSyncCfg();
            if (!imgHostConfigured()) { imgStatus.textContent = 'Not configured.'; return; }
            imgStatus.textContent = 'Testing…';
            try {
              const r = await gmRequest(imgHostBase() + '/covers', {
                headers: { Authorization: 'Bearer ' + syncCfg.imgToken }, accept: 'application/json',
              });
              const j = JSON.parse(r.responseText);
              imgStatus.textContent = `Reachable: ${j.count} image${j.count === 1 ? '' : 's'} stored (${Math.round((j.bytes || 0) / 1024)} KB). Token accepted.`;
            } catch (e) {
              imgStatus.textContent = 'Image host test failed: ' + e.message
                + (gmXHR ? '' : ' (GM_xmlhttpRequest missing, uploads will use plain fetch)');
            }
          },
        }, 'Save & Test'),
        migrateBtn,
      ),
      imgStatus,
    ));
  }

  /* --- Settings tab: toggles, account move, export / import, danger zone. --- */
  let bulkSource = 'mal';
  function renderSettingsTab(container, rerender, section, hint, btnRow) {
    const toggle = (label, text, get, set) => {
      const chk = el('input', { type: 'checkbox' });
      chk.checked = get();
      chk.onchange = () => set(chk.checked);
      return el('label', { class: 'alce-check' }, chk, el('span', {}, el('b', {}, label), el('div', { class: 'alce-check-desc' }, text)));
    };
    container.appendChild(section('Behavior',
      toggle('Profile statistics', 'Count custom entries in your profile statistics, the Stats pages and the Activity History heatmap.',
        statsBumpEnabled, (on) => { syncCfg.statsBump = on; saveSyncCfg(); toast(on ? 'Custom entries now count in your profile statistics (reload the profile to see it)' : 'Custom entries no longer count in your profile statistics (reload the profile to see it)'); }),
      toggle('Search on top', 'Pin custom entries to the top of search results whatever the sort. Off: they sort like real entries (last under popularity, trending, score and favourites).',
        searchBumpEnabled, (on) => { syncCfg.searchBump = on; saveSyncCfg(); toast(on ? 'Custom entries now sit on top of search results' : 'Custom entries now follow the search sort'); }),
      toggle('Developer options', 'Show the Debug tab.',
        debugEnabled, (on) => { syncCfg.debug = on; saveSyncCfg(); if (!on && manageTab === 'debug') manageTab = 'settings'; rerender(); }),
    ));

    const recs = allRecs();
    const owners = Object.values(db.owners);
    if (owners.length > 1) {
      const counts = {};
      for (const r of recs) counts[r.ownerId] = (counts[r.ownerId] || 0) + 1;
      const showSel = select([['all', `All accounts (${recs.length})`]].concat(owners.map((o) => [String(o.id), `${o.name || o.id} (${counts[o.id] || 0})`])), syncCfg.listOwner || 'all');
      showSel.addEventListener('change', () => { syncCfg.listOwner = showSel.value; saveSyncCfg(); toast(showSel.value === 'all' ? 'Entries tab shows every account' : `Entries tab shows ${(db.owners[showSel.value] || {}).name || showSel.value}'s entries`); });
      container.appendChild(section('Accounts',
        hint('Custom entries belong to the account they were created from. Choose which account the Entries tab lists.'),
        field('Entries tab shows', showSel),
      ));
    }
    if (recs.length) {
      const selfOwners = owners.filter((o) => o.self);
      const ownerSel = select(selfOwners.map((o) => [String(o.id), o.name || String(o.id)]), null);
      container.appendChild(section('Move to another account',
        hint('Moves every custom entry and its activities to the selected account (only accounts you\'ve been logged into are listed).'),
        ...(selfOwners.length ? [
          field('Account', ownerSel),
          btnRow(el('button', {
            class: 'blue',
            onclick: () => {
              const targetId = parseInt(ownerSel.value, 10);
              const target = db.owners[targetId];
              if (!target) return;
              const moved = migrateAllTo(targetId);
              rerender();
              if (moved) toast(`Moved ${moved} entr${moved === 1 ? 'y' : 'ies'} to ${target.name}. Reload to see them there.`);
              else toast(`Everything already belongs to ${target.name}`, true);
            },
          }, 'Move All')),
        ] : [hint('No other account known yet.')]),
      ));
    }

    // Export copies JSON to the clipboard; import pastes it here and merges
    // (newest edit per record wins, tombstones respected) or, after typing
    // "confirm", replaces the whole database.
    const ta = el('textarea', { spellcheck: 'false', placeholder: 'Paste export JSON here' });
    ta.style.display = 'block';
    const parseTa = () => {
      if (!ta.value.trim()) { toast('Paste export JSON first', true); ta.focus(); return null; }
      let parsed;
      try { parsed = migrateDB(unpackDB(JSON.parse(ta.value))); } catch (e) { toast('Invalid JSON', true); return null; }
      if (!parsed || !parsed.entries) { toast('Not a custom-entries export', true); return null; }
      return parsed;
    };
    const ownerNow = currentOwner();
    container.appendChild(section('Export / Import',
      hint('Merge Import combines a pasted export with this database (newest edit of each entry wins); Replace swaps everything.'),
      btnRow(
        el('button', { onclick: () => copyText(JSON.stringify(packDB(db)), 'Copied the whole database as JSON') }, 'Copy all as JSON'),
        ...(ownerNow ? [el('button', { onclick: () => copyText(exportSlice(allRecs().filter((r) => r.ownerId === ownerNow.id)), `Copied ${ownerNow.name}'s entries as JSON`) }, `Copy ${ownerNow.name}'s as JSON`)] : []),
      ),
      ta,
      btnRow(
        el('button', {
          class: 'blue',
          onclick: () => {
            const parsed = parseTa();
            if (!parsed) return;
            const before = db;
            db = mergeDBs(db, parsed);
            const rep = mergeReport(before, db);
            saveDB();
            rerender();
            const n = rep.items.length + rep.more;
            toast(`Merged: ${n} entr${n === 1 ? 'y' : 'ies'} added or updated. Reload the page.`);
          },
        }, 'Merge Import'),
        el('button', {
          onclick: async () => {
            const parsed = parseTa();
            if (!parsed) return;
            const n = Object.keys(parsed.entries).length;
            const ok = await confirmModal({ title: 'Replace database', message: `This discards the current ${allRecs().length} entr${allRecs().length === 1 ? 'y' : 'ies'} and everything attached to them, and loads the ${n} from the pasted export instead. Synced devices will follow.`, actionLabel: 'Replace database' });
            if (!ok) return;
            db = parsed;
            saveDB();
            rerender();
            toast('Database replaced. Reload the page.');
          },
        }, 'Replace database'),
      ),
    ));

    // Bulk import: MAL export / MangaBaka library / CSV → custom entries.
    {
      const uid = authUserId();
      const owner = (uid && db.owners[uid]) || currentOwner();
      const srcSel = select([['mal', 'MyAnimeList export (XML)'], ['mangabaka', 'MangaBaka library'], ['csv', 'CSV']], bulkSource);
      const body = el('div');
      const status = el('div', { class: 'alce-sync-status' });
      const skipChk = el('input', { type: 'checkbox' });
      skipChk.checked = true;
      const skipRow = el('label', { class: 'alce-check' }, skipChk, el('span', {}, el('b', {}, 'Skip entries that exist on AniList'), el('div', { class: 'alce-check-desc' }, 'Those belong on your real list; only what AniList lacks becomes a custom entry.')));
      const ta = el('textarea', { spellcheck: 'false' });
      ta.style.display = 'block';
      const fileIn = el('input', { type: 'file', accept: '.xml,.gz,.csv,.txt' });
      fileIn.style.display = 'none';
      fileIn.onchange = async () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f) return;
        try { ta.value = await readImportFile(f); status.textContent = `Loaded ${f.name}`; } catch (e) { toast(`Could not read ${f.name}: ${e.message}`, true); }
        fileIn.value = '';
      };
      const tokIn = el('input', { type: 'password', placeholder: 'mb-… personal access token (library.read); used once, never stored', autocomplete: 'off' });
      const typeSel = select([['MANGA', 'Manga'], ['ANIME', 'Anime']], 'MANGA');
      const importBtn = el('button', { class: 'blue' }, 'Import');
      const renderBody = () => {
        body.textContent = '';
        if (bulkSource === 'mal') {
          body.append(hint('MyAnimeList → Settings → Export list. Paste the XML (or pick the .xml.gz) below. Titles, progress, scores, dates and notes carry over; details and covers are fetched from the MAL API afterwards, about one per second.'),
            ta, btnRow(el('button', { onclick: () => fileIn.click() }, 'Choose file…')), skipRow);
        } else if (bulkSource === 'mangabaka') {
          body.append(hint('Reads your MangaBaka library with a personal access token (mangabaka.org → Settings → API, scope library.read). Reading state, progress, rating, dates and notes carry over.'),
            field('Access token', tokIn), skipRow);
        } else {
          body.append(hint('Header row, any column order. Columns: title (required), type, format, status, progress, progress_volumes, score (in your list\'s format), notes, started_at, completed_at, repeat, private, cover, banner, description, genres, tags, synonyms (; separated), episodes, chapters, volumes, media_status, year, mal_id, mangabaka_id, anilist_id, adult.'),
            ta, btnRow(el('button', { onclick: () => fileIn.click() }, 'Choose file…')), field('Type when the CSV has no type column', typeSel), skipRow);
        }
      };
      srcSel.addEventListener('change', () => { bulkSource = srcSel.value; renderBody(); status.textContent = ''; });
      renderBody();
      let running = false;
      importBtn.onclick = async () => {
        if (running) return;
        if (!owner) { toast('Log in first: imported entries need an account to belong to', true); return; }
        let rows;
        try {
          if (bulkSource === 'mal') { if (!ta.value.trim()) { toast('Paste the export XML first', true); ta.focus(); return; } rows = parseMalXml(ta.value); }
          else if (bulkSource === 'csv') { if (!ta.value.trim()) { toast('Paste CSV first', true); ta.focus(); return; } rows = csvRows(ta.value, typeSel.value); }
          else {
            const tok = tokIn.value.trim();
            if (!tok) { toast('Paste a MangaBaka access token first', true); tokIn.focus(); return; }
            running = true; importBtn.disabled = true; importBtn.textContent = 'Loading…';
            rows = await fetchMangaBakaLibrary(tok, (t) => { status.textContent = t; });
          }
        } catch (e) {
          running = false; importBtn.disabled = false; importBtn.textContent = 'Import';
          toast(`Import failed: ${e.message}`, true); status.textContent = '';
          return;
        }
        if (!rows.length) { running = false; importBtn.disabled = false; importBtn.textContent = 'Import'; toast('Nothing to import', true); return; }
        running = true; importBtn.disabled = true; importBtn.textContent = 'Importing…';
        status.textContent = `Importing ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}…`;
        try {
          const r = await runBulkImport(rows, { ownerId: owner.id, skipOnAniList: skipChk.checked }, (t) => { status.textContent = t; });
          const parts = [`${r.added} added`];
          if (r.onAniList) parts.push(`${r.onAniList} skipped (on AniList)`);
          if (r.dupes) parts.push(`${r.dupes} already imported`);
          if (r.failed) parts.push(`${r.failed} failed`);
          status.textContent = 'Done: ' + parts.join(' · ') + (r.added ? '. Reload the page to see them in your list.' : '.');
          toast(`Imported ${r.added} entr${r.added === 1 ? 'y' : 'ies'}` + (r.onAniList ? ` (${r.onAniList} already on AniList)` : ''));
          tokIn.value = '';
        } catch (e) {
          status.textContent = `Import stopped: ${e.message}`;
          toast(`Import failed: ${e.message}`, true);
        }
        running = false; importBtn.disabled = false; importBtn.textContent = 'Import';
      };
      container.appendChild(section('Bulk import',
        field('Source', srcSel), body, fileIn, btnRow(importBtn), status,
      ));
    }

    const delAllBtn = el('button', { class: 'alce-danger' }, 'Delete All Custom Entries');
    delAllBtn.addEventListener('click', async () => {
      const n = allRecs().length;
      if (!n) { toast('Nothing to delete', true); return; }
      const ok = await confirmModal({ title: 'Delete all custom entries', message: `This deletes all ${n} custom entr${n === 1 ? 'y' : 'ies'} and their activities from this database. Deletions replicate to synced devices as tombstones. This cannot be undone.`, actionLabel: `Delete ${n} entr${n === 1 ? 'y' : 'ies'}` });
      if (!ok) return;
      for (const rec of allRecs()) {
        markDeleted(rec.id);
        delete db.entries[rec.id];
        deleteActivitiesFor(rec);
      }
      for (const id of Object.keys(db.activities)) {
        markDeleted(id);
        delete db.activities[id];
      }
      saveDB();
      rerender();
      toast(`Deleted ${n} entr${n === 1 ? 'y' : 'ies'}. Reload the page.`);
    });
    container.appendChild(section('Danger zone', btnRow(delAllBtn)));
  }

  /* --- Debug tab: diagnostics + RPC logging. --- */
  async function runDiagnostics(report) {
    const rows = [];
    const add = (name, ok, detail) => rows.push({ name, ok, detail: String(detail || '') });
    const t0 = window.__ALCE_T0;
    add('Script', true, `v${window.__ALCE_VERSION || '?'} · db v${db.version || '?'}`);
    add('Injection', t0 !== undefined && t0 < 100, t0 === undefined ? 'unknown' : `${Math.round(t0)} ms after navigation start${t0 >= 100 ? ' (late: the first page queries may have run before the hooks; heal passes cover known pages)' : ''}`);
    add('Worker hook', window.Worker === PatchedWorker, window.Worker === PatchedWorker ? 'installed' : 'MISSING (window.Worker replaced by something else)');
    add('fetch hook', window.fetch !== nativeFetch, window.fetch !== nativeFetch ? 'installed' : 'MISSING (window.fetch was replaced after the script ran)');
    add('RPC traffic', audit.leaked === 0, `${audit.handledLocal} handled locally · ${audit.passedThrough} forwarded · ${audit.leaked} leaked${audit.leaked ? ' ⚠' : ''}`);
    const store = vueStore();
    add('Vue store', !!store, store ? 'reachable' : 'not found (page not mounted yet?)');
    const uid = authUserId();
    const owners = Object.values(db.owners);
    add('Account', !!uid, uid ? `viewer ${uid} · owners known: ${owners.map((o) => (o.name || o.id) + (o.self ? '' : ' (browsed)')).join(', ') || 'none'}` : 'not logged in / auth blob missing');
    const recs = allRecs();
    let embedded = 0;
    for (const rec of recs) for (const u of [rec.media.coverImage && rec.media.coverImage.large, rec.media.bannerImage]) if (isDataUrl(u)) embedded++;
    let bytes = 0;
    try { bytes = (localStorage.getItem(LS_KEY) || '').length; } catch (e) { /* ignore */ }
    let quota = '';
    try { if (navigator.storage && navigator.storage.estimate) { const est = await navigator.storage.estimate(); quota = ` · origin storage ${Math.round((est.usage || 0) / 1024)} KB used`; } } catch (e) { /* ignore */ }
    add('Database', bytes < 4 * 1024 * 1024, `${recs.length} entries · ${Object.keys(db.activities).length} activities · ${embedded} embedded image${embedded === 1 ? '' : 's'} · ${Math.round(bytes / 1024)} KB in localStorage${bytes >= 4 * 1024 * 1024 ? ' (near the ~5 MB quota)' : ''}${quota}`);
    if (syncConfigured()) {
      try {
        const r = await ghPull();
        let enc = false;
        try { enc = isEnvelope(r.json); } catch (e) { /* ignore */ }
        add('GitHub sync', true, `${syncCfg.repo} reachable · ${r.sha ? 'file present' : 'no file yet'}${enc ? ' · encrypted' : ''} · ${syncCfg.lastStatus || ''}`);
      } catch (e) { add('GitHub sync', false, `${syncCfg.repo}: ${e.message}`); }
    } else add('GitHub sync', true, 'not configured');
    if (imgHostConfigured()) {
      try {
        const r = await gmRequest(imgHostBase() + '/covers', { headers: { Authorization: 'Bearer ' + syncCfg.imgToken }, accept: 'application/json' });
        const j = JSON.parse(r.responseText);
        add('Image host', true, `${imgHostBase()} reachable · ${j.count} images`);
      } catch (e) { add('Image host', false, `${imgHostBase()}: ${e.message}`); }
    } else add('Image host', true, 'not configured');
    add('GM_xmlhttpRequest', !!gmXHR, gmXHR ? 'available (MangaDex / Dynasty / RanobeDB imports and image embedding)' : 'missing: those import sources are unavailable and embedding falls back to plain fetch');
    add('Toggles', true, `stats ${statsBumpEnabled() ? 'on' : 'off'} · search-on-top ${searchBumpEnabled() ? 'on' : 'off'} · RPC log ${DEBUG_RPC() ? 'on' : 'off'}`);
    report(rows);
    return rows;
  }
  function renderDebugTab(container, section, hint, btnRow) {
    const out = el('div', { class: 'alce-report' });
    let last = null;
    const draw = (rows) => {
      last = rows;
      out.textContent = '';
      for (const r of rows) {
        out.appendChild(el('div', { class: 'alce-report-row ' + (r.ok ? 'ok' : 'bad') },
          el('span', { class: 'alce-report-kind' }, (r.ok ? '✓ ' : '✕ ') + r.name),
          el('span', { class: 'alce-report-title' }, r.detail)));
      }
    };
    const runBtn = el('button', { class: 'blue' }, 'Run diagnostics');
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true; runBtn.textContent = 'Running…';
      out.textContent = ''; out.appendChild(hint('Checking…'));
      try { await runDiagnostics(draw); } catch (e) { draw([{ name: 'Diagnostics', ok: false, detail: String(e) }]); }
      runBtn.disabled = false; runBtn.textContent = 'Run again';
    });
    const copyBtn = el('button', {
      onclick: async () => {
        if (!last) { toast('Run the diagnostics first', true); return; }
        const text = last.map((r) => `${r.ok ? 'OK ' : 'BAD'} ${r.name}: ${r.detail}`).join('\n');
        try { await navigator.clipboard.writeText(text); toast('Report copied'); } catch (e) { toast('Copy failed (clipboard blocked)', true); }
      },
    }, 'Copy report');
    const rpcChk = el('input', { type: 'checkbox' });
    rpcChk.checked = DEBUG_RPC();
    rpcChk.onchange = () => { try { if (rpcChk.checked) localStorage.setItem('alce-debug', '1'); else localStorage.removeItem('alce-debug'); } catch (e) { /* ignore */ } toast(rpcChk.checked ? 'RPC logging on (see the console)' : 'RPC logging off'); };
    container.appendChild(section('Diagnostics',
      hint('Checks hooks, injection timing, the leak tripwire, storage, sync and image host. Nothing is sent anywhere.'),
      btnRow(runBtn, copyBtn),
      out,
    ));
    container.appendChild(section('Logging',
      el('label', { class: 'alce-check' }, rpcChk, el('span', {}, el('b', {}, 'Log every worker RPC'), el('div', { class: 'alce-check-desc' }, 'Query, variables, page options and response entity types, in the console.'))),
      btnRow(el('button', { onclick: () => { auditReport(); toast('Leak audit printed to the console'); } }, 'Print leak audit')),
    ));
    runBtn.click();
  }

  function intOrNull(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function alertBox(msg) {
    const overlay = el('div', { class: 'alce-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
    overlay.appendChild(el('div', { class: 'alce-modal' },
      el('div', { class: 'alce-modal-top' }, modalHead('Custom Entries', overlay)),
      el('div', { class: 'alce-modal-body' },
        el('div', {}, msg),
        el('div', { class: 'alce-btns' },
          el('button', { class: 'alce-btn primary', onclick: () => overlay.remove() }, 'OK'))),
    ));
    document.body.appendChild(overlay);
  }

  function createRec(f) {
    db.seq += 1;
    const id = ID_BASE + db.seq;
    const now = Math.floor(Date.now() / 1000);
    const rec = {
      id,
      ownerId: f.ownerId,
      type: f.type,
      media: {
        id,
        title: { userPreferred: f.title, romaji: f.title, english: f.title, native: f.title },
        coverImage: { extraLarge: f.cover, large: f.cover, medium: f.cover, color: null },
        bannerImage: f.banner,
        coverSource: null,
        bannerSource: null,
        type: f.type,
        format: f.format,
        status: f.mediaStatus || 'FINISHED',
        episodes: f.episodes,
        chapters: f.chapters,
        volumes: f.volumes,
        averageScore: null,
        popularity: 0,
        isAdult: false,
        isFavourite: false,
        countryOfOrigin: 'JP',
        genres: [],
        tags: [],
        description: null,
        studioName: null,
        startDate: { year: null, month: null, day: null },
        isCustom: true,
      },
      characters: [],
      entry: {
        id,
        mediaId: id,
        status: f.status,
        score: 0,
        progress: 0,
        progressVolumes: f.type === 'MANGA' ? 0 : null,
        repeat: 0,
        priority: 0,
        private: false,
        hiddenFromStatusLists: false,
        customLists: {},
        advancedScores: {},
        notes: null,
        updatedAt: now,
        createdAt: now,
        startedAt: { year: null, month: null, day: null },
        completedAt: { year: null, month: null, day: null },
      },
    };
    // A fresh entry gets the same status side effects as a save (created
    // as Completed on a finished series → progress filled, dates stamped).
    applyStatusEffects(rec, f.status);
    db.entries[id] = rec;
    logRevision(rec, 'CREATE', { title: revisionValue(rec.media.title.userPreferred) });
    saveDB();
    // The server would create a "plans to watch/read" (or "completed")
    // activity for a fresh entry; mirror that locally. Bulk imports pass
    // quiet: a migrated backlog shouldn't flood the feed.
    if (!f.quiet) recordListActivity(rec, null, 0);
    console.log(TAG, 'created custom entry', f.quiet ? rec.id : rec);
    return rec;
  }

  /* ------------------------------------------------------------------ *
   * Boot UI + route watching
   * ------------------------------------------------------------------ */

  // If the userscript was injected late (browser race), the page's first
  // queries fired before our hooks existed. Repair the two visible symptoms:
  // a 404 redirect for a custom media/edit URL, and custom entries missing
  // from an already-rendered list.
  function selfHeal() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      const origPath = nav ? new URL(nav.name).pathname : null;
      if (location.pathname === '/404' && origPath && origPath !== '/404') {
        const app = document.querySelector('#app');
        const router = app && app.__vue__ && app.__vue__.$router;
        const m = origPath.match(/^\/(anime|manga|character|staff|studio|activity|review)\/(\d+)|^\/edit\/(anime|manga)\/(\d+)|^\/review\/editor\/(\d+)/);
        const id = m ? parseInt(m[2] || m[4] || m[5], 10) : NaN;
        if (isCustomId(id) && (recById(id) || findCharOwner(id) || staffLinksFor(id).length || customEntriesWithStudio(id).length || activityById(id) || findReview(id))) {
          if (router) {
            console.log(TAG, 'self-healing 404 for', origPath);
            router.replace(origPath);
            return;
          }
        }
        // A media page's genre links use /search/<type>/<Genre>, which the
        // site 404s for genres outside its own vocabulary (custom entries
        // can carry any). Send those to the query form, where the search
        // injection matches genres and tags alike.
        const g = origPath.match(/^\/search\/(anime|manga)\/([^/?#]+)/);
        if (g && router) {
          const label = decodeURIComponent(g[2]).toLowerCase();
          const known = allRecs().some((rec) => (rec.media.genres || []).some((x) => String(x).toLowerCase() === label)
            || (rec.media.tags || []).some((t) => t && String(t.name).toLowerCase() === label));
          if (known) {
            console.log(TAG, 'self-healing 404 genre search for', origPath);
            router.replace(`/search/${g[1]}?genres=${encodeURIComponent(decodeURIComponent(g[2]))}`);
            return;
          }
        }
      }
      if (vueStore()) {
        // List pages: put custom entries back into their sections; home /
        // profile pages: repair the in-progress previews and activity feeds
        // (the initial page-load queries can fire before our hooks exist).
        for (const rec of allRecs()) {
          if (routeInfo()) syncSections(rec);
          syncHomePreview(rec);
        }
        const acts = allActivities(); // newest first
        for (let i = acts.length - 1; i >= 0; i--) pushActivityLive(acts[i], true);
      }
    } catch (e) { /* best effort */ }
  }

  // Public console handle. Run `ALcustom.audit()` any time to verify no
  // phantom-entry traffic has reached AniList.
  const publicApi = {
    audit: auditReport,
    get raw() { return audit; },
    version: (typeof window.__ALCE_VERSION !== 'undefined') ? window.__ALCE_VERSION : null,
    // Decrypt a synced envelope (paste any data.json version from the repo's
    // history). Uses this device's stored key; pass the passphrase as the
    // second argument to decrypt without one (e.g. after a salt change).
    decrypt: async (env, passphrase) => {
      if (typeof env === 'string') env = JSON.parse(env);
      if (!isEnvelope(env)) throw new Error('Not an encrypted ALCE envelope');
      let key = null;
      if (passphrase) {
        key = { key: await deriveSyncKey(passphrase, b64ToBytes(env.kdf.salt), env.kdf.iterations) };
      } else {
        key = syncKey || (await idbGetKey());
        if (!key) throw new Error('No stored key on this device. Pass the passphrase as the second argument.');
      }
      return unpackDB(JSON.parse(await openEnvelope(env, key.key)));
    },
  };
  try { window.ALcustom = publicApi; } catch (e) { /* ignore */ }

  let uiStarted = false;
  function initUI() {
    if (uiStarted) return;
    uiStarted = true;
    try { loadTagCatalog(); } catch (e) { /* best effort */ }
    const style = document.createElement('style');
    style.textContent = CSS + `\n:root { --alce-accent: ${profileColor()}; }`;
    document.head.appendChild(style);

    // The sidebar is re-rendered by Vue on route/filter changes, so re-insert
    // our buttons whenever they disappear.
    setInterval(ensureButtons, 600);
    const wrap = (fn) => function (...args) {
      const r = fn.apply(this, args);
      setTimeout(ensureButtons, 100);
      return r;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () => setTimeout(ensureButtons, 100));
    ensureButtons();
    try { localStorage.removeItem('al-custom-entries-tagdb-v1'); } catch (e) { /* one-time cleanup */ }
    // Imported tags carry no descriptions, so on custom pages suppress the
    // tag tooltip (an empty bubble otherwise) for description-less tags.
    // Capture phase intercepts mouseenter before the tooltip's own listener.
    document.addEventListener('mouseenter', (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.matches('.tags .tag .el-tooltip')) return;
      const rec = mediaRouteRec();
      if (!rec) return;
      const name = t.textContent.trim();
      const tag = (rec.media.tags || []).find((x) => x.name === name);
      if (tag && !tag.description) e.stopImmediatePropagation();
    }, true);
    setTimeout(selfHeal, 1200);
    setTimeout(selfHeal, 3000);
    setTimeout(selfHeal, 7000);
    if (syncConfigured()) {
      setTimeout(() => syncNow('load'), 2500);
      setInterval(() => syncNow('interval'), 10 * 60 * 1000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }
})();
