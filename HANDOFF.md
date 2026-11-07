# HANDOFF — Kaikansen mobile (fresh start)

- **Date:** 2026-11-07
- **State:** Gates 0–5 PASSED. This package is Gate 6 (handoff). Planning is
  complete; **the v1 build has not started** and starts only on the owner's
  instruction.

## Planning state

| Gate | Result (all 2026-11-07) |
|---|---|
| 0 — Classification | Brownfield. Approach B: Expo RN app + NEW separate backend porting the real Kaisen behaviour. Tier: Large / high-risk. |
| 1 — Requirements | Full feature parity in ONE v1 · Android only · auth parity (email/password + AniList login + linking) · full offline downloads · success = complete, polished app · direct APK only, no store. |
| 2 — Architecture inputs | Shared Atlas database (Cluster0 / `kaikansen`) · NestJS + TypeScript backend · own Socket.IO for quiz realtime (website keeps Pusher; no web↔mobile shared rooms). |
| 3 — Spec package | Six docs drafted from locked decisions only, passed as drafted. |
| 4 — Design | DESIGN.md passed as drafted; theme = dark by default; proposals P-01–P-20 adopted. |
| 5 — Prototype | Three slices built + verified (below); accepted by the owner. |

## Spec map — `~/workspace/kaikansen-mobile/fresh-start/specs/`

- `PROJECT_BRIEF.md` — framing, constraints, gate history.
- `REQUIREMENTS.md` — parity requirements with stable IDs (FR-AUTH/HOME/PLAY/LIB/SOC/QUIZ/RANK/SEARCH/DL, NFR-01–05) + the verified DB counts they rest on.
- `ARCHITECTURE.md` — three-runtimes/one-database shape, module port map of the web's 63 route files, shared-database contract, auth + Socket.IO design.
- `SECURITY_PRIVACY.md` — web parity baseline (bcrypt 12, 15 min access / 7 day refresh JWTs), SEC-01–07.
- `DECISIONS.md` — locked log D-01–D-14, open items O-01–O-11 (O-12 closed), evidence gaps (§5).
- `UI_UX.md` — extracted design source from the website. `DESIGN.md` — the passed Gate 4 design spec (tokens, shell, 20 screen specs, P-01–P-20).
- `../AUDIT.md` — full audit of `ZadidSalman/Kaisen` + DB ground truth (2026-11-07): 20 collections; themecaches 13,880 docs; users 8; `embedding` field present but null, no vector index.
- `../STATUS.md` — the full dated planning/build log.

## Prototype state (this repo, local commits — NOT pushed)

| Commit | Contents |
|---|---|
| `ddba716` | Slice 0 — monorepo scaffold: NestJS 11 API (health + Swagger), Expo SDK 58 shell with the locked dark design (header, 4-tab pill nav), contracts stub. |
| `8ebb7f8` | Slice 1 — read path: ThemeCache read model (38 fields, no hooks) + `GET /home`, `/themes/:slug`, `/search`; mobile Home / theme detail / search on a 20-doc real-data fixture. |
| `8c0ca4a` | Search parity fix — ported the web's actual two-stage **regex** search (modifier parsing, prefix narrowing, `searchType: 'regex'` envelope) after an initial `$text` implementation contradicted the audit. |
| `dbe7b17` | Slice 2 — auth: register/login/refresh/me with bcrypt-12 parity, refresh token in body + rotation, mobile session (secure-store / AsyncStorage), Settings with Dark/Light toggle, labelled demo mode in fixture mode. |

**Verification (final Gate 5 re-run):** API jest **41/41 unit (4 suites) +
19/19 e2e (3 suites)**; mobile `tsc --noEmit` clean; `expo export --platform
android` succeeds; API boots with no DB (`/health` 200, data endpoints 503).

**What the prototype does NOT prove:**

- **No live Atlas run yet.** The development sandbox's network blocks direct
  Atlas connections (SRV/TLS egress), so API↔DB behaviour is verified with
  mocked-model tests; the query shapes themselves were executed live against
  Atlas through the MCP connector (counts/shape confirmed). The first true
  live API↔Atlas proof happens at deployment.
- Mobile runs on **real-data fixtures** locally (20 popular themes pulled from
  production), not a live API.
- No on-device run; no APK build in the sandbox (Android SDK egress blocked).
- No write path, no quiz/Socket.IO, no downloads, no AniList flow — all v1 work.

## Known deviations (prototype, on record)

- Register: `displayName` is **optional** here (defaults to username); the web
  **requires** it. Small parity deviation — settle in v1.
- Refresh rotation is **stateless, no revocation** (web parity is also
  stateless; a fuller session policy is open item O-10).
- `GET /search` serves the **songs view only**; the web also groups
  artists/anime/users — multi-entity search is v1 work.
- `MONGODB_URI` must be a real env var, not `.env`-only (module-evaluation timing).
- Outfit ships **no italic cut** — the wordmark's italic is platform-synthesised
  (noted in `apps/mobile/src/theme.ts`).
- Web quirks mirrored deliberately: duplicate register returns one
  indistinguishable 409; login email matching is case-sensitive, like the web.

## OPEN items (from DECISIONS.md — owner's to decide)

- **O-01 AniList client:** pick the mobile client before building the handoff
  flow. An unused client **56177 ("Kaikansen Mobile")** already exists and is
  available; the web's client **39595 must NOT be touched** (its single redirect
  URI points at the web callback).
- **O-02 Push notifications:** web has none; in v1 or not is undecided.
- **O-03 Hosting:** Render free vs Starter undecided (see deployment notes).
- **O-04 Quiz timer authority:** web timers are client-reported (abusable);
  server-authoritative timers are recommended, not decided.
- **O-05 AniList token storage:** web stores tokens in plaintext on the user
  doc; improving it touches shared data — needs coordination, not a unilateral change.
- **O-06 Account deletion:** no endpoint exists on web; not store-mandated (direct APK); decide for v1.
- **O-07 Cron ownership:** leaderboard-snapshot / season-reset run on the web
  (CRON_SECRET-guarded; schedules live in the Vercel dashboard). Exactly one
  owner — **never double-run** against the shared aggregates.
- **O-08 Semantic search:** OUT of v1 — embeddings are null and no vector index
  exists; re-enters only as a separate data-population project.
- **O-09 Streaming path:** native direct from animethemes.moe vs via the new
  backend — implementation-stage decision.
- **O-10 Session policy:** lifetimes / rotation / reuse detection / device
  sessions beyond web parity are undecided.
- **O-11 In-app update mechanism:** direct-APK distribution makes update
  checking the app's own concern; no mechanism chosen yet.
- O-12 (repository layout) is **closed** — D-14: this monorepo.

## Deployment notes

- API env: `PORT`, `MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET` —
  generate the JWT secrets **fresh** for production.
- Database: Atlas Cluster0, database `kaikansen`, in the owner's **AUST-email**
  Atlas org ("SALMAN's Org - 2024-12-20", Project 0) — the same database the
  live website uses.
- Two Render services from a wiped earlier attempt — `kaikansen-api` and
  `kaikansen-web-preview` — still run their last deploys, but their source repo
  was deleted (dead link). Reconnect or recreate them at deployment; don't
  assume they're wired to this repo.
- Database inspection without code: the Atlas MCP connector is documented at
  `~/workspace/custom-connectors/custom.mongodb-atlas-mcp/CONNECTOR.md`
  (configuration "mayo-kaikansen", read/write role, secret expires 2027-02-05);
  its credentials live in the owner's EnvGuard, never on disk.

## First push (NOT done yet)

GitHub repo `Xantonozar/kaikansen-app` exists and holds GitHub's **default
template README**; the local `README.md` is the owner's **original text**.
Reconcile the two on the first push (keep the owner's text). Until then, all
commits are local only.

## Suggested v1 build order (suggestion, NOT a decision)

1. Live-DB wiring + deployment proof (close the prototype's one unproven link).
2. Write-path models with full hook/counter fidelity (playlists, ratings,
   library, comments, social writes).
3. Remaining parity features in REQUIREMENTS.md order.
4. Quiz on Socket.IO (decide O-04 first).
5. Offline downloads.
6. AniList login + linking (decide O-01 first).
7. In-app update mechanism (O-11) + release packaging.
