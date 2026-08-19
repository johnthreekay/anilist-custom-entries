'use strict';
const { grabFunction, grabBetween, evalBlock, makeExpect, isCustomId } = require('./lib');
module.exports = function () {
  const { expect, done } = makeExpect('notifs');
  const now = 1_800_000_000;
  const db = { seq: 10, entries: {} };
  const store = {};
  const code = [grabFunction('airingScheduleOf'), grabFunction('nextAiringOf'), grabFunction('airingSchedulesResult'), grabFunction('handleSaveAiringSchedule'), grabBetween('  const NOTIF_KEY = ', 'healNotifications')].join('\n');
  const fns = evalBlock(code, {
    ID_BASE: 2000000000, TAG: '[t]', isCustomId, db, nowSec: () => now, authUserId: () => 5, allRecs: () => Object.values(db.entries), recById: (id) => db.entries[id] || null,
    logRevision() {}, touchRec() {}, saveDB() {}, pushRecEntities() {}, mediaEntity: (r) => ({ id: r.id }), vueStore: () => null, entitiesState: () => null,
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } }, console: { log() {} }, location: { pathname: '/home' }, setTimeout: (fn) => fn(),
  }, ['tickNotifications', 'patchNotifications', 'bumpUnreadCount', 'patchViewer', 'nextAiringOf', 'handleSaveAiringSchedule', 'airingSchedulesResult', 'localNotifsFor']);
  const day = 86400;
  // Anime with a weekly schedule: ep1 aired 10 days ago, ep2 3 days ago, ep3 in 4 days.
  const anime = { id: 2000000050, ownerId: 5, type: 'ANIME', entry: { createdAt: now - 30 * day }, media: { status: 'RELEASING', startDate: { year: 2027, month: 6, day: 1 }, endDate: {} } };
  db.entries[anime.id] = anime;
  fns.handleSaveAiringSchedule(anime, { mediaId: anime.id, airingSchedule: [{ airingAt: now - 10 * day, episode: 1 }, { airingAt: now - 3 * day, episode: 2 }, { airingAt: now + 4 * day, episode: 3 }, { airingAt: now + 4 * day, episode: 3 }] });
  expect('schedule stored, deduped, next episode computed', [anime.media.airingSchedule.length, fns.nextAiringOf(anime), fns.airingSchedulesResult(anime).Page.airingSchedules.length], [3, { airingAt: now + 4 * day, timeUntilAiring: 4 * day, episode: 3 }, 3]);
  let added = fns.tickNotifications(true);
  expect('episodes already aired when the schedule was set do not notify', added, 0);
  // Time passes past ep 3: one airing notification.
  anime.media.airingSchedule.push({ airingAt: now - 1, episode: 3 }); anime.media.airingSchedule.splice(2, 1);
  added = fns.tickNotifications(true);
  const mine = fns.localNotifsFor(5);
  expect('aired episode notifies once (idempotent)', [added, fns.tickNotifications(true), mine.length, mine[0].type, mine[0].episode], [1, 0, 1, 'AIRING', 3]);
  // Release-day reminder + status flip for a manga created before its start date (yesterday).
  const d = new Date((now - day) * 1000);
  const manga = { id: 2000000051, ownerId: 5, type: 'MANGA', entry: { createdAt: now - 20 * day }, media: { status: 'NOT_YET_RELEASED', startDate: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() } } };
  // Catalogued after the fact: no reminder, but the status still flips.
  const old = { id: 2000000052, ownerId: 5, type: 'MANGA', entry: { createdAt: now }, media: { status: 'NOT_YET_RELEASED', startDate: { year: 2020, month: 1, day: 1 } } };
  // Other account's entry: status flips, no reminder for the viewer.
  const other = { id: 2000000053, ownerId: 9, type: 'MANGA', entry: { createdAt: now - 20 * day }, media: { status: 'RELEASING', endDate: { year: 2020, month: 1, day: 1 } } };
  db.entries[manga.id] = manga; db.entries[old.id] = old; db.entries[other.id] = other;
  added = fns.tickNotifications(true);
  expect('release-day reminder once, statuses flipped from dates', [added, manga.media.status, old.media.status, other.media.status, fns.localNotifsFor(5).filter((n) => n.type === 'RELATED_MEDIA_ADDITION').map((n) => n.mediaId), fns.tickNotifications(true)], [1, 'RELEASING', 'RELEASING', 'FINISHED', [2000000051], 0]);
  // Viewer badge: served count + local unread, adjusted by difference on re-run.
  const u = { id: 5, unreadNotificationCount: 3 };
  fns.patchViewer({ result: 5, entities: { user: { 5: u } } });
  fns.patchViewer({ result: 5, entities: { user: { 5: u } } });
  expect('nav badge counts local unread (idempotent)', [u.unreadNotificationCount, u.__alceUnread], [5, 2]);
  // Notifications page: unread first, then the served rows; opening marks them read.
  const r = { entities: { page: { 'notifications-all': { pageInfo: { total: 40 }, pageData: [101, 102] } }, notification: { 101: { id: 101, createdAt: now - 2 * day }, 102: { id: 102, createdAt: now - 30 * day } } } };
  fns.patchNotifications(r, { pageId: 'notifications-all', feed: 'all', page: 1 });
  const ids = r.entities.page['notifications-all'].pageData;
  expect('feed: local unread first, entities added, marked read after opening', [ids.length, ids.slice(0, 2).every(isCustomId), ids.slice(2), r.entities.notification[ids[0]].type, fns.localNotifsFor(5).every((n) => n.read)], [4, true, [101, 102], 'AIRING', true]);
  // Read ones merge by time among the served rows; airing feed filters by type.
  const r2 = { entities: { page: { 'notifications-all': { pageInfo: { total: 40 }, pageData: [101, 102] } }, notification: { 101: { id: 101, createdAt: now - 2 * day }, 102: { id: 102, createdAt: now - 30 * day } } } };
  fns.patchNotifications(r2, { pageId: 'notifications-all', feed: 'all', page: 1 });
  const r3 = { entities: { page: { 'notifications-airing': { pageInfo: { total: 1 }, pageData: [101] } }, notification: { 101: { id: 101, createdAt: now - 2 * day } } } };
  fns.patchNotifications(r3, { pageId: 'notifications-airing', feed: 'airing', page: 1 });
  expect('read ones merged by time; airing feed only AIRING', [r2.entities.page['notifications-all'].pageData.map((id) => (isCustomId(id) ? 'L' : id)), r3.entities.page['notifications-airing'].pageData.length, fns.bumpUnreadCount(u), u.unreadNotificationCount], [['L', 'L', 101, 102], 2, true, 3]);
  return done();
};
