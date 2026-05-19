# Mesh — Browser Extension

The Mesh browser extension passively captures memories from your browsing and lets you ask Mesh anything from any tab.

## What it does

- **Passive capture**: detects long reads (>45s + 70% scroll), AI sessions (Claude/ChatGPT/Gemini/Perplexity), and active work in Notion/Docs/Linear/GitHub/Figma
- **Manual capture**: right-click → "Save to Mesh", or `Ctrl/Cmd+Shift+M` from anywhere
- **Cross-agent injection**: when you type into Claude/ChatGPT/Gemini/Perplexity, Mesh proposes relevant context from your memory before you submit
- **Privacy**: sensitive sites (banking, medical, mail, gov, private messengers) are hard-blocked. Paused mode for sensitive sessions.

---

## Install (dev mode)

### 1. Build

```powershell
cd c:\Users\kamga\Projets\mesh
pnpm install
pnpm --filter @mesh/extension build
```

This produces `apps/extension/.output/chrome-mv3/`.

### 2. Load in Chrome / Edge

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the folder `apps/extension/.output/chrome-mv3`
5. The Mesh icon appears in your toolbar

### 3. Load in Firefox

```powershell
pnpm --filter @mesh/extension build:firefox
```

Then `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick `apps/extension/.output/firefox-mv2/manifest.json`.

---

## First-run setup

1. Click the Mesh icon → **Sign in with Mesh**
2. A new tab opens on `https://dotmesh.vercel.app/auth/extension-bridge`
3. Sign in (or create account) — the tab closes automatically and your popup shows "Active"

If the auth tab doesn't auto-close, you may need to add `chrome-extension://<your-id>/*` to Supabase's URL Allowlist (Project Settings → Authentication → URL Configuration).

---

## Smoke test (5 minutes)

After install + sign-in:

### Test 1 — Passive reading capture
1. Open any article (Medium, HN, a blog post) for 60+ seconds
2. Scroll 70%+ of the way down
3. Click Mesh icon → "Captured" stat should increase
4. Visit `https://dotmesh.vercel.app/timeline` → the article should appear within 10s

### Test 2 — Quick capture shortcut
1. Select any text on a webpage
2. Press `Ctrl+Shift+M` (Mac: `Cmd+Shift+M`)
3. Toast notification "Saved to Mesh" appears
4. Verify on `/timeline`

### Test 3 — Right-click context menu
1. Right-click any page → "Save this page to Mesh"
2. Right-click selected text → "Save selection to Mesh"
3. Right-click a link → "Save this link to Mesh"

### Test 4 — Cross-agent injection
1. Go to https://claude.ai (or chatgpt.com)
2. Capture some memories first (cf. Test 1) so the trigger scorer has keywords
3. Type a question that mentions something from your captured memories
4. Before submitting, an overlay should briefly appear proposing context from Mesh
5. Accept/skip — the prompt is augmented before being sent to Claude

### Test 5 — Diagnostics
1. Click Mesh icon → "Diagnostics"
2. A new tab opens with full health report
3. Click "Send test capture" → should succeed in <2s
4. Click "Copy full report" → JSON copied to clipboard (use this if you report a bug)

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+Shift+M` | Quick capture (selection or current page) |
| `Ctrl/Cmd+Shift+K` | Open Mesh assistant in a new tab |

Override these in `chrome://extensions/shortcuts` if needed.

---

## Troubleshooting

### Nothing gets captured

1. Check the popup — is the status badge green ("Active") ?
2. If "Paused", click "Resume capture"
3. Open Diagnostics → check "Signed in: Yes" + "API reachable: OK"
4. Make sure you're not on a blocked domain (Gmail, banks, gov sites — see `lib/blocked-domains.ts`)

### Captures fail (red "Issue" badge)

1. Open Diagnostics → look at "Last error"
2. Common causes:
   - **`401`** — your session expired. Sign out + sign in again from the popup.
   - **`429`** — rate-limited. Wait 1 minute.
   - **`502 / network error`** — Supabase is down or `VITE_API_URL` is wrong in your build.
3. Click "Retry" on the error banner

### Injection overlay never appears

1. The trigger scorer requires you to have captured some memories first — it skips queries with no keyword overlap
2. You can also force a manual `Ctrl+Shift+K` to open the chat directly

### Build/install issues

1. Make sure you ran `pnpm install` at the **repo root**, not in `apps/extension`
2. Verify `apps/extension/.env.local` exists and contains the 4 vars (see `.env.example`)
3. Delete `apps/extension/.output` and rebuild

---

## Architecture

```
extension/
├── entrypoints/
│   ├── background.ts       Service worker: queue, retry, alarms, context menu, shortcuts
│   ├── content.ts          Injected on every page: signals, injection trigger
│   ├── popup/              React popup (360px) with stats + actions
│   └── diagnostic.html     Self-contained health-check page
├── lib/
│   ├── auth.ts             Bridge auth flow with the web app, token refresh
│   ├── api-client.ts       HTTP wrapper with auto-refresh
│   ├── db.ts               IndexedDB queue (Dexie)
│   ├── fingerprint.ts      SHA-256 deduplication
│   ├── scorer.ts           Local relevance scorer
│   ├── trigger.ts          Decides if an injection /inject API call is worth it
│   ├── blocked-domains.ts  Hard-coded sensitive site blocklist
│   ├── injector.ts         Per-agent DOM adapters (Claude/ChatGPT/Gemini/Perplexity)
│   └── overlay.ts          Floating injection confirmation UI
└── wxt.config.ts           Manifest + commands declaration
```

---

## Privacy

- **No data leaves the browser** until it passes the local scorer (score > 0.55)
- **Sensitive content** (passwords, credit cards, IBAN, SSN, API keys) is detected locally and **never** sent
- **Blocked domains** (banking, healthcare, gov, mail, private messengers) are skipped before any processing
- **All API calls** are over HTTPS to your own Supabase Cloud project (EU region)
- **OAuth tokens** for connectors are stored encrypted server-side (pgcrypto), never in the extension
