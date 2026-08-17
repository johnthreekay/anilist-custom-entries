# AniList Custom Entries

Userscript that adds **client-side custom entries** to [AniList](https://anilist.co): doujins, web novels, fan works, anything not in the database. They sit in your lists like real entries (status, score, progress, notes, custom lists, favourites, activity feed) and are edited through AniList's own UI. Nothing is ever sent to AniList's servers; everything lives in your browser, optionally synced across devices through a private GitHub repo.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) (or Tampermonkey).
2. Open **[anilist-custom-entries.user.js](https://raw.githubusercontent.com/johnthreekay/anilist-custom-entries/main/anilist-custom-entries.user.js)** and confirm. Updates are automatic from then on.
3. Open your anime or manga list once.

## Use

- On your list page, next to the random-entry die: **+** creates an entry, **wrench** manages them (list, export/import, GitHub sync, image host).
- The **+** modal searches MangaBaka, MangaDex, Dynasty Reader, RanobeDB and MAL and fills the whole form from a pick (cover, description, tags, characters); everything can also be typed by hand. Create opens the native list editor.
- Custom entries have a working media page and an **Edit Custom Entry** page (AniList's submission form, applied locally).
- Covers from hosts that block or fake hotlinks are embedded automatically, or uploaded to a self-hosted image server if you configure one.

## More

Everything else (import sources, sync and encryption, image hosting, how the interception works, limitations) is in **[LLMS.md](LLMS.md)**.
