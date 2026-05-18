# Mesh deployment status

**Project:** `mtujmgramjyvjjhrcitl` (dotmesh) — Frankfurt
**Last sync:** $(today)

---

## ✅ Done (by me)

- [x] CLI auth verified — already logged in
- [x] Project linked: `npx supabase link --project-ref mtujmgramjyvjjhrcitl`
- [x] Fixed `config.toml` (Postgres major_version 16 → 17)
- [x] **18 migrations applied** — schema fully provisioned
- [x] Fixed all Deno bare imports (`@supabase/supabase-js` → `npm:@supabase/supabase-js@2.45.4`, same for `zod` and `groq-sdk`)
- [x] **34 Edge Functions deployed** to `https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/`
- [x] `apps/web/.env.local` updated → `VITE_USE_MOCK=false`, real backend wired
- [x] Mock fallbacks remain in the code but are dead branches when the flag is off (zero runtime impact)

You can verify by hitting:
- https://supabase.com/dashboard/project/mtujmgramjyvjjhrcitl/database/tables (18 tables visible)
- https://supabase.com/dashboard/project/mtujmgramjyvjjhrcitl/functions (34 deployed)

---

## ⚠️ 3 steps left — **only you can do them** (need keys / dashboard access)

### Step 1 — Edge Function secrets (BLOCKING for AI features)

Without these, embedding/NER/chat/agents will all fail silently.

Get the keys (free tier accounts work for everything):

| Service  | Where                                               | What you need        |
|----------|-----------------------------------------------------|----------------------|
| Jina     | https://jina.ai/embeddings/ → Get API key           | `JINA_API_KEY`       |
| Groq     | https://console.groq.com/keys                       | `GROQ_API_KEY`       |
| DeepSeek | https://platform.deepseek.com (optional)            | `DEEPSEEK_API_KEY`   |

Then in a PowerShell at the repo root:

```powershell
npx supabase secrets set `
  JINA_API_KEY=jina_xxx `
  GROQ_API_KEY=gsk_xxx `
  PUBLIC_WEB_URL=http://localhost:5173
```

(You can add DEEPSEEK later for weekly insights; not needed for chat/agents day 1.)

Verify:
```powershell
npx supabase secrets list
```

### Step 2 — Vault secrets (BLOCKING for cron jobs)

The 3 cron HTTP jobs (connector syncs, agent schedulers, account wipe) are currently NOT scheduled because the Vault secrets `project_url` + `service_role_key` were missing when the migration ran.

Either go to https://supabase.com/dashboard/project/mtujmgramjyvjjhrcitl/settings/vault and add via UI:

| Secret name        | Value                                                         |
|--------------------|---------------------------------------------------------------|
| `mesh_token_key`   | A 32+ char random string (see DEPLOY_NOW.md to generate)      |
| `project_url`      | `https://mtujmgramjyvjjhrcitl.supabase.co`                    |
| `service_role_key` | From Settings → API → **service_role secret**                 |

Then re-apply the cron migrations only:

```powershell
npx supabase db push
```

You can also drop the secrets via SQL in the dashboard SQL editor:

```sql
SELECT vault.create_secret('https://mtujmgramjyvjjhrcitl.supabase.co', 'project_url', 'Project URL');
SELECT vault.create_secret('<paste service_role_key here>', 'service_role_key', 'Service role key');
SELECT vault.create_secret('<paste 32+ char random>', 'mesh_token_key', 'Token encryption key');
```

After this, the cron jobs get installed on the next `npx supabase db push`.

### Step 3 — Auth URLs

https://supabase.com/dashboard/project/mtujmgramjyvjjhrcitl/auth/url-configuration

- **Site URL**: `http://localhost:5173` (later: your prod domain)
- **Redirect URLs**: add `http://localhost:5173/auth/callback` and `http://localhost:5173/**`

Without this, magic-link emails point to a 404.

---

## 🚀 Test the deployment

After step 1 + 3 above:

```powershell
pnpm --filter @mesh/web dev
# → http://localhost:5173
```

What works without any optional secret:
- `/login` (signin with Google/GitHub/Apple/Magic-link/OTP)
- Account creation
- `/dashboard` (empty until you capture something)
- `/timeline` capture + edit + pin + delete
- `/rules` CRUD
- `/settings` notification prefs + privacy actions

What needs Step 1 (JINA + GROQ):
- `/assistant` chat with streaming
- `/agents` Daily Briefing manual run
- Capture pipeline (NER + summary + embedding)

What needs Step 2 (Vault secrets):
- Automatic agent runs (daily briefing at 6 UTC, etc.)
- Connector auto-syncs every 10 min
- Account wipe after 72h

---

## Things I deferred

- **Stripe** — only relevant when you launch paid plans. Set `STRIPE_*` secrets later.
- **OAuth client IDs** for Gmail/Slack/Notion/Calendar — only needed to enable connectors. Each requires creating an OAuth app in the provider's console (15-30 min per provider).
- **Resend** for transactional emails — fallback is `console.log`, fine until launch.
- **Sentry/PostHog/Helicone** — observability. Add when you have real users.
