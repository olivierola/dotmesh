# Deploy Mesh now — short version

Your project: `mtujmgramjyvjjhrcitl.supabase.co`
Project ref: `mtujmgramjyvjjhrcitl`

Do these steps **in order**. The full reference is `SUPABASE_CLOUD_SETUP.md`.

---

## 0. Pre-flight: rotate the JWT secret

You pasted your legacy JWT secret publicly. Before anything else:

1. Open https://supabase.com/dashboard/project/mtujmgramjyvjjhrcitl/settings/api
2. Click **Reveal new secret** / **Rotate JWT secret**
3. Save the new one only in your password manager — **never paste it again**

---

## 1. Install the Supabase CLI (if not already)

```powershell
npm i -g supabase
supabase --version   # need ≥ 1.190
```

---

## 2. Enable extensions in the dashboard

https://supabase.com/dashboard/project/mtujmgramjyvjjhrcitl/database/extensions

Enable (toggle ON, search each):

- `vector`
- `pgcrypto`
- `pg_trgm`
- `pg_cron`
- `pg_net`
- `pgmq` (optional but recommended)

---

## 3. Create the 3 Vault secrets

https://supabase.com/dashboard/project/mtujmgramjyvjjhrcitl/settings/vault

Click **New secret** three times:

| Name               | Value                                                                     |
|--------------------|---------------------------------------------------------------------------|
| `mesh_token_key`   | Random 32+ char string (generate below)                                   |
| `project_url`      | `https://mtujmgramjyvjjhrcitl.supabase.co`                                |
| `service_role_key` | From Settings → API → **service_role secret** (copy the long JWT)         |

Generate a strong `mesh_token_key` on Windows PowerShell:

```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

---

## 4. Link the CLI to your project

```powershell
cd c:\Users\kamga\Projets\mesh
supabase login
supabase link --project-ref mtujmgramjyvjjhrcitl
```

When asked for the database password, paste the one you set when creating the project (the long DB password, NOT the JWT secret).

---

## 5. Push migrations

```powershell
supabase db push
```

Expected: 14 migrations applied. If you see "extension X not found", go back to step 2.

---

## 6. Deploy Edge Functions

```powershell
pnpm functions:deploy
```

(This runs `node scripts/deploy-functions.mjs` — it iterates over every folder in `supabase/functions/` and sets `--no-verify-jwt` where needed.)

---

## 7. Set Edge Function secrets

Minimum to get the app working:

```powershell
supabase secrets set JINA_API_KEY=jina_xxx GROQ_API_KEY=gsk_xxx PUBLIC_WEB_URL=http://localhost:5173
```

Get the keys (both have free tiers):
- Jina: https://jina.ai/embeddings/ → Get API key
- Groq: https://console.groq.com/keys → Create API key

Optional later (skip for now): `DEEPSEEK_API_KEY`, `RESEND_API_KEY`, `STRIPE_*`, `GOOGLE_CLIENT_ID/SECRET`, `SLACK_*`, `NOTION_*`, `UPSTASH_*`, `HELICONE_API_KEY`, `SENTRY_DSN_EDGE`.

Verify:
```powershell
supabase secrets list
```

---

## 8. Configure Auth URLs

https://supabase.com/dashboard/project/mtujmgramjyvjjhrcitl/auth/url-configuration

- **Site URL**: `http://localhost:5173`
- **Redirect URLs** (add both):
  - `http://localhost:5173/auth/callback`
  - `http://localhost:5173/**`

---

## 9. Wire the web app

Replace the contents of `apps/web/.env.local` with:

```env
VITE_USE_MOCK=false
VITE_SUPABASE_URL=https://mtujmgramjyvjjhrcitl.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon key from Supabase dashboard → Settings → API>
VITE_API_URL=https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1
```

(The anon key above is public-safe — it's the one you shared, designed to be exposed in client code.)

---

## 10. Restart the dev server

```powershell
# stop the current dev server (Ctrl+C in the terminal where it runs), then:
pnpm --filter @mesh/web dev
```

Open http://localhost:5173 → you should now hit **the real backend**:
- No more yellow "Dev mode" banners
- `/login` actually creates an account
- `/timeline` empty until you capture something
- `/assistant` answers from Groq

---

## 11. Smoke test

After signing in via magic link / Google / GitHub / Apple:

1. Capture a memory in Timeline ("Met Sophie about Project Falcon, deadline June 15")
2. Wait ~5 seconds (NER + embedding run async)
3. Go to `/assistant`, ask "what about Sophie?"
4. You should get a streamed answer with a Sources panel showing the memory you just captured

If the chat hangs: check `supabase functions logs chat --tail` in another terminal.

---

## Troubleshooting cheat sheet

| Symptom                              | Fix                                                                  |
|--------------------------------------|----------------------------------------------------------------------|
| 401 on every API call                | Re-check anon key in `.env.local`, restart Vite                      |
| `mesh_token_key is missing`          | Create the Vault secret (step 3) then `supabase db push` again       |
| Chat returns "GROQ_API_KEY missing"  | `supabase secrets set GROQ_API_KEY=gsk_…`                             |
| Cron jobs not visible               | `SELECT jobname FROM cron.job;` — if empty, re-check `project_url` + `service_role_key` Vault secrets, then `supabase db push` |
| RLS error inserting nodes           | The `users` row wasn't auto-created. Sign out, sign in again — the trigger fires on auth signup. |
