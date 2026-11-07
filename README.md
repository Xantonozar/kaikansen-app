# kaikansen-app

Monorepo for the **Kaikansen mobile app** (Android) and its dedicated backend —
a fresh-start rebuild (Nov 2026) that ports the behaviour of the existing
Kaikansen web app. The website stays in its own repo and is untouched; this
repo's backend **shares the website's database**.

| Piece | Path | Stack |
|---|---|---|
| Mobile app | `apps/mobile` | Expo React Native + TypeScript (Expo Router) |
| API | `apps/api` | NestJS + TypeScript + Mongoose |
| Shared contracts | `packages/contracts` | TypeScript DTOs — build first |

- **Web app (canonical):** `ZadidSalman/Kaisen` — Next.js, live at
  [kaiseen.vercel.app](https://kaiseen.vercel.app).
- **State:** planning Gates 0–6 passed; the Gate 5 prototype (scaffold, read
  path, auth) is built and verified. The v1 build has not started.
- **Start here:** `HANDOFF.md` (full project state), `STATUS.md` (build log),
  `AGENTS.md` (commands + non-negotiable rules for contributors/agents).

## Commands (from repo root)

```bash
npm install
npm run build                  # contracts, then api
npm run test:api               # API unit tests
npm run test:e2e -w @kaikansen/api
npm run dev:api                # Nest watch — port 4000, /health, Swagger /docs
npm run dev:mobile             # Expo start
npm run typecheck:mobile
```

API env: see `apps/api/.env.example` (`PORT`, `MONGODB_URI`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`). With no database configured the API still boots —
`/health` answers 200 and data endpoints answer 503.
