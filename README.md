# AniList Custom Entries

Userscript that adds **client-side custom entries** to [AniList](https://anilist.co): doujinshi, web novels, fan works, anything not in the database. They sit in your lists like real entries (status, score, progress, notes, custom lists, favorites, activity feed) and are edited through AniList's own UI. Everything lives in your browser, optionally synced across devices through a private GitHub repo.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) (or any other userscript manager).
2. Open **[anilist-custom-entries.user.js](https://raw.githubusercontent.com/johnthreekay/anilist-custom-entries/main/anilist-custom-entries.user.js)** and confirm. Updates are automatic from then on.

## Use

- On your anime/manga list, next to the random-entry button: **+** creates an entry, **wrench** manages them (list, export/import, GitHub sync, image host).
- <img width="218" height="591" alt="image" src="https://github.com/user-attachments/assets/f7957442-0b1f-4354-8819-73e945095095" />
- The **+** modal searches MangaBaka, MangaDex, Dynasty Reader, RanobeDB and MAL and fills the whole form from a pick (cover, description, tags, characters); everything can also be typed by hand. Create opens the native list editor.
- Custom entries have a working media page and an **Edit Custom Entry** page (AniList's submission form, applied locally).
- Covers from hosts that block or fake hotlinks are embedded automatically, or uploaded to a self-hosted image server if you configure one.
