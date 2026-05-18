# OAuth providers setup — Mesh

You're seeing `Missing required parameter: client_id` because the OAuth credentials
are not yet configured. Here's the exact steps for each provider.

Your project: `mtujmgramjyvjjhrcitl.supabase.co`

The redirect URI Mesh uses for each provider is **the Supabase Edge Function URL**:
- Gmail:    `https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-gmail-auth?action=callback`
- Calendar: `https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-gcal-auth?action=callback`
- Slack:    `https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-slack-auth?action=callback`
- Notion:   `https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-notion-auth?action=callback`

---

## 1. Google (Gmail + Calendar — one app, two scopes)

### Step 1.1 — Create the Google Cloud project

1. Open https://console.cloud.google.com/
2. Top-left dropdown → **New Project** → name it `Mesh` → Create
3. Wait ~30s for provisioning, then select the project

### Step 1.2 — Enable the required APIs

1. **APIs & Services → Library**
2. Search and **Enable** for each:
   - **Gmail API**
   - **Google Calendar API**

### Step 1.3 — OAuth consent screen

1. **APIs & Services → OAuth consent screen**
2. User type: **External** → Create
3. Fill:
   - App name: `Mesh`
   - User support email: your email
   - Developer contact: your email
4. **Save and Continue**
5. **Scopes** → click "Add or Remove Scopes" → add:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar.events.readonly`
6. **Save and Continue**
7. **Test users** → "Add Users" → add your own email (`kamgaolivier104@gmail.com`)
8. **Save and Continue** → Back to Dashboard

> While in "Testing" mode, only the test users you added can sign in. That's
> fine for now. Submit for verification later when you launch.

### Step 1.4 — Create the OAuth credentials

1. **APIs & Services → Credentials → + CREATE CREDENTIALS → OAuth client ID**
2. Application type: **Web application**
3. Name: `Mesh — web`
4. **Authorized redirect URIs** → click "+ ADD URI" twice:
   ```
   https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-gmail-auth?action=callback
   https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-gcal-auth?action=callback
   ```
5. **Create** — a modal shows your `Client ID` and `Client secret`. Copy both.

### Step 1.5 — Push the secrets to Supabase

Dashboard → **Project Settings → Edge Functions → Secrets**:

| Key                    | Value                         |
|------------------------|-------------------------------|
| `GOOGLE_CLIENT_ID`     | (paste — looks like `…apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | (paste — looks like `GOCSPX-…`)                    |

Save. The next time the user clicks "Connect Gmail" or "Connect Calendar" in
the dashboard, the OAuth flow will succeed.

---

## 2. Slack

### Step 2.1 — Create the Slack app

1. Open https://api.slack.com/apps → **Create New App** → "From scratch"
2. App name: `Mesh`
3. Workspace: pick yours → Create

### Step 2.2 — Configure OAuth

1. Left nav → **OAuth & Permissions**
2. Scroll to **Redirect URLs** → Add:
   ```
   https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-slack-auth?action=callback
   ```
3. **Save URLs**
4. Scroll to **User Token Scopes** → Add scope for each:
   - `channels:read`
   - `channels:history`
   - `users:read`

> Mesh uses **user tokens**, not bot tokens — the user reads messages they
> can already see, with their own permissions. We never ask for DM scopes.

### Step 2.3 — Install to your workspace (for testing)

1. Top of the same page → **Install to Workspace** → Allow

### Step 2.4 — Grab the credentials

1. Left nav → **Basic Information**
2. Scroll to "App Credentials":
   - `Client ID`
   - `Client Secret` (click "Show")

### Step 2.5 — Push the secrets to Supabase

| Key                    | Value      |
|------------------------|------------|
| `SLACK_CLIENT_ID`      | (paste)    |
| `SLACK_CLIENT_SECRET`  | (paste)    |

---

## 3. Notion

### Step 3.1 — Create the integration

1. Open https://www.notion.so/profile/integrations
2. **+ New integration** → "Public integration"
3. Name: `Mesh`
4. Logo: any PNG (Notion requires one for public integrations)
5. Associated workspace: pick yours

### Step 3.2 — OAuth Domain & URIs section

1. Redirect URIs:
   ```
   https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-notion-auth?action=callback
   ```
2. Capabilities → enable "Read content"
3. Save

### Step 3.3 — Grab the credentials

From the integration page:
- `OAuth client ID`
- `OAuth client secret` (click "Show")

### Step 3.4 — Push the secrets to Supabase

| Key                    | Value      |
|------------------------|------------|
| `NOTION_CLIENT_ID`     | (paste)    |
| `NOTION_CLIENT_SECRET` | (paste)    |

---

## 4. Verify everything works

Once the secrets are saved in Supabase, return to your local app:

```powershell
# nothing to restart on the frontend — secrets are picked up by Edge Functions
# next time they're invoked. You just click Connect again.
```

Go to **/connectors**, click any "Connect" button. You should be redirected to
the provider's consent screen (no more `Missing client_id`).

---

## Troubleshooting

**`Missing client_id` despite setting the secret**
The secret is mistyped or in the wrong project. Run in dashboard SQL:
```sql
SELECT name FROM vault.secrets;
```
…no, scratch that — those go in **Edge Function secrets**, not Vault. Check
`Project Settings → Edge Functions → Secrets` in the dashboard. The list there
must contain `GOOGLE_CLIENT_ID` etc.

**`redirect_uri_mismatch` from Google**
The redirect URI in Google Cloud Console must match **byte-for-byte** what the
function sends. Copy-paste the URIs from § 1.4 exactly — no trailing slash, no
typo. Including the `?action=callback` query string.

**Slack: `invalid_team_for_non_distributed_app`**
The app is still in "single workspace" mode. In Slack API → your app →
**Manage Distribution → Activate Public Distribution**. Not needed for personal
use though — just install to your own workspace and test with your own account.

**Notion: "URL must be HTTPS"**
Notion refuses `http://localhost` callbacks. That's why we route the callback
through Supabase Edge Functions, which are HTTPS by default. Your redirect URI
must point to `https://<project>.supabase.co/...`.

---

## How the redirect actually works

When a user clicks "Connect Gmail" in your local dashboard:

1. Frontend calls `POST /functions/v1/connectors-gmail-auth?action=start`
2. Edge function returns `{ auth_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=https://mtujmgramjyvjjhrcitl.supabase.co/functions/v1/connectors-gmail-auth?action=callback&..." }`
3. Browser redirects to Google → user consents
4. Google redirects back to `…/connectors-gmail-auth?action=callback&code=...`
5. Edge function exchanges code for tokens → stores them encrypted → 302 redirect to `{PUBLIC_WEB_URL}/connectors?connected=gmail`

So even though your dev server runs on `http://localhost:5173`, the OAuth callback
lives on the Supabase Edge Function URL (HTTPS, public). The final hop back to your
localhost works because Supabase 302-redirects to `PUBLIC_WEB_URL` — make sure
that env var is set in Edge Function secrets:

```
PUBLIC_WEB_URL=http://localhost:5173
```

Change it to your real domain when you deploy the web app.
