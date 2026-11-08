# STATUS — kaikansen-app (build log)

Condensed log. Full planning history: `~/workspace/kaikansen-mobile/fresh-start/STATUS.md`.
Instructions for coding agents: `AGENTS.md`. Project state: `HANDOFF.md`.

## 2026-11-07 — Reset

- Previous mobile build (based on the wrong web repository) wiped on the
  owner's order, local + GitHub, **no backup**. Repo reduced to the owner's
  original `README.md` under a fresh git history (`e0c7f98`). Planning restarted
  against the real web repo, `ZadidSalman/Kaisen`.

## 2026-11-07 — Planning gates (all passed)

- **Gate 0** — Brownfield; Approach B (Expo app + new separate backend); tier Large / high-risk.
- **Gate 1** — Full parity in one v1 · Android only · auth parity incl. AniList · full offline downloads · direct APK only.
- **Gate 2** — Shared Atlas DB (Cluster0 / `kaikansen`) · NestJS + TypeScript · own Socket.IO.
  Database verified by inspection: 20 collections, themecaches 13,880 docs, users 8, embeddings null / no vector index.
- **Gate 3** — Spec package (6 docs, `fresh-start/specs/`) passed as drafted.
- **Gate 4** — DESIGN.md passed as drafted; dark by default; proposals P-01–P-20 adopted.
- **Gate 5** — Prototype (below) accepted by the owner.

## 2026-11-07 — Gate 5 prototype (local commits, not pushed)

| Commit | Slice | Verification |
|---|---|---|
| `ddba716` | Slice 0 — monorepo scaffold: NestJS 11 API (health + Swagger), Expo SDK 58 shell with locked dark design, contracts stub | Root install OK; API build + jest pass; live boot `/health` 200, `/docs-json` 200; mobile tsc + expo export (android) OK |
| `8ebb7f8` | Slice 1 — read path: ThemeCache read model + `/home`, `/themes/:slug`, `/search`; mobile Home/detail/search on 20-doc real fixture | Jest 21/21 unit + 5/5 e2e; mobile tsc + export OK; API boots DB-less (`/health` 200, data 503) |
| `8c0ca4a` | Search parity fix — web's two-stage regex search ported from source (replaces an initial `$text` stage that contradicted the audit) | Jest 24/24 unit + 5/5 e2e |
| `dbe7b17` | Slice 2 — auth: register/login/refresh/me (bcrypt-12 parity, refresh-in-body + rotation); mobile session + Settings + Dark/Light toggle | Final Gate 5 re-run: **API jest 41/41 unit + 19/19 e2e**; mobile tsc clean; expo export OK |

Prototype limits: no live Atlas run yet (dev sandbox network blocks direct
Atlas connections — first live proof at deployment); mobile uses real-data
fixtures locally; no write path, quiz, downloads, or AniList flow yet.

## 2026-11-07 (night) — v1 parity build started on the owner's order

- **Slice S1 — API user library + `/auth/me` AniList fields.** New
  `library` module: favourites (add/remove/list/state, `favorites`
  collection, web ordering quirk kept), watch history (record/list,
  WatchHistory hook counters ported: theme totalWatches/totalListens,
  user totalTime), ratings (get/set/clear, Rating hook aggregate
  recompute ported; clear has NO web equivalent — hook-faithful
  recompute + totalRatings reversal, flagged in code). `/auth/me` (and
  every profile) now carries `anilist: {userId, username} | null`,
  the web /api/users/me shape, so the app can persist linked state.
  User schema gained the web's `totalTime` field (sampled prod doc
  predated it). Verification: **API jest 140/140 unit + 58/58 e2e**,
  root build green, mobile typecheck clean.
- **Slice M1 — mobile real playback.** New `player` route under
  `(drawer)` on expo-video (~58.0.13, via `npx expo install`): one
  player serves Watch (entry's highest-resolution video source, the
  web's ordering) and Listen (entry `audioUrl`, theme-level fallback;
  audio-only presentation — artwork over a hidden surface). Custom
  icon-led controls: play/pause/replay, tap-to-seek + time labels,
  fullscreen (watch), close; buffering spinner and honest error +
  retry states. Detail screen wired: Watch/FAB/version tiles open
  the player for the selected entry (tiles now select too), Listen
  disabled when the entry has no audio (web parity). On first genuine
  playback start per entry+mode, the player fires S1's
  `POST /library/history` (recordWatch in api.ts; no-ops in fixture
  mode and signed-out). Leaving the screen pauses/releases — no
  background audio, no PiP in this slice. Verification: mobile tsc
  clean, `expo export --platform web` OK (player route bundles).
- **Slice M2 — mobile real Library + save/rating actions.** The Library
  tab is real: Saved / Recent / Playlists behind one segmented control,
  all fetched on focus. Saved lists favorites (paged, load-more) with
  unsave-in-place; Recent renders watch history (mode · relative time;
  play replays in the recorded mode/entry; a theme that left the
  catalogue degrades to a muted line); Playlists lists mine (cover,
  count, public/private chip) with an inline create form. New route
  `playlist/[id]` (hidden drawer screen): items in stored order,
  owner-only rename (inline), visibility toggle, item removal and
  two-tap-confirm delete; the read stays public per the API. Save
  actions everywhere: a shared favorites store (`src/favoritesStore.ts`,
  session.ts pattern — membership loaded once per session, optimistic
  toggles with rollback, per-slug in-flight guard, in-flight-load
  overlay) drives the new ThemeRow bookmark tile on Home/Search/Library/
  playlist rows; the detail screen's bookmark is the same toggle seeded
  by the exact per-slug check. ThemeRow also gained an opt-in play
  target (Library rows open the player; Home/Search tiles keep opening
  the theme) and an opt-in remove tile. The detail screen's Add square
  opens an add-to-playlist sheet (membership resolved per playlist,
  duplicates reported in place, create-and-add inline), and a rating
  card under the facts carries the caller's own 1–10 rating (set/clear
  via S1's endpoints; the fact row's aggregate refreshes from each
  rating response; signed-out gets a log-in prompt, demo mode an
  honest note). New client module `src/libraryApi.ts` over api.ts's
  new exported `apiJson` (server messages surface verbatim; fixture
  mode reads resolve empty and writes reject with a demo-mode
  message — a demo library stores nothing). Verification: mobile tsc
  clean, `expo export --platform web` OK (library + playlist `[id]`
  chunks bundle), API suites untouched and green (261 unit + 91 e2e).

- **Slice M3 — mobile offline downloads.** Mobile-only capability
  (the website is a browser app; nothing to mirror) filling the Gate 1
  "full offline downloads" requirement and the mockup's Library
  Offline tab. New engine `src/downloads.ts` (favoritesStore pattern):
  a download targets one theme ENTRY in one mode and fetches exactly
  the file the player would stream (`src/playback.ts` URL choice —
  audio for listen, best video for watch) via expo-file-system's SDK
  58 `File.downloadFileAsync` with percent progress (throttled to
  whole percents). Files live in `<document>/downloads/`; a JSON
  index in plain AsyncStorage (`kaikansen.downloads.v1`) stores the
  metadata snapshot (song/anime/artist/version/cover, size, date) so
  the Library and player work with no network. Entry points: the
  detail screen's new download square (state: idle / % / downloaded
  check) opens a per-entry sheet with a Watch and a Listen row —
  each row downloads, retries, or deletes independently; the Library
  gains a fourth segment, Offline (total storage shown, per-item
  delete, tap plays). The player prefers a completed download's local
  file over the remote URL (header shows an "Offline" chip) and, keyed
  off the route's entry id, opens fully offline from the snapshot
  when the catalogue fetch fails; history recording is untouched.
  Downloads are local, hence available signed-out; demo mode and web
  answer with the honest unavailable note (web presents the segment
  as unavailable; all FS access is platform-gated so the web bundle
  is unaffected). Robustness: failures delete partials and surface
  the real error; hydration re-verifies every indexed file (missing
  → record flagged broken/removable, sizes refreshed) and sweeps
  orphan files no record points at; the Library re-checks on focus.
  Foreground-only: no pause/resume, no cancel, no size cap.
  Verification: mobile tsc clean, `expo export --platform web` and
  `--platform android` OK, API suites untouched and green
  (261 unit + 91 e2e).

## Current state

**Gate 6 handoff APPROVED by ozar 2026-11-07 — planning closed (Gates 0–6 all passed). v1 parity build STARTED 2026-11-07 night on the owner's order ("make it 100% ready"); Slice S1 (API user library) done, further slices in progress.**
