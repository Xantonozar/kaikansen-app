# AGENTS.md — Kaikansen mobile (`kaikansen-app`)

Instructions for any coding agent working in this repo. Read `HANDOFF.md` for the
full project state and the spec package (below) before writing code.

## What this is

Native Android app for Kaikansen (anime theme songs) with a new dedicated
backend — "Approach B": the existing Next.js website stays the website; this
repo holds the app and its own backend, and **both share the website's
database**.

- `apps/mobile` — Expo React Native + TypeScript (Expo Router), Android only.
- `apps/api` — NestJS + TypeScript. Ports the website's behaviour; serves the app.
- `packages/contracts` — shared TypeScript types/DTOs for both sides. Build it first.

Current state: the Gate 5 prototype (scaffold, read path, auth) is built and
verified. **The v1 build has not started.** See `STATUS.md` and `HANDOFF.md`.

## Commands (from repo root, npm workspaces)

```bash
npm install                              # install all workspaces
npm run build                            # build contracts, then api
npm run test:api                         # API unit tests (jest)
npm run test:e2e -w @kaikansen/api       # API e2e tests (jest)
npm run dev:api                          # Nest watch mode — port 4000, Swagger at /docs, GET /health
npm run dev:mobile                       # Expo start
npm run typecheck:mobile                 # tsc --noEmit for the app
```

Definition of done for any change: API unit **and** e2e suites green, mobile
typecheck clean.

API env (see `apps/api/.env.example`): `PORT`, `MONGODB_URI`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`. `MONGODB_URI` must be a **real environment variable**,
not only a `.env` entry — modules read it at evaluation time. With no DB
configured the API still boots: `/health` answers 200, data endpoints answer 503.

## Non-negotiable rules

1. **The database is shared with the live website.** The API connects to the
   website's production Atlas database (Cluster0, database `kaikansen`).
   Schema compatibility is sacred: never run destructive migrations, never
   rename/remove fields the website reads, and before **any** write feature
   ships, port the web's cross-model Mongoose middleware hooks and denormalised
   counters faithfully — the website's data integrity depends on them.
2. **Parity comes from the web source, not from invention.** Behaviour
   (validation, error shapes, search semantics, quiz rules) is defined by the
   website's code. Canonical repo: `ZadidSalman/Kaisen`. A read-only snapshot
   is kept at `~/workspace/kaikansen-mobile/fresh-start/kaisen-src/` — check it
   before implementing any behaviour. Where the web's behaviour is a quirk,
   mirror the quirk and note it; do not silently "fix" it.
3. **Design comes only from the spec.** All colours, typography, spacing and
   component shapes come from the design tokens in
   `~/workspace/kaikansen-mobile/fresh-start/specs/DESIGN.md` (dark by default;
   light ships in full). No ad-hoc styling values.
4. **Tests stay green.** Every change lands with the API jest unit + e2e suites
   passing and the mobile typecheck clean. New behaviour gets new tests.
5. **Git discipline.** Commit on `main`, in small vertical slices with clear
   messages. **Never push without the owner's explicit instruction** (the first
   push has extra steps — see `HANDOFF.md`).
6. **Secrets never appear in code, chat, or docs.** Env vars only. For
   production, generate **fresh** `JWT_SECRET` / `JWT_REFRESH_SECRET` — the
   values saved in the owner's vault from the web project are placeholders /
   weak and must not be reused.

## Spec package (outside this repo)

`~/workspace/kaikansen-mobile/fresh-start/specs/`:

- `PROJECT_BRIEF.md` — what/why, scope, tier (Large / high-risk).
- `REQUIREMENTS.md` — the parity requirements the v1 build must satisfy.
- `ARCHITECTURE.md` — system shape, module port map, shared-DB contract.
- `SECURITY_PRIVACY.md` — auth/token rules, privacy position.
- `DECISIONS.md` — locked decisions D-01–D-14 and open items O-01–O-11
  (O-12 closed). **Check the open items before assuming freedom on those topics.**
- `UI_UX.md` + `DESIGN.md` — design source and the passed design spec.
- `../AUDIT.md` — the full audit of the web codebase + database ground truth.
