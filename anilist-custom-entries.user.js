// ==UserScript==
// @name         AniList Custom Entries
// @namespace    al-custom-entries
// @version      1.30.1
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
  try { window.__ALCE_T0 = performance.now(); window.__ALCE_VERSION = '1.30.1'; } catch (e) { /* diagnostics only */ }
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

  function saveDB(opts) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(packDB(db))); }
    catch (e) {
      console.warn(TAG, 'failed to save db', e);
      // Embedded images are the usual reason for hitting the ~5 MB quota.
      if (document.body) {
        try { toast('Custom entries: browser storage is full, this change was NOT saved (embedded images take space; replace some with URLs)', true); }
        catch (e2) { /* toast not ready */ }
      }
    }
    if (!opts || !opts.noSync) scheduleSync();
  }

  let db = loadDB();
  db.activities = db.activities || {}; // migration from pre-1.8 databases
  db.deleted = db.deleted || {}; // migration from pre-1.9 databases (sync tombstones)
  db.favOrder = db.favOrder || {}; // migration from pre-1.21 databases

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
    }
    for (const id of Object.keys(out.activities)) {
      bump(id);
      for (const r of out.activities[id].replies || []) bump(r.id);
    }
    const cutoff = nowSec() - 180 * 86400;
    for (const [id, t] of Object.entries(out.deleted)) { if (t < cutoff) delete out.deleted[id]; }
    pruneOwners(out);
    return out;
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
    return { sha: j.content && j.content.sha };
  }

  let syncStatusEl = null;
  function setSyncStatus(msg, isError) {
    syncCfg.lastStatus = msg;
    syncCfg.lastStatusAt = nowSec();
    saveSyncCfg();
    if (syncStatusEl && syncStatusEl.isConnected) {
      syncStatusEl.textContent = msg;
      syncStatusEl.style.color = isError ? 'rgb(232,93,117)' : '';
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

  async function syncNow(trigger) {
    if (!syncConfigured()) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    setSyncStatus('Syncing…');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
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
          setSyncStatus(`In sync${wantEnc ? ' 🔒' : ''} (${new Date().toLocaleTimeString()})${suffix}`);
          return;
        }
        const plain = JSON.stringify(sortDeep(packDB(merged)), null, 2);
        const body = wantEnc ? JSON.stringify(await sealEnvelope(key, plain), null, 2) : plain;
        const pushed = await ghPush(body, remote.sha);
        if (pushed.conflict) continue; // another device pushed first: re-pull and re-merge
        if (dropEncryption) {
          dropEncryption = false;
          syncKey = null;
          try { await idbSetKey(null); } catch (e) { /* ignore */ }
        }
        setSyncStatus(`Synced${wantEnc ? ' 🔒' : ''} (${new Date().toLocaleTimeString()})${suffix}`);
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

  function sanitizeHtml(html) {
    if (typeof html !== 'string' || html.indexOf('<') === -1) return html;
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
    const m = Object.assign({}, rec.media, { mediaListEntry: recIsListed(rec) ? rec.id : null });
    if (m.description) m.description = sanitizeHtml(m.description);
    return m;
  }

  function userEntity(ownerId) {
    const owner = db.owners[ownerId];
    return { id: ownerId, name: owner ? owner.name : '?' };
  }

  /* --- local recommendations (rec.recs = [{id, target, rating, userRating,
   * media}]): target is a real AniList id (media stub captured at save
   * time so cards render offline) or another custom entry's id. --- */

  function recRecEntity(rr) {
    return {
      id: rr.id,
      rating: rr.rating || 0,
      userRating: rr.userRating || 'RATE_UP',
      mediaRecommendation: rr.target,
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

    const studioEntities = {};
    if (rec.media.studioName) {
      studioEntities[id] = { id, name: rec.media.studioName, isAnimationStudio: true, isFavourite: false };
      media.studios = { edges: [{ id, isMain: true, node: id }] };
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

    if (rec.recs && rec.recs.length) {
      page['mediaRecommendations-' + id] = recPageEntity(rec);
      for (const rr of rec.recs) {
        recommendationEntities[rr.id] = recRecEntity(rr);
        const tm = recTargetMediaEntity(rr);
        if (tm && !mediaEntities[tm.id]) mediaEntities[tm.id] = tm;
      }
    }

    return {
      result: id,
      entities: {
        media: mediaEntities,
        listEntry: recIsListed(rec) ? { [rec.entry.id]: entryEntity(rec) } : {},
        user: { [rec.ownerId]: userEntity(rec.ownerId) },
        character: characterEntities,
        studio: studioEntities,
        recommendation: recommendationEntities,
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
    const progressed = typeof e.progress === 'number' && e.progress > (prevProgress || 0);
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
    // Mirror the AniList API's server-side behaviour on status changes.
    const today = () => {
      const d = new Date();
      return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
    };
    if (vars.status === 'COMPLETED' && rec.media.status === 'FINISHED') {
      const maxProgress = rec.type === 'ANIME' ? rec.media.episodes : rec.media.chapters;
      if (maxProgress) e.progress = maxProgress;
      if (rec.type === 'MANGA' && rec.media.volumes) e.progressVolumes = rec.media.volumes;
      if (!e.completedAt || !e.completedAt.year) e.completedAt = today();
      if (!e.startedAt || !e.startedAt.year) e.startedAt = today();
    }
    if (vars.status === 'CURRENT' && (!e.startedAt || !e.startedAt.year)) {
      e.startedAt = today();
    }
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
  function handleSaveRecommendation(vars) {
    const rec = recById(parseInt(vars.mediaId, 10));
    if (!rec) return { result: null, entities: {} };
    const target = parseInt(vars.mediaRecommendationId, 10);
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
    console.log(TAG, 'saved local recommendation', rec.id, '->', target, rr.userRating);
    const entities = {
      recommendation: { [rr.id]: recRecEntity(rr) },
      page: { ['mediaRecommendations-' + rec.id]: recPageEntity(rec) },
    };
    const tm = recTargetMediaEntity(rr);
    if (tm) entities.media = { [tm.id]: tm };
    const uid = authUserId();
    if (uid) entities.user = { [uid]: userEntity(uid) };
    return { result: rr.id, entities };
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
      relations: { edges: [] },
      studios: {
        edges: md.studioName
          ? [{ id: rec.id, isMain: true, studio: { id: rec.id, name: md.studioName } }]
          : [],
      },
      externalLinks: md.externalLinks || [],
    };
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
    const charId = vars.characterId !== undefined && vars.characterId !== null
      ? parseInt(vars.characterId, 10) : null;
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
      if (isCustomId(vars.id) && query.includes('MediaCharacters(')) {
        const rec = recById(parseInt(vars.id, 10));
        return { MediaCharacters: rec ? mediaCharactersShape(rec) : [] };
      }
      if (isCustomId(vars.id) && /\{Media\(id:\$id\)/.test(query)) {
        const rec = recById(parseInt(vars.id, 10));
        if (!rec) return { Media: null };
        if (query.includes('staffRoles')) {
          return { Media: { id: rec.id, staffRoles: { pageInfo: { total: 0, perPage: 25, currentPage: 1, lastPage: 1, hasNextPage: false }, edges: [] } } };
        }
        return { Media: editMediaShape(rec) };
      }
      if (!hasCustom) return null; // context-only queries (e.g. searches) pass through
      console.warn(TAG, 'blocked direct graphql query touching a custom id', query.slice(0, 80));
      return {};
    }

    // Mutations
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
    // The sidebar "Add Tag" (+) modal: add the tag to the local record,
    // enriched from AniList's tag catalog when the name matches.
    if (query.includes('AddMediaTag') && isCustomId(vars.mediaId)) {
      const rec = recById(parseInt(vars.mediaId, 10));
      const name = String(vars.name || '').trim();
      if (rec && name && !(rec.media.tags || []).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        rec.media.tags = rec.media.tags || [];
        rec.media.tags.push({
          id: ID_BASE + (++db.seq),
          name,
          rank: 100,
          isMediaSpoiler: !!vars.isMediaSpoiler,
          isGeneralSpoiler: false,
          isAdult: false,
          category: null,
          description: null,
          userId: authUserId(),
        });
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
    // Anything else (staff/studio/link/relation submissions…) must never
    // reach the server while a custom entry is in play.
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
    const timeOf = (id) => (ents.listEntry[id] && ents.listEntry[id].updatedAt) || 0;
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

  // The Add Recommendation modal's media search pages are keyed
  // '<TYPE>-"rec-<query>"'. On a custom entry's page, prepend matching
  // custom entries so they can be recommended too.
  function patchRecSearch(result) {
    const rid = result.result;
    if (typeof rid !== 'string') return;
    const m = rid.match(/^(ANIME|MANGA)-"rec-(.*)"$/);
    if (!m) return;
    const self = mediaRouteRec();
    if (!self) return; // only offer custom entries on custom entries' pages
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
      if (rec.type !== m[1] || rec.id === self.id || arr.includes(rec.id)) continue;
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
      if (pid.indexOf('homeListPreview-') === 0) {
        w.__alPending.set(msg.id, { kind: 'listPreview', pageId: pid, type: vars.type, userId: vars.userId });
        return false;
      }
    }

    if (typeof query !== 'string') return false;

    if (query.includes('SaveMediaListEntry') && (isCustomId(vars.mediaId) || isCustomId(vars.id))) {
      respond(w, msg.id, handleSave(vars));
      return true;
    }
    if (query.includes('DeleteMediaListEntry') && isCustomId(vars.id)) {
      respond(w, msg.id, handleDelete(vars));
      return true;
    }
    if (query.includes('ToggleFavourite') && Object.values(vars).some(isCustomId)) {
      respond(w, msg.id, handleFav(vars));
      return true;
    }
    if (query.includes('SaveRecommendation') && isCustomId(vars.mediaId)) {
      respond(w, msg.id, handleSaveRecommendation(vars));
      return true;
    }
    if (isCustomId(vars.id) && /\bCharacter\(/.test(query)) {
      respond(w, msg.id, characterPageResult(parseInt(vars.id, 10), vars));
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
            else if (meta.kind === 'listPreview') patchListPreview(d.result, meta);
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
        tripwire('fetch', query, vars); // clean request → forwarded below
      }
    } catch (e) { /* fall through to the real fetch */ }
    return nativeFetch.apply(this, arguments);
  };

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
     Edit link (ours replaces it), Write Review, the Stats/Social tabs, and
     the always-empty Threads section. */
  html.alce-custom-media .sidebar a.review.button { display: none; }
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
  .alce-overlay { position: fixed; inset: 0; z-index: 2001; background: rgba(0,0,0,.6);
    display: flex; align-items: flex-start; justify-content: center; overflow-y: auto; }
  .alce-modal { margin: 8vh 20px 40px; width: 560px; max-width: 95vw; border-radius: 6px;
    background: rgb(var(--color-foreground, 21 31 46)); color: rgb(var(--color-text, 159 173 189));
    font-size: 1.3rem; padding: 28px; box-shadow: 0 4px 24px rgba(0,0,0,.5); }
  .alce-modal-narrow .alce-manage { margin-top: 0; border-top: none; padding-top: 0; }
  .alce-modal h2 { color: rgb(var(--color-text, 159 173 189)); font-size: 1.5rem; margin: 0 0 20px;
    font-weight: 600; }
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
  .alce-add-char { background: rgb(var(--color-background, 11 22 34)); border: none; border-radius: 3px;
    color: rgb(var(--color-text, 159 173 189)); cursor: pointer; font-size: 1.3rem; padding: 8px 14px; }
  .alce-add-char:hover { color: #fff; }
  .alce-row { display: flex; gap: 10px; }
  .alce-row .alce-field { flex: 1; }
  .alce-img-field-row { display: flex; gap: 8px; align-items: stretch; }
  .alce-img-field-row input { flex: 1; min-width: 0; }
  .alce-embed-btn { flex: none; border: none; border-radius: 3px; padding: 0 12px; cursor: pointer;
    font-size: 1.2rem; font-weight: 500; color: #fff; background: rgb(var(--color-blue, 61 180 242)); }
  .alce-embed-btn:hover { opacity: .85; }
  .alce-embed-btn:disabled { opacity: .5; cursor: default; }
  .alce-btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  .alce-btn { border: none; border-radius: 3px; padding: 8px 14px; cursor: pointer; font-size: 1.3rem; }
  .alce-btn.primary { background: rgb(61,180,242); color: #fff; }
  .alce-btn.primary:hover { opacity: .85; }
  .alce-btn.plain { background: transparent; color: rgb(var(--color-text-light, 122 133 143)); }
  .alce-manage { margin-top: 18px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 14px; }
  .alce-manage-title { font-size: 1.4rem; font-weight: 500; color: rgb(var(--color-text, 159 173 189));
    margin-bottom: 8px; }
  .alce-manage-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 1.3rem; }
  .alce-manage-row span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alce-manage-row button { background: none; border: none; color: rgb(232,93,117); cursor: pointer; font-size: 1.2rem; }
  .alce-io button, .alce-move button, .alce-sync button, .alce-panel-btns button {
    background: rgb(var(--color-background, 11 22 34)); border: none; border-radius: 3px;
    color: rgb(var(--color-text, 159 173 189)); cursor: pointer; font-size: 1.2rem; padding: 7px 12px; }
  .alce-io button:hover, .alce-move button:hover, .alce-sync button:hover,
  .alce-panel-btns button:hover { color: #fff; }
  .alce-io button.blue, .alce-move button.blue, .alce-sync button.blue, .alce-panel-btns button.blue {
    background: rgb(61,180,242); color: #fff; }
  .alce-io button.blue:hover, .alce-move button.blue:hover, .alce-sync button.blue:hover,
  .alce-panel-btns button.blue:hover { opacity: .85; }
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
  button.alce-danger { background: rgb(232,93,117); color: #fff; border: none; border-radius: 3px;
    padding: 8px 14px; font-size: 1.3rem; cursor: pointer; }
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
  .alce-cover-btn { background: rgb(var(--color-background, 11 22 34)); border: none; border-radius: 3px;
    color: rgb(var(--color-text, 159 173 189)); cursor: pointer;
    font-size: 1.2rem; padding: 7px 12px; margin-right: 10px; }
  .alce-cover-btn:hover { color: #fff; }
  .alce-cover-lang { border: none; border-radius: 3px; padding: 6px 26px 6px 10px; font-size: 1.2rem;
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
  function ensureButtons() {
    fillSubmissionSources();
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
  function toast(msg, isError) {
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

    const root = el('div', { class: 'alce-import' }, field(`Search ${sources}`, input), statusEl, results);
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
    SOURCE: 'ADAPTATION', OTHER: 'PARENT',
  };
  const REL_LABELS = {
    PREQUEL: 'Prequel', SEQUEL: 'Sequel', SIDE_STORY: 'Side Story', SPIN_OFF: 'Spin-Off',
    PARENT: 'Parent', ALTERNATIVE: 'Alternative', ADAPTATION: 'Adaptation',
    SOURCE: 'Source', OTHER: 'Other',
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
            touchRec(rec);
            saveDB();
            pushRecEntities(rec);
            renderRels();
          },
        ));
      }
      if (!(rec.relations || []).length) {
        relList.appendChild(el('div', { class: 'alce-sync-status' },
          'None yet. Fetch From MangaBaka links sequels/prequels/side stories: to another custom entry when one matches, to the real AniList entry when it exists, and otherwise creates a custom entry from the MangaBaka data.'));
      }
    };
    renderRels();

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
        el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'Recommendations'),
        recList,
        ...(rec.external && rec.external.mangabaka ? [el('div', { class: 'alce-panel-btns' }, recsBtn)] : []),
        el('div', { class: 'alce-manage-title', style: 'margin-top: 16px' }, 'Relations'),
        relList,
        ...(rec.external && rec.external.mangabaka ? [el('div', { class: 'alce-panel-btns' }, relsBtn)] : []),
      ));
  }

  // Keep the tools panel mounted above the native submission form while a
  // custom entry's edit page is open (the form renders asynchronously).
  // Shown only on the General section; the sidebar nav marks the current
  // section with span.active.
  function panelBelongsOnScreen(panel) {
    const active = document.querySelector('.page-group span.active');
    panel.style.display = (!active || active.textContent.trim() === 'General') ? '' : 'none';
  }

  function ensureEditPanel() {
    const rec = editPageRec();
    const existing = document.querySelector('.alce-edit-panel');
    if (!rec) {
      if (existing) existing.remove();
      return;
    }
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
    const overlay = el('div', { class: 'alce-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
      el('div', { class: 'alce-modal' },
        el('h2', {}, `Add Custom ${anime ? 'Anime' : 'Manga'} Entry`),
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
    );
    document.body.appendChild(overlay);
    title.focus();
  }

  // Manage/settings modal (gear button): entries, account move, export/import
  // and GitHub sync. Entry rows navigate to the native submission editor.
  function openManageModal() {
    const manage = el('div', { class: 'alce-manage' });
    const overlay = el('div', { class: 'alce-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
      el('div', { class: 'alce-modal alce-modal-narrow' },
        el('h2', {}, 'Custom Entries'),
        manage,
      ),
    );
    renderManage(manage, overlay);
    document.body.appendChild(overlay);
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

  function renderManage(container, overlay) {
    container.textContent = '';
    const recs = allRecs();
    const multiOwner = Object.keys(db.owners).length > 1;
    container.appendChild(el('div', { class: 'alce-sync-status' },
      recs.length ? `${recs.length} ${recs.length === 1 ? 'entry' : 'entries'} · click one to edit it on the native editor` : 'No custom entries yet.'));
    for (const rec of recs) {
      const ownerName = multiOwner ? ' · ' + ((db.owners[rec.ownerId] || {}).name || rec.ownerId) : '';
      const cover = el('div', { class: 'alce-item-cover' });
      const cu = rec.media.coverImage && (rec.media.coverImage.medium || rec.media.coverImage.large);
      if (cu && cu !== DEFAULT_COVER) cover.style.backgroundImage = 'url("' + String(cu).replace(/"/g, '') + '")';
      container.appendChild(el('div', { class: 'alce-item-row link', onclick: () => location.assign(editHref(rec)) },
        cover,
        el('div', { class: 'alce-item-text' },
          el('div', { class: 'alce-item-title' }, rec.media.title.userPreferred),
          el('div', { class: 'alce-item-sub' },
            [rec.type === 'ANIME' ? 'Anime' : 'Manga', rec.entry.status || 'Not on a list']
              .join(' · ') + ownerName)),
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
            renderManage(container, overlay);
            toast(`Deleted "${rec.media.title.userPreferred}"`);
          },
        }, svgIcon(ICON_TRASH)),
      ));
    }
    if (recs.length) {
      const selfOwners = Object.values(db.owners).filter((o) => o.self);
      const ownerSel = select(selfOwners.map((o) => [String(o.id), o.name || String(o.id)]), null);
      container.appendChild(el('div', { class: 'alce-move' },
        el('div', {
          class: 'alce-manage-title alce-hinted',
          title: 'Moves every custom entry and its activities to the selected account. Only accounts you\'ve been logged into are listed; log into the other account and open its anime or manga list once to add it here.',
        }, 'Move to Another Account'),
        ...(selfOwners.length ? [
          field('Account', ownerSel),
          el('div', { class: 'alce-io-btns' },
            el('button', {
              class: 'blue',
              onclick: () => {
                const targetId = parseInt(ownerSel.value, 10);
                const target = db.owners[targetId];
                if (!target) return;
                const moved = migrateAllTo(targetId);
                renderManage(container, overlay);
                if (moved) toast(`Moved ${moved} entr${moved === 1 ? 'y' : 'ies'} to ${target.name}. Reload to see them there.`);
                else toast(`Everything already belongs to ${target.name}`, true);
              },
            }, 'Move All'),
          ),
        ] : []),
      ));
    }

    const ta = el('textarea', { spellcheck: 'false' });
    container.appendChild(el('div', { class: 'alce-io' },
      el('div', { class: 'alce-io-btns' },
        el('button', {
          onclick: () => {
            ta.style.display = 'block';
            ta.value = JSON.stringify(packDB(db));
            ta.select();
          },
        }, 'Export'),
        el('button', {
          onclick: () => {
            if (ta.style.display !== 'block') { ta.style.display = 'block'; ta.value = ''; ta.placeholder = 'Paste export JSON here, then press Import again'; ta.focus(); return; }
            try {
              const parsed = unpackDB(JSON.parse(ta.value));
              if (parsed && parsed.entries) {
                db = parsed;
                db.activities = db.activities || {};
                db.deleted = db.deleted || {};
                db.favOrder = db.favOrder || {};
                saveDB();
                renderManage(container, overlay);
                toast('Database imported. Reload the page.');
              }
            } catch (e) { toast('Invalid JSON', true); }
          },
        }, 'Import'),
      ),
      ta,
    ));

    const repoIn = el('input', { type: 'text', placeholder: 'user/repo (private)', spellcheck: 'false' });
    repoIn.value = syncCfg.repo || '';
    const tokIn = el('input', { type: 'password', placeholder: 'Fine-grained token (Contents: read & write on that repo only)' });
    tokIn.value = syncCfg.token || '';
    const passIn = el('input', { type: 'password', placeholder: 'Never stored. Use the same passphrase on every device.' });
    const status = el('div', { class: 'alce-sync-status' },
      syncConfigured() ? (syncCfg.lastStatus || 'Configured, not synced yet') : 'Not configured');
    syncStatusEl = status;
    const encStatus = el('div', { class: 'alce-sync-status' });
    const disableBtn = el('button', { style: 'display:none' }, 'Disable Encryption');
    const refreshEnc = async () => {
      let on = !!syncKey;
      if (!on) { try { on = !!(await idbGetKey()); } catch (e) { /* ignore */ } }
      encStatus.textContent = on
        ? 'Encryption enabled (AES-256-GCM)'
        : 'Encryption off. Set a passphrase to encrypt synced data.';
      disableBtn.style.display = on ? '' : 'none';
    };
    disableBtn.addEventListener('click', () => {
      dropEncryption = true;
      syncNow('manual').then(refreshEnc);
    });
    refreshEnc();
    container.appendChild(el('div', { class: 'alce-sync' },
      el('div', { class: 'alce-manage-title' }, 'GitHub Sync (optional)'),
      el('div', { class: 'alce-sync-status' }, 'The token is stored in this browser\'s localStorage.'),
      field('Repository', repoIn),
      field('Access token', tokIn),
      field('Encryption passphrase (optional)', passIn),
      el('div', { class: 'alce-io-btns' },
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
            if (syncConfigured()) syncNow('manual').then(refreshEnc);
            else setSyncStatus('Not configured');
          },
        }, 'Save & Sync Now'),
        disableBtn,
      ),
      encStatus,
      status,
    ));

    // --- image host (self-hosted al-custom-entry-images) ---
    const imgHostIn = el('input', { type: 'text', placeholder: 'https://sync.manga.example.com', spellcheck: 'false' });
    imgHostIn.value = syncCfg.imgHost || '';
    const imgTokIn = el('input', { type: 'password', placeholder: 'UPLOAD_TOKEN of the image host' });
    imgTokIn.value = syncCfg.imgToken || '';
    const imgStatus = el('div', { class: 'alce-sync-status' }, imgHostConfigured()
      ? 'Configured. Images that cannot be hotlinked are uploaded there instead of embedded.'
      : 'Not configured: images that cannot be hotlinked are embedded as data: URIs (they count against the ~5 MB localStorage quota).');
    const migrateBtn = el('button', {}, 'Upload embedded images');
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
    container.appendChild(el('div', { class: 'alce-sync' },
      el('div', { class: 'alce-manage-title' }, 'Image host (optional)'),
      el('div', { class: 'alce-sync-status' },
        'A self-hosted al-custom-entry-images server. Uploaded images are public at unguessable hash URLs; the token is stored in this browser\'s localStorage.'),
      field('Base URL', imgHostIn),
      field('Upload token', imgTokIn),
      el('div', { class: 'alce-io-btns' },
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

    // --- danger zone ---
    const delAllBtn = el('button', { class: 'alce-danger' }, 'Delete All Custom Entries');
    let armTimer = null;
    delAllBtn.addEventListener('click', () => {
      const n = allRecs().length;
      if (!n) { toast('Nothing to delete', true); return; }
      if (!delAllBtn.dataset.armed) {
        // Two-step confirm: arm for 5 seconds instead of a blocking dialog.
        delAllBtn.dataset.armed = '1';
        delAllBtn.textContent = `Really delete ${n} entr${n === 1 ? 'y' : 'ies'}? Click again`;
        armTimer = setTimeout(() => {
          delete delAllBtn.dataset.armed;
          delAllBtn.textContent = 'Delete All Custom Entries';
        }, 5000);
        return;
      }
      clearTimeout(armTimer);
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
      renderManage(container, overlay);
      toast(`Deleted ${n} entr${n === 1 ? 'y' : 'ies'}. Reload the page.`);
    });
    container.appendChild(el('div', { class: 'alce-move' },
      el('div', {
        class: 'alce-manage-title alce-hinted',
        title: 'Removes every custom entry and all their activities from this database. Deletions replicate to synced devices as tombstones.',
      }, 'Danger Zone'),
      el('div', { class: 'alce-io-btns' }, delAllBtn),
    ));
  }

  function intOrNull(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function alertBox(msg) {
    const overlay = el('div', { class: 'alce-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } },
      el('div', { class: 'alce-modal' },
        el('h2', {}, 'Custom Entries'),
        el('div', {}, msg),
        el('div', { class: 'alce-btns' },
          el('button', { class: 'alce-btn primary', onclick: () => overlay.remove() }, 'OK')),
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
    db.entries[id] = rec;
    saveDB();
    // The server would create a "plans to watch/read" (or "completed")
    // activity for a fresh entry; mirror that locally.
    recordListActivity(rec, null, 0);
    console.log(TAG, 'created custom entry', rec);
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
        const m = origPath.match(/^\/(anime|manga|character|activity)\/(\d+)|^\/edit\/(anime|manga)\/(\d+)/);
        const id = m ? parseInt(m[2] || m[4], 10) : NaN;
        if (isCustomId(id) && (recById(id) || findCharOwner(id) || activityById(id))) {
          const app = document.querySelector('#app');
          const router = app && app.__vue__ && app.__vue__.$router;
          if (router) {
            console.log(TAG, 'self-healing 404 for', origPath);
            router.replace(origPath);
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
