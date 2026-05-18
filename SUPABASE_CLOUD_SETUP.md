# Mesh — Supabase Cloud setup

Step-by-step guide to deploy Mesh on Supabase Cloud (free tier works).

Estimated time: **20–30 minutes** first time.

---

## 0. Prerequisites

- Node.js ≥ 20 and pnpm ≥ 9
- A Supabase account ([supabase.com](https://supabase.com), free)
- Supabase CLI installed: `npm i -g supabase` then `supabase --version` (need ≥ 1.190.0)

API keys you'll need (all have free tiers):
- [Jina AI](https://jina.ai/embeddings/) — `JINA_API_KEY`
- [Groq](https://console.groq.com) — `GROQ_API_KEY`

Optional:
- [DeepSeek](https://platform.deepseek.com) — weekly insights narrative
- [Stripe](https://dashboard.stripe.com) — billing
- [Google Cloud Console](https://console.cloud.google.com) — Gmail + Calendar OAuth
- [Slack API](https://api.slack.com/apps) — Slack OAuth
- [Notion integrations](https://www.notion.so/my-integrations) — Notion OAuth
- [Resend](https://resend.com) — transactional emails
- [Upstash Redis](https://upstash.com) — rate-limit storage

---

## 1. Create a Supabase project

1. Go to https://supabase.com → New project.
2. **Region: Frankfurt (eu-central-1)** for EU compliance.
3. Choose a strong database password — store it in your password manager.
4. Wait ~2 minutes for provisioning.

Note your **project ref** (the subdomain part, e.g. `abcdefghij` from `abcdefghij.supabase.co`).

---

## 2. Enable required Postgres extensions

In the Supabase dashboard:

**Database → Extensions** → search and enable:

| Extension   | Required for                              |
|-------------|-------------------------------------------|
| `vector`    | embeddings (already enabled in new projects) |
| `pgcrypto`  | OAuth token encryption                    |
| `pg_trgm`   | trigram search                            |
| `pg_cron`   | scheduled jobs (TTL cleanup, syncs, etc.) |
| `pg_net`    | HTTP from cron jobs to Edge Functions     |
| `pgmq`      | optional — only if you want explicit queues |

> If you see "extension not available", the project plan may not include it — `pg_cron` and `pg_net` are available on free tier as of 2025.

---

## 3. Create the Vault secrets

The Mesh migrations look for two Vault secrets by name. Go to **Project Settings → Vault → New secret** and create:

| Secret name        | Value                                                                              |
|--------------------|------------------------------------------------------------------------------------|
| `mesh_token_key`   | A random **32+ character** string. Used to encrypt OAuth tokens.                   |
| `project_url`      | Your project URL, e.g. `https://abcdefghij.supabase.co`                            |
| `service_role_key` | From **Project Settings → API → service_role secret**.                             |

> The cron migration uses `project_url` + `service_role_key` to POST to your Edge Functions. If you skip them, only the always-on jobs (TTL cleanup, FIFO) install — the connector syncs and weekly digests won't run automatically (you'd need to trigger them manually).

To generate a strong key on Linux/Mac:

```bash
openssl rand -base64 32
```

On Windows PowerShell:

```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

---

## 4. Link the CLI to your project

```bash
cd c:\Users\kamga\Projets\mesh
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
```

You'll be prompted for the database password from step 1.

---

## 5. Push migrations

```bash
supabase db push
```

This applies every file in `supabase/migrations/` in order. You should see:

```
Applying migration 20260516000001_extensions.sql...
Applying migration 20260516000002_users.sql...
...
Applying migration 20260517000004_chat.sql... done.
```

If a migration fails with `vault.decrypted_secrets does not exist`, re-check step 3.

> **Idempotency:** all migrations are written to be re-runnable. If you change a migration file, you can always `supabase db reset --linked` to wipe and reapply — but this destroys data.

---

## 6. Deploy the Edge Functions

```bash
supabase functions deploy --no-verify-jwt nodes search inject process-node rules \
  connectors-gmail-auth connectors-gmail-sync \
  connectors-gcal-auth connectors-gcal-sync \
  connectors-slack-auth connectors-slack-sync connectors-slack-channels \
  connectors-notion-auth connectors-notion-sync \
  billing-checkout billing-portal billing-webhook \
  account-export account-delete account-wipe-worker \
  onboarding-complete insights-generate \
  chat chat-sessions
```

> Some functions (e.g. `billing-webhook`, `connectors-*-auth?action=callback`, `account-wipe-worker`) verify auth themselves and need `--no-verify-jwt`.
>
> For convenience, use the script `pnpm functions:deploy` (see § 9).

---

## 7. Set Edge Function secrets

Edge Functions can't read Vault — they need env vars. Set them with:

```bash
supabase secrets set \
  JINA_API_KEY=jina_xxx \
  GROQ_API_KEY=gsk_xxx \
  DEEPSEEK_API_KEY=ds_xxx \
  RESEND_API_KEY=re_xxx \
  RESEND_FROM="Mesh <hello@yourdomain.com>" \
  UPSTASH_REDIS_URL=https://xxx.upstash.io \
  UPSTASH_REDIS_TOKEN=xxx \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_WEBHOOK_SECRET=whsec_xxx \
  STRIPE_PRICE_PERSONAL_MONTH=price_xxx \
  STRIPE_PRICE_PERSONAL_YEAR=price_xxx \
  STRIPE_PRICE_PRO_MONTH=price_xxx \
  STRIPE_PRICE_PRO_YEAR=price_xxx \
  GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com \
  GOOGLE_CLIENT_SECRET=xxx \
  SLACK_CLIENT_ID=xxx \
  SLACK_CLIENT_SECRET=xxx \
  NOTION_CLIENT_ID=xxx \
  NOTION_CLIENT_SECRET=xxx \
  PUBLIC_WEB_URL=https://your-web-app.vercel.app \
  SENTRY_DSN_EDGE=https://xxx@oXXX.ingest.sentry.io/XXX
```

You can skip any provider you're not using — Mesh degrades gracefully (e.g. no GROQ_API_KEY → assistant returns a clear error).

Verify with `supabase secrets list`.

---

## 8. Configure Auth in the dashboard

**Authentication → URL Configuration**:

- Site URL: `https://your-web-app.vercel.app` (or `http://localhost:5173` during dev)
- Redirect URLs (add both): `http://localhost:5173/auth/callback` and your prod URL.

**Authentication → Providers**:

- Enable **Email** (magic link works out of the box).
- Optional: enable **Google** and **GitHub** with their OAuth credentials.

---

## 9. Wire the web app to Cloud

Edit `apps/web/.env.local`:

```bash
VITE_USE_MOCK=false
VITE_SUPABASE_URL=https://<YOUR_PROJECT_REF>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key from Project Settings → API>
VITE_API_URL=https://<YOUR_PROJECT_REF>.supabase.co/functions/v1
```

Restart the dev server:

```bash
pnpm --filter @mesh/web dev
```

Sign in with magic link or Google — you should land on `/dashboard`.

---

## 10. (Optional) Stripe webhook

In the [Stripe dashboard](https://dashboard.stripe.com/test/webhooks) → Add endpoint:

- URL: `https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/billing-webhook`
- Events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

Copy the **Signing secret** (`whsec_…`) and set it via:

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
```

---

## 11. Verify everything works

Run the smoke tests in order:

```bash
# Health: list nodes (should return empty array)
curl -H "Authorization: Bearer $YOUR_JWT" \
  "https://<REF>.supabase.co/functions/v1/nodes"

# Create a node
curl -X POST "https://<REF>.supabase.co/functions/v1/nodes" \
  -H "Authorization: Bearer $YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"content":"Met Sophie about Project Falcon","source":"manual"}'

# Wait 5 seconds, then search
curl -X POST "https://<REF>.supabase.co/functions/v1/search" \
  -H "Authorization: Bearer $YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"query":"Sophie","top_k":3}'
```

You can grab a JWT from the browser devtools after signing into the web app: `await window.supabase.auth.getSession()`.

---

## 12. Useful CLI commands

```bash
# Apply new migrations
supabase db push

# Re-apply ALL migrations (wipes data — careful in prod!)
supabase db reset --linked

# Tail Edge Function logs
supabase functions logs --tail

# View a single function's logs
supabase functions logs chat --tail

# List cron jobs
psql $DATABASE_URL -c "SELECT jobname, schedule FROM cron.job;"
```

---

## 13. Costs ballpark (estimate at 100 active users)

| Item                   | Cost / month |
|------------------------|--------------|
| Supabase Free Pro      | €25          |
| Jina embeddings        | €5–10        |
| Groq inference (chat)  | €15–25       |
| DeepSeek (weekly only) | €1–2         |
| Resend                 | €0 (free tier 3k/mo) |
| Upstash Redis (free)   | €0           |
| **Total estimate**     | **~€50–60**  |

---

## 14. Troubleshooting

**"Vault secret not found" during migration**
You enabled `pg_cron`/`pg_net` but forgot the `project_url`/`service_role_key` Vault secrets. Create them, then re-run `supabase db push`.

**"mesh_token_key is missing or too short"**
The OAuth token encryption helper needs the Vault secret named exactly `mesh_token_key`, with ≥32 chars. Re-create it in the Vault dashboard.

**Cron jobs not firing**
Check `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;` for failure reasons. Most common cause: `pg_net` not enabled.

**Edge Function 401 on auth**
The function uses `requireUser()` which verifies the JWT. Make sure the client sends `Authorization: Bearer <access_token>` and that the project's URL Configuration includes your origin.

**Slack OAuth callback returns 401 `state_mismatch`**
The state param embeds part of the JWT. If your JWT is rotated mid-flow (e.g. token refresh), the callback may fail. Re-trigger the connect flow.

---

## 15. Tearing down

```bash
# Remove cron jobs
psql $DATABASE_URL -c "SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE 'mesh-%';"

# Drop the Supabase project from the dashboard (irreversible).
```
