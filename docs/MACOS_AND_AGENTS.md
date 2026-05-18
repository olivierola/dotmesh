# macOS app & agents — why they matter (or not)

A frank product memo before you decide to build either.

---

## Part 1 — macOS app

### What you already have

- Web app at `https://app.mesh.so` (Vercel / Cloudflare Pages).
- PWA manifest — users can already "install to desktop" from Chrome/Edge.
- Browser extension that runs everywhere on the web.
- MCP server already integrates with Claude Desktop and Cursor without a native app.

So an "app" already exists in a sense. A **real native macOS app** only earns its place if it does something the web app cannot.

### The 5 things a native app could legitimately do

#### 1. Global hotkey & menu-bar quick-capture (high value)
The web app needs a focused tab. A menu-bar app means **anywhere on the OS, ⌘⇧M opens a capture window**.
- Use cases: capture a fleeting thought while in Zoom, jot a follow-up while reading PDF, screenshot OCR into a memory.
- This is the #1 reason every productivity tool (Raycast, Bear, Things, Mem) eventually ships a native app.

#### 2. System-wide context injection (high value)
Today, injection only works inside the browser (Chrome/Firefox). On macOS native:
- Inject context into the macOS Spotlight successor (Raycast extension)
- Inject into native Claude Desktop / ChatGPT macOS / Perplexity macOS apps via Accessibility API or MCP
- Possible because macOS exposes "system input source" hooks

#### 3. Background watchers without a browser tab open (medium)
Browser extensions die when the browser is closed. A menu-bar daemon can:
- Keep listening to your Calendar (next meeting in 5 min → flash the upcoming context)
- Sync your Apple Notes / Reminders / Mail without OAuth (uses ApplicationServices.framework)
- Detect "you're idle for 10 min" → smart pause; "you're back" → resume

#### 4. Native file integration (medium)
- Drag a PDF / Markdown file onto the menu-bar icon → captured as a memory
- Quick Look extension showing "this file is referenced by 3 Mesh memories"
- Finder right-click → "Save to Mesh"

#### 5. Apple Intelligence / Siri shortcut (low — for now)
- `"Hey Siri, remind me about Sophie's deadline"` routes to Mesh via App Intents framework
- Possible but Apple is jealously gating App Intents quality bar.

### The honest counter-arguments

- **40 MB binary to distribute**, signed, notarized, kept updated on every macOS release. Real maintenance burden.
- **macOS only — leaves out 70% of your users (Windows + Linux + iOS)**. Building 1 platform feels like commitment; in reality it splits your user base.
- **PWA install** already handles 80% of "I want it in my dock" use cases.
- **Raycast + Alfred** already do menu-bar quick-capture well — you could ship a Raycast extension in 2 days instead of a 6-week Swift project.
- **Apple App Store sandbox** restricts what background watchers can do — many of the "wow" use cases need permissions that scare users.

### My recommendation

**Don't ship a standalone macOS app first.** Instead, do these 3 things in order, each shippable in days, not weeks:

1. **Raycast extension** for quick-capture + ask (1 week). Native menu-bar feel, zero distribution headache.
2. **Mac App Store wrapper** of the PWA via WKWebView (2 weeks). Gets you in the App Store with minimal code, lets users get a real "Mesh.app" icon.
3. Re-evaluate: does the conversion rate from PWA users actually go up with a native app? If yes, **Tauri-based native app** (cross-platform Mac + Windows + Linux in 1 codebase, 3-4 weeks). Avoids Swift lock-in.

Skip step 3 if step 2 doesn't move the needle.

### When a fully native macOS app WOULD make sense

- You hit > 10k MAU and people start asking for it explicitly
- You're charging > €15/mo (premium tier deserves premium app)
- You add features that genuinely need system-level access (audio transcription from any app, accessibility-based screen reading, etc.)
- You raise money and have a dedicated platform engineer

Until then: **PWA + Raycast extension** is more leverage than a native app.

---

## Part 2 — Agents

This is where the product gets interesting and where it's easy to overpromise.

### What "agents" actually means here

Three different things people call "agents":

1. **Autonomous background workers** — proactive jobs that run on your memory, without you asking. E.g.: "every Sunday night, summarize the week and flag follow-ups."
2. **Tool-using LLM loops** — like Claude/ChatGPT, but with Mesh-specific tools. E.g.: an agent that searches your memory, reads a webpage, and writes an email draft for you.
3. **Persistent personalities / personas** — "Mesh-as-Devil's-Advocate", "Mesh-as-Coach", etc. Same data, different prompt.

You can ship all three on top of the platform you already have. Different costs and value.

### Concrete use cases — Best to worst ROI

#### Tier S — Build these soon

**Daily Briefing agent** (autonomous, type 1)
- 7am every weekday: read overnight memories + today's calendar + last-week's open decisions.
- Produces a 100-word brief: "Today: meeting with Sophie at 11, draft for Falcon due tomorrow, you flagged 2 follow-ups last Friday."
- **Why valuable:** turns Mesh from passive memory into a daily product moment. Massive retention boost.
- **Cost:** 1 DeepSeek call/user/day × 30 days ≈ €0.15/user/month. Cheap.

**Follow-up agent** (autonomous, type 1)
- Detects when a captured node mentions "I'll get back to you" / "let's revisit" / "by Friday".
- Surfaces a nudge in the dashboard: "You promised X to Sophie 4 days ago — still relevant?"
- Reusable for to-do extraction without manual tagging.
- **Cost:** runs on the existing NER output (Groq 8B), near-free.

**Meeting prep agent** (tool-using, type 2)
- 30 min before a calendar event: pulls all memories mentioning attendees + topic, summarizes the relevant background, drops the brief in `/insights` or pushes a notification.
- The Calendar connector already has the data.
- **Cost:** 1 Groq call per upcoming meeting; negligible.

#### Tier A — Build later

**Drafting agent** (tool-using, type 2)
- "Write me a reply to Sophie's last email." Agent pulls the email thread + relevant context from Mesh + writes the draft.
- Heavy lift because it needs to interact with Gmail/Slack write APIs, which means harder permissions.
- **Value:** very high but only for the prosumer tier — most users would worry about an agent that sends on their behalf.

**Research agent** (tool-using, type 2)
- "Find what I read last month about agent memory and synthesize the key arguments."
- Combines Mesh search + web search + summary.
- **Value:** good demo. Real usage will be sporadic.

**Cross-agent context manager** (autonomous, type 1)
- Already half-there with the extension's injection feature.
- An agent variant: instead of injecting into the prompt, it injects via the agent's own MCP/tools layer — invisible to the user, even better UX.
- **Value:** the long-term defensible moat. But complex to build cleanly.

#### Tier B — Build only if specific demand

**Personas** (type 3)
- "Mesh-as-coach" prompts the same memories with a different system message.
- **Value:** marginal vs. just typing "act as my coach" in your usual agent.

**Contradiction agent** (autonomous)
- Already specced in the original product doc — DeepSeek detects "X said in Jan vs ¬X said in March".
- **Value:** demo-friendly, real value uncertain. Could be high for journalists / lawyers / researchers; near-zero for casual users.

**Autonomous content drafting / scheduling** (type 1+2 mix)
- "Every Friday, look at what I learned this week and draft a LinkedIn post."
- **Value:** very high for creator-economy users. Risk: spam-perception if the agent ever publishes without review.

### Architecture you already have

Good news: **you don't need to rebuild anything to start.**

- Edge function `chat` already does tool-using RAG. An "agent" is just `chat` with a different system prompt and access to extra tools.
- `pg_cron` already runs scheduled jobs (TTL cleanup, weekly insights, connector syncs). A new agent is one more cron entry.
- `webhooks` lets agents notify external systems they ran.
- `usage_metrics` table already tracks per-user LLM cost so you can budget agents per tier.

### Concrete next step (1-day prototype)

Build the **Daily Briefing agent** as a proof point:

1. New Edge function `agents-daily-briefing` (~150 lines): aggregate last 24h nodes + next 24h calendar events, ask DeepSeek for a 100-word summary, store it in a new `agent_outputs` table.
2. New cron job (1 line in the cron migration): runs every day at 6:30am UTC for all paid users.
3. New page `/agents` listing recent agent outputs.
4. Optional: trigger a push notification (if PWA installed) at 7am local.

If the metrics are good (users open the briefing > 60% of days), expand. If not, you've burned 1 day.

### Recommended pricing pivot

Agents are the natural premium feature.

- **Free**: Mesh memory + extension + manual chat (existing).
- **Personal €9**: + 1 agent (Daily Briefing only).
- **Pro €19** *(rename "Pro" to "Plus" maybe)*: all agents, custom scheduling, agent webhooks.
- **New tier €49 — "Mesh Crew"**: custom agents, multi-step workflows, integrations with Zapier/n8n.

The €49 tier doesn't need to exist on day 1 — but **it's where SaaS economics get interesting** (10× higher ARPU than the curious user segment).

---

## TL;DR

| Question | Short answer |
|---|---|
| Should I build a macOS app? | Not yet. Ship a Raycast extension + Mac App Store PWA wrapper first. Re-evaluate at 10k MAU. |
| Should I build agents? | Yes — start with Daily Briefing (1 day prototype). It's high-leverage, dirt cheap, and the infrastructure already exists. |
| Which agent first? | Daily Briefing > Follow-up agent > Meeting prep > Drafting > Research. In that order. |
| New revenue tier? | Yes — agents justify a €49 "Crew" tier above Pro. Don't ship the tier until you have ≥ 3 agents users love. |
