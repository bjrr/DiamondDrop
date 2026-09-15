# CaratForUs App — Local Development

This is the CaratForUs MVP1 custom application: a single Node 20 + TypeScript
React Router service. See `../CLAUDE.md`, `../docs/ARCHITECTURE-MVP1.md`, and
`../docs/specs/` for requirements and architecture. This README covers local
setup only.

No live Shopify credentials are required to run Slice 0 locally (see open
decision D1 in `docs/ARCHITECTURE-MVP1.md` §12) — placeholder values in
`.env` are sufficient.

## Prerequisites

- Node.js 20+
- Postgres 16 — via Docker (below) or a local install (see "Without Docker")

## Setup

```sh
cd app
cp .env.example .env
npm install
docker compose -f ../docker-compose.yml up -d
npm run db:generate
npm run db:migrate:dev
npm run db:seed
npm run dev
```

Visit `http://localhost:5173/health` — it should report `"status": "ok"`
with the applied migration list. 5173 is Vite's default; `npm run dev` does
not override it. The production server (`npm start`,
`react-router-serve`) listens on 3000 instead, or on `PORT` if set.

### Without Docker

Docker Desktop needs the WSL2 backend, which is not available on every
machine. Any Postgres 16 reachable at the `DATABASE_URL` in `.env` works
just as well — the app and the tests only ever talk to it over TCP. EDB
publishes a binaries-only zip that installs without administrator rights:

```sh
# one-time: extract the zip, then initialise a cluster owned by `carat`
initdb -D <data-dir> -U carat --pwfile=<file-containing-the-password> -E UTF8 --locale=C
pg_ctl -D <data-dir> -l <log-file> -o "-p 5432 -c listen_addresses=localhost" start
createdb -h localhost -p 5432 -U carat carat_dev
```

Use the same credentials as `docker-compose.yml` (`carat` /
`carat_dev_password` / `carat_dev`) and the committed `.env.example`
`DATABASE_URL` works unchanged. Then continue from `npm run db:generate`
above. Stop the server with `pg_ctl -D <data-dir> stop`.

## Common commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the React Router dev server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest, no database) |
| `npm run test:integration` | Integration tests against real Postgres (requires `DATABASE_URL` and a migrated database) |
| `npm run check:money-safety` | Repository-wide scan for ad-hoc `Math.round`/`floor`/`ceil` on money |
| `npm run db:migrate:dev` | Create/apply a new migration locally |
| `npm run db:migrate` | Apply existing migrations (CI/deploy) |
| `npm run db:seed` | Seed sample data |

## Module layout

```
app/                React Router framework source
  domain/           Pure functions, no I/O (money, evidence, idempotency)
  db/                Prisma client + repositories (create/read only for evidence tables)
  shopify/           Webhook verification/dedup, App Proxy signature verification
  routes/            React Router routes (health, webhook endpoints)
  jobs/              Scheduled job entry points (empty this slice)
  lib/               Env validation, structured logging, shared zod request helpers
prisma/              Schema + forward-only migrations
scripts/             Repository-wide checks (money safety)
```

Tests are colocated as `*.test.ts` next to the code they cover (unit) or
under `/tests/integration` (require Postgres).
