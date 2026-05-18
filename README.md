# Mesh

> The second brain that builds itself, and makes every AI agent yours.

EU-first, RGPD-by-design memory platform for AI agents. B2C product (priority), with B2B SDK planned for V2.

See [Mesh_B2C_Technical_Spec_v1.0.md](./Mesh_B2C_Technical_Spec_v1.0.md) for the full technical spec.

## Repo layout

```
mesh/
├── apps/
│   ├── web/            React + Vite + Tailwind dashboard (timeline, search, settings)
│   └── extension/      WXT extension (Chrome MV3 + Firefox) — capture + injection
├── packages/
│   ├── shared/         TS types, zod schemas, constants (tier quotas, blocked domains)
│   └── mcp-server/     MCP server for Claude Desktop / Cursor integration
├── supabase/
│   ├── config.toml     Local Supabase config
│   ├── migrations/     SQL migrations (RLS-enforced)
│   └── functions/      Deno Edge Functions (nodes, search, inject, process-node)
└── Mesh_B2C_Technical_Spec_v1.0.md
```

## Prerequisites

- Node.js >= 20.10
- pnpm >= 9.0 (`npm i -g pnpm`)
- Supabase CLI (`npm i -g supabase` or `brew install supabase/tap/supabase`)
- Docker (used by Supabase locally)

## Two modes of running

### Mock mode (default, zero backend)

Web dashboard runs entirely on in-memory mocks. No Supabase, no API keys, no Docker. Good for UI dev and demos.

```powershell
pnpm install
pnpm --filter @mesh/web dev
# → http://localhost:5173 — open the dashboard immediately
```

### Real backend mode

Flip `VITE_USE_MOCK=false` in `apps/web/.env.local`, then run Supabase + Edge Functions. Mocks are disabled and the UI calls real endpoints.

## Setup

```bash
# 1. Install all workspace deps
pnpm install

# 2. Copy env templates
cp .env.example .env.local
cp apps/web/.env.example apps/web/.env.local
cp supabase/.env.local.example supabase/.env.local

# 3. Start Supabase locally (Postgres + Auth + Storage + Edge Functions)
pnpm supabase:start
# This prints anon key & service_role key — paste them into:
#   .env.local
#   apps/web/.env.local (VITE_SUPABASE_ANON_KEY)
#   supabase/.env.local

# 4. Get free API keys for AI providers:
#    - Jina:     https://jina.ai (free tier 1M tokens)
#    - Groq:     https://console.groq.com (free)
#    Paste into supabase/.env.local

# 5. Serve Edge Functions (separate terminal)
pnpm supabase:functions:serve

# 6. Run the web dashboard (separate terminal)
pnpm --filter @mesh/web dev
# → http://localhost:5173

# 7. Build the extension (separate terminal)
pnpm --filter @mesh/extension dev
# Then load apps/extension/.output/chrome-mv3 in chrome://extensions
```

## Smoke test

Once everything is up, sign in with magic link at http://localhost:5173/login (use the Inbucket dev mailbox at http://127.0.0.1:54324).

Then test the API directly:

```bash
# get JWT from browser devtools → supabase.auth.session
export JWT="..."
export API="http://127.0.0.1:54321/functions/v1"

# Create a node
curl -X POST "$API/nodes" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"content":"Met Sophie about Project Falcon. Deadline June 15.","source":"manual"}'

# Search
curl -X POST "$API/search" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"query":"Sophie deadline","top_k":3}'

# Inject
curl -X POST "$API/inject" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"query":"help me write to Sophie","target_agent":"claude.ai"}'
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run all apps in parallel |
| `pnpm build` | Build everything |
| `pnpm typecheck` | TS typecheck across workspace |
| `pnpm lint` | Lint all packages |
| `pnpm format` | Prettier write |
| `pnpm supabase:start` | Start local Supabase stack |
| `pnpm supabase:reset` | Drop & re-apply migrations + seed |
| `pnpm supabase:functions:serve` | Serve Edge Functions |

## Tech stack

- **Frontend**: React 18, Vite, TanStack Query, Zustand, Tailwind
- **Extension**: WXT (MV3 + Firefox), Dexie (IndexedDB)
- **Backend**: Supabase Edge Functions (Deno), PostgreSQL 16 + pgvector (HNSW) + tsvector
- **AI**: Jina v3 (embeddings), Groq llama-3.1-8b/3.3-70b (NER + summary), DeepSeek reasoner (insights)
- **Auth**: Supabase Auth (magic link, RS256 JWT)
- **Hosting target**: Supabase Frankfurt (EU) + Vercel/Cloudflare Pages

## Implemented modules (status)

| Module | Status |
|---|---|
| DB schema + RLS policies | ✅ Migrations 1–6 |
| Auth (magic link, OAuth providers) | ✅ Supabase Auth |
| `POST /nodes` + async pipeline | ✅ NER + summary + embed + edge inference |
| `POST /search` hybrid (dense + sparse) | ✅ |
| `POST /inject` with Context Rules | ✅ Engine + ACL + redact + log |
| `process-node` worker | ✅ Concurrent NER/summary/embed |
| Edge inference | ✅ `_shared/edges.ts` — freq + freshness + cosine |
| Context Rules CRUD | ✅ `/rules` endpoint + UI page |
| Connector — Gmail OAuth + sync | ✅ `connectors-gmail-auth` + `connectors-gmail-sync` |
| Stripe Checkout + Customer Portal | ✅ `billing-checkout` + `billing-portal` |
| Stripe webhooks (sub created/updated/deleted) | ✅ `billing-webhook` with signature verify |
| Account export (RGPD Art. 20) | ✅ `account-export` + SQL function |
| Account deletion (RGPD Art. 17 + 72h grace) | ✅ `account-delete` + `account-wipe-worker` |
| Rate limiting (sliding window, Upstash) | ✅ `_shared/ratelimit.ts` |
| Cron jobs (TTL, FIFO, wipe, connector sync) | ✅ Migration `20260517000002_cron_jobs.sql` |
| Web dashboard (Timeline / Search / Graph / Rules / Connectors / Settings / Onboarding) | ✅ |
| Graph Explorer (Cytoscape + fcose) | ✅ Force-directed, color by source, side panel |
| Extension (capture + scorer + injection overlay) | ✅ Reading + AI session signals, DOM injection |
| MCP server (Claude Desktop / Cursor) | ✅ `@mesh/mcp-server` |
| RLS tests (pgTAP) | ✅ Nodes, audit, rules, connectors |
| Edge unit tests (Deno) | ✅ Rules engine + edge inference math |
| **Mock mode** (`VITE_USE_MOCK=true`) | ✅ UI runs without backend |

## Roadmap

| Phase | What | When |
|---|---|---|
| P0 | DB + auth + nodes/search Edge Functions | Weeks 1–3 |
| P1 | Extension capture (6 signals + scorer) | Weeks 4–8 |
| P2 | Web app (timeline, search, settings, billing) | Weeks 9–12 |
| P3 | Cross-agent injection (killer feature) | Weeks 13–18 |
| P4 | Connectors (Gmail, Calendar, Slack, Notion) | Weeks 19–24 |
| P5 | Public launch (PH + HN) | Weeks 25–32 |

See spec section 15 for details.

## Privacy stance

- All data in EU (Supabase Frankfurt).
- No ads, no data resale — ever. Enforced contractually and architecturally.
- Right to be forgotten in 72h (`DELETE /v1/account`).
- Audit log immutable (INSERT-only via RLS).
- Sensitive domains blocked by default in extension (mail, banking, healthcare, gov).

## License

Proprietary — all rights reserved (pre-launch). License will be decided at public launch.
