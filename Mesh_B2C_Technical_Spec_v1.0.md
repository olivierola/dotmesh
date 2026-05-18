# MESH B2C — Technical Specification

**Document de référence technique pour le développement du produit B2C**
**Version 1.0 — 2026-05-16**
**Statut : pre-development, blueprint d'exécution**
**Périmètre : B2C uniquement. Le B2B (SDK builders) sera adressé en V2 (mois 12+).**

---

## Table des matières

1. [Vision & positionnement produit](#1-vision--positionnement-produit)
2. [Cibles utilisateurs & jobs to be done](#2-cibles-utilisateurs--jobs-to-be-done)
3. [Architecture technique globale](#3-architecture-technique-globale)
4. [Schéma de données complet](#4-schéma-de-données-complet)
5. [Module 1 — Extension navigateur (capture passive)](#5-module-1--extension-navigateur-capture-passive)
6. [Module 2 — Context Injection Engine (killer feature)](#6-module-2--context-injection-engine-killer-feature)
7. [Module 3 — Backend API & pipeline](#7-module-3--backend-api--pipeline)
8. [Module 4 — Connecteurs API (Agent Hub)](#8-module-4--connecteurs-api-agent-hub)
9. [Module 5 — Application web (dashboard utilisateur)](#9-module-5--application-web-dashboard-utilisateur)
10. [Module 6 — IA layer (embeddings, NER, scoring)](#10-module-6--ia-layer-embeddings-ner-scoring)
11. [Sécurité, privacy & conformité](#11-sécurité-privacy--conformité)
12. [Authentification, billing & comptes](#12-authentification-billing--comptes)
13. [Observabilité & monitoring](#13-observabilité--monitoring)
14. [Tests, CI/CD & qualité](#14-tests-cicd--qualité)
15. [Roadmap de développement](#15-roadmap-de-développement)
16. [Pricing, économie unitaire & projections](#16-pricing-économie-unitaire--projections)
17. [Risques techniques & mitigations](#17-risques-techniques--mitigations)
18. [Annexes](#18-annexes)

---

## 1. Vision & positionnement produit

### 1.1 One-liner

> **Mesh est le second cerveau qui se construit sans toi, et qui rend tous tes agents AI personnels.**

### 1.2 Le problème résolu

Les utilisateurs d'agents AI (Claude, ChatGPT, Gemini, Perplexity, Cursor) sont confrontés à trois problèmes simultanés :

1. **Amnésie cross-agent** : chaque agent oublie l'utilisateur dès qu'il change de plateforme. ChatGPT ne sait rien de ce que Claude vient de faire.
2. **Friction d'input** : les solutions de "second cerveau" (Notion, Mem.ai, Reflect) demandent à l'utilisateur d'écrire manuellement. 80% des users abandonnent en 3 semaines.
3. **Perte de propriété** : la mémoire est captive chez OpenAI/Anthropic. L'utilisateur loue sa propre histoire.

### 1.3 La proposition de valeur unique

Mesh combine **trois capacités que personne ne combine** :

| Capacité | Concurrents qui la font seule | Concurrents qui combinent |
|---|---|---|
| Capture passive (navigateur + connecteurs) | Rewind (écran), Granola (audio) | Aucun |
| Graphe de contexte sémantique personnel | Mem.ai, Reflect, Notion | Aucun |
| Injection automatique cross-agent | ChatGPT Memory (silo), Claude Projects (manuel) | **Mesh uniquement** |

### 1.4 Pourquoi maintenant

- **MCP standardisé** depuis fin 2024 → les agents principaux acceptent du contexte externe
- **EU AI Act** entré en application 2025 → les users EU cherchent des alternatives RGPD
- **Saturation de la mémoire native** (ChatGPT Memory limité, Claude Projects manuel) → users frustrés
- **Maturité des embeddings** (Jina v3, BGE-M3) → coût/perf permet le B2C à €15-25/mois

### 1.5 Non-objectifs explicites

Pour rester focalisé, Mesh **ne fera pas** :

- ❌ Application desktop avec accessibility API ou capture d'écran (cf. échec Rewind/Recall)
- ❌ Capture audio passive (problème de consentement tiers en EU)
- ❌ Mobile app au MVP (V3 minimum)
- ❌ Génération de contenu (pas un agent, pas un LLM wrapper)
- ❌ Stockage de fichiers / images / vidéos (texte uniquement)
- ❌ Monétisation par publicité ou revente de données (jamais — tue le moat RGPD)

---

## 2. Cibles utilisateurs & jobs to be done

### 2.1 Persona principal — Prosumer Pro (€19-29/mois)

**Profil** :
- 28-45 ans
- Freelance tech, consultant, créateur de contenu, chercheur indépendant, knowledge worker autonome
- Utilise 3+ agents AI par semaine (Claude pour writing, ChatGPT pour exploration, Cursor pour code, Perplexity pour research)
- Revenu €60k-200k/an
- Sensible à la productivité, prêt à payer pour gagner 2-5h/semaine

**Jobs to be done** :
1. "Je veux que mes agents AI me connaissent sans que je leur explique tout à chaque fois"
2. "Je veux retrouver une décision/idée que j'ai eue il y a 2 mois sans creuser mes notes"
3. "Je veux que mes données restent en EU et que je puisse tout effacer en 1 clic"

### 2.2 Persona secondaire — Curious User (free → €9/mois)

**Profil** :
- 22-55 ans
- Knowledge worker généraliste
- Utilise ChatGPT principalement, parfois Claude
- Revenu €30k-80k/an
- Curieux des nouveaux outils AI, conversion plus lente

**Jobs to be done** :
1. "Je veux un outil 'magique' qui rend ChatGPT plus utile sans que je travaille"
2. "Je veux comprendre ce que les agents savent de moi"

### 2.3 Anti-persona explicite

**Mesh n'est pas pour** :
- Les utilisateurs occasionnels d'AI (<1×/semaine) — pas de ROI
- Les enterprise users (besoin de compliance teams, SSO, contrôles admin) — V2 B2B
- Les utilisateurs mobile-first — V3
- Les utilisateurs hostiles à toute capture passive — fondamental incompatible

### 2.4 Métriques d'activation par persona

| Persona | Trigger d'activation | Cible mois 1 |
|---|---|---|
| Prosumer Pro | 100+ nœuds capturés + 5 injections réussies en 1 semaine | 60% des signups Pro |
| Curious User | 30+ nœuds + 1ère injection visible | 35% des signups Free |

---

## 3. Architecture technique globale

### 3.1 Vue d'ensemble

Mesh B2C est composé de **cinq composants déployables** :

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT SIDE                                                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │ Browser ext WXT  │  │ Web app React    │  │ MCP server    │ │
│  │ (Chrome+Firefox) │  │ (dashboard SPA)  │  │ (npm package) │ │
│  └────────┬─────────┘  └────────┬─────────┘  └───────┬───────┘ │
└───────────┼─────────────────────┼─────────────────────┼─────────┘
            │                     │                     │
            │  HTTPS + JWT + WS   │                     │
            ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  EDGE / API GATEWAY (Supabase Edge Functions, Deno runtime)     │
│  - Auth (JWT verify)                                             │
│  - Rate limiting (Upstash sliding window)                        │
│  - Request routing                                               │
└────────┬──────────────────────────┬─────────────────────────────┘
         │                          │
         ▼                          ▼
┌────────────────────┐  ┌──────────────────────────────────────┐
│  Postgres (Supabase│  │  Background workers (pg_cron + pgmq) │
│  Frankfurt, RLS)   │  │  - NER / Summary jobs                │
│  + pgvector HNSW   │  │  - Embedding jobs                    │
│  + tsvector FTS    │  │  - Edge inference                    │
└────────┬───────────┘  │  - Connector sync                    │
         │              │  - Weekly insights                   │
         │              └──────┬───────────────────────────────┘
         │                     │
         ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  EXTERNAL AI APIs                                                │
│  - Jina v3 (embeddings, 1024d)                                  │
│  - Groq (llama-3.1-8b sync, llama-3.3-70b async)                │
│  - DeepSeek (reasoning, contradictions, insights)               │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Stack technique complète

#### Frontend web app

| Composant | Tech | Version | Justification |
|---|---|---|---|
| Framework | React | 18.3 | Maturité, écosystème |
| Build | Vite | 5.x | HMR rapide, ESM natif |
| Language | TypeScript | 5.4+ | Strict mode partout |
| State | Zustand | 4.x | Léger, pas de boilerplate Redux |
| Server state | TanStack Query | 5.x | Cache + sync robuste |
| Routing | React Router | 6.x | SPA classique |
| Styling | Tailwind CSS | 3.x | Utility-first, JIT |
| UI primitives | Radix UI | latest | Accessibilité native |
| Forms | React Hook Form + Zod | latest | Validation typée |
| Graph viz | Cytoscape.js | 3.x | Plus mature que D3 pour graphes |
| Date/time | date-fns | 3.x | Tree-shakable vs moment |
| Charts | Recharts | 2.x | Suffisant pour usage analytics |

#### Extension navigateur

| Composant | Tech | Justification |
|---|---|---|
| Framework | WXT | Chrome MV3 + Firefox MV2 single codebase |
| UI popup | React 18 (partagé avec web app) | Composants réutilisés |
| Storage local | Dexie.js (IndexedDB) | Queue offline, dedup, settings |
| Crypto | Web Crypto API | Fingerprint SHA-256, pas de lib externe |
| Messaging | chrome.runtime + browser.runtime | Content ↔ Background |
| DOM observer | MutationObserver natif | Pas de lib |

#### Backend & infra

| Composant | Tech | Justification |
|---|---|---|
| Runtime API | Supabase Edge Functions (Deno) | Serverless, EU Frankfurt par défaut |
| DB | PostgreSQL 16 (Supabase) | RLS, pgvector, extensions |
| Vector | pgvector HNSW | Cosine similarity <50ms |
| Full-text | PostgreSQL tsvector | Recherche hybride dense+sparse |
| Realtime | Supabase Realtime | WebSocket events |
| Cache | Upstash Redis (EU) | Embeddings chauds, sessions |
| Queue | pgmq + pg_cron | Jobs async sans Lambda externe |
| Webhooks sortants | Svix | Retry/dead letter géré |
| Auth | Supabase Auth | JWT RS256, OAuth providers |
| Storage fichiers | Aucun au MVP | Texte uniquement |
| Billing | Stripe (EU) | SCA, TVA EU, metering |
| Emails transactionnels | Resend | Simple, fiable |

#### IA layer

| Service | Modèle | Usage | Latence cible | Coût |
|---|---|---|---|---|
| Jina | jina-embeddings-v3 (1024d) | Embeddings tous les nœuds | <300ms | €0.0001/req |
| Groq | llama-3.1-8b-instant | NER sync, scoring trigger | <150ms | €0.002/req |
| Groq | llama-3.3-70b-versatile | Résumés async | <2s | €0.004/req |
| DeepSeek | deepseek-reasoner | Contradictions, weekly insights | <30s | €0.002/run |
| Fallback EU | BGE-M3 self-hosted (V2) | Souveraineté Enterprise | <500ms | infra ~€80/mois |

**Règle d'or IA** : Groq pour tout le synchrone (<200ms), Jina pour chaque embedding, DeepSeek seulement pour le reasoning lourd asynchrone et rare.

### 3.3 Choix d'architecture clés

**Pourquoi Supabase plutôt qu'AWS/GCP custom** :
- Solo founder → zéro infra à manager
- RLS natif pour isolation user (essentiel multi-utilisateur)
- pgvector inclus, pas de Pinecone/Weaviate à payer
- Frankfurt par défaut → RGPD trivial
- Edge Functions gratuites jusqu'à 500k invocations/mois
- Realtime WebSocket inclus

**Pourquoi pas de message broker (Kafka/RabbitMQ)** :
- pgmq (Postgres extension) suffit pour le volume B2C jusqu'à ~10M events/jour
- Une seule DB à backup/monitor
- Migration vers Kafka possible plus tard si besoin

**Pourquoi Cytoscape plutôt que D3** :
- Layouts pré-codés (force-directed, hierarchical, concentric)
- Performance supérieure >5k nodes
- API plus haut niveau, moins de code custom

**Pourquoi pas de mobile au MVP** :
- Coverage prosumer est principalement desktop
- 3-4 mois de dev minimum pour iOS+Android
- WebView wrapper de la dashboard suffit pour consultation occasionnelle (V2)

---

## 4. Schéma de données complet

### 4.1 Tables principales

#### `users`

```sql
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text UNIQUE NOT NULL,
  display_name    text,
  avatar_url      text,
  tier            text NOT NULL DEFAULT 'free'
                    CHECK (tier IN ('free','personal','pro')),
  stripe_customer_id text,
  region          text NOT NULL DEFAULT 'eu-central-1',
  locale          text NOT NULL DEFAULT 'fr',
  onboarding_completed_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz  -- soft delete pour RGPD 72h
);

CREATE INDEX idx_users_stripe ON users(stripe_customer_id);
CREATE INDEX idx_users_deleted ON users(deleted_at) WHERE deleted_at IS NOT NULL;
```

#### `context_nodes`

```sql
CREATE TABLE context_nodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          text NOT NULL,           -- 'extension' | 'connector:gmail' | 'manual' | 'mcp'
  source_url      text,                    -- URL source si applicable
  source_app      text,                    -- 'claude.ai' | 'chatgpt.com' | 'slack' | etc.
  content         text NOT NULL,
  summary         text,                    -- Groq llama-3.3-70b, ≤2 phrases
  embedding       vector(1024),            -- Jina v3, indexé HNSW
  embedding_model text DEFAULT 'jina-v3',  -- pour migrations futures
  entities        jsonb DEFAULT '[]'::jsonb,
                  -- format: [{"type":"PERSON","value":"Sophie","normalized":"sophie"}, ...]
  tags            text[] DEFAULT '{}',
  user_tags       text[] DEFAULT '{}',     -- tags ajoutés manuellement
  score           float CHECK (score BETWEEN 0 AND 1), -- score de capture
  sensitivity     float CHECK (sensitivity BETWEEN 0 AND 1),
  acl_agents      text[] DEFAULT '{*}',    -- agents autorisés à voir ce nœud
  ttl_at          timestamptz,             -- expiration optionnelle
  pinned          boolean DEFAULT false,
  edited_summary  text,                    -- override user si édité
  fingerprint     text NOT NULL,           -- SHA-256 pour dedup
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Index critiques
CREATE INDEX idx_nodes_user_created ON context_nodes(user_id, created_at DESC);
CREATE INDEX idx_nodes_user_source ON context_nodes(user_id, source);
CREATE INDEX idx_nodes_embedding ON context_nodes
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_nodes_entities ON context_nodes USING gin(entities);
CREATE INDEX idx_nodes_tags ON context_nodes USING gin(tags);
CREATE INDEX idx_nodes_fingerprint ON context_nodes(user_id, fingerprint);
CREATE INDEX idx_nodes_ttl ON context_nodes(ttl_at) WHERE ttl_at IS NOT NULL;

-- Full-text search hybride
ALTER TABLE context_nodes ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('french', coalesce(summary,'')), 'A') ||
    setweight(to_tsvector('french', coalesce(content,'')), 'B')
  ) STORED;
CREATE INDEX idx_nodes_fts ON context_nodes USING gin(content_tsv);

-- RLS strict
ALTER TABLE context_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY nodes_own_only ON context_nodes
  FOR ALL USING (user_id = auth.uid());
```

#### `context_edges`

```sql
CREATE TABLE context_edges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_node       uuid NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  to_node         uuid NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  relation_type   text NOT NULL
                    CHECK (relation_type IN
                      ('inferred','explicit','temporal','contradicts','supersedes','user_linked')),
  confidence      float CHECK (confidence BETWEEN 0 AND 1),
  shared_entity   text,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_edges_user_from ON context_edges(user_id, from_node);
CREATE INDEX idx_edges_user_to ON context_edges(user_id, to_node);
CREATE INDEX idx_edges_relation ON context_edges(user_id, relation_type);

ALTER TABLE context_edges ENABLE ROW LEVEL SECURITY;
CREATE POLICY edges_own_only ON context_edges
  FOR ALL USING (user_id = auth.uid());
```

#### `injections` (log des injections cross-agent)

```sql
CREATE TABLE injections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_agent    text NOT NULL,           -- 'claude.ai' | 'chatgpt.com' | etc.
  query_hash      text NOT NULL,           -- SHA-256, jamais le contenu brut
  query_excerpt   text,                    -- 100 premiers caractères, opt-in user
  node_ids        uuid[] NOT NULL,
  injected_text   text,                    -- ce qui a été injecté (audit)
  user_accepted   boolean,                 -- l'user a-t-il validé l'injection
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_injections_user_created ON injections(user_id, created_at DESC);
CREATE INDEX idx_injections_agent ON injections(user_id, target_agent);

ALTER TABLE injections ENABLE ROW LEVEL SECURITY;
CREATE POLICY injections_own_only ON injections
  FOR ALL USING (user_id = auth.uid());
```

#### `connectors` (Agent Hub)

```sql
CREATE TABLE connectors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,           -- 'gmail' | 'slack' | 'notion' | 'gcal'
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','paused','error','revoked')),
  oauth_access_token  text,                -- chiffré at rest via pgcrypto
  oauth_refresh_token text,                -- idem
  oauth_expires_at    timestamptz,
  scopes          text[],
  last_sync_at    timestamptz,
  last_sync_cursor text,                   -- pagination / delta token
  sync_settings   jsonb DEFAULT '{}'::jsonb,
                  -- ex Slack: {"channels": ["C123"], "exclude_dms": true}
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_connectors_user_provider ON connectors(user_id, provider);
ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY connectors_own_only ON connectors
  FOR ALL USING (user_id = auth.uid());
```

#### `context_rules` (ACL utilisateur)

```sql
CREATE TABLE context_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_type       text NOT NULL CHECK (rule_type IN ('agent_acl','tag_block','domain_block','time_window')),
  target          text NOT NULL,           -- 'chatgpt.com' | tag | domaine
  action          text NOT NULL CHECK (action IN ('allow','deny','redact')),
  filter          jsonb DEFAULT '{}'::jsonb,
  priority        integer DEFAULT 100,
  enabled         boolean DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rules_user ON context_rules(user_id, priority DESC);
ALTER TABLE context_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY rules_own_only ON context_rules
  FOR ALL USING (user_id = auth.uid());
```

#### `audit_log` (immuable, RGPD)

```sql
CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  operation       text NOT NULL,
                  -- 'node.create'|'node.delete'|'injection'|'connector.add'|'export'|'wipe'
  node_ids        uuid[],
  source          text,
  ip_hash         text,                    -- SHA-256(ip + salt), jamais l'IP brute
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_user_created ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_operation ON audit_log(operation, created_at DESC);

-- Immuabilité : aucun UPDATE/DELETE autorisé via RLS
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read_own ON audit_log FOR SELECT USING (user_id = auth.uid());
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);
-- Pas de policy UPDATE ni DELETE = impossible
```

#### `usage_metrics`

```sql
CREATE TABLE usage_metrics (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            date NOT NULL,
  nodes_created   integer DEFAULT 0,
  pulls_count     integer DEFAULT 0,
  injections_count integer DEFAULT 0,
  llm_cost_cents  integer DEFAULT 0,        -- coût LLM agrégé du jour
  PRIMARY KEY (user_id, date)
);

ALTER TABLE usage_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY metrics_own_only ON usage_metrics FOR ALL USING (user_id = auth.uid());
```

### 4.2 Politique de rétention par tier

| Tier | Nœuds max | TTL par défaut | Historique injections |
|---|---|---|---|
| Free | 1 000 (FIFO) | 30 jours | 30 jours |
| Personal | Illimité | Permanent | 12 mois |
| Pro | Illimité | Permanent | Illimité + export |

Job `pg_cron` quotidien :
```sql
-- Cleanup expired nodes
DELETE FROM context_nodes
WHERE ttl_at IS NOT NULL AND ttl_at < now();

-- FIFO Free tier
WITH ranked AS (
  SELECT n.id,
         row_number() OVER (PARTITION BY n.user_id ORDER BY n.created_at DESC) AS rn
  FROM context_nodes n
  JOIN users u ON u.id = n.user_id
  WHERE u.tier = 'free' AND n.pinned = false
)
DELETE FROM context_nodes WHERE id IN (SELECT id FROM ranked WHERE rn > 1000);
```

### 4.3 Suppression RGPD (right to be forgotten)

Procédure stockée appelée par l'API `DELETE /api/account` :

```sql
CREATE OR REPLACE FUNCTION request_account_deletion(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- 1. Soft delete immédiat (user perd l'accès)
  UPDATE users SET deleted_at = now() WHERE id = p_user_id;

  -- 2. Log audit
  INSERT INTO audit_log (user_id, operation, metadata)
  VALUES (p_user_id, 'wipe.requested', jsonb_build_object('scheduled_at', now() + interval '72 hours'));

  -- 3. Job pgmq pour suppression hard à +72h
  PERFORM pgmq.send('account_wipe', jsonb_build_object('user_id', p_user_id), 259200);
END;
$$;
```

Worker `account_wipe` (cf. section 7.5) effectue le DELETE CASCADE après 72h.

---

## 5. Module 1 — Extension navigateur (capture passive)

### 5.1 Architecture interne

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                 │
├─────────────────────────────────────────────────────────┤
│  Tab 1: claude.ai                                        │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Content Script (injected)                          │ │
│  │  - DOMObserver (MutationObserver)                   │ │
│  │  - SignalExtractor (6 signal types)                 │ │
│  │  - QueryInterceptor (cross-agent injection trigger) │ │
│  └────────────┬───────────────────────────────────────┘ │
│               │ chrome.runtime.sendMessage              │
│               ▼                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Background Service Worker                           ││
│  │  - DedupQueue (Dexie IndexedDB, SHA-256 fingerprint)││
│  │  - ContextScorer (local llama via Groq API)         ││
│  │  - InjectionEngine (pull + inject orchestration)    ││
│  │  - APIClient (auth, retry, offline buffering)       ││
│  └────────────┬────────────────────────────────────────┘│
│               │ HTTPS                                    │
│               ▼                                          │
│         Mesh API Gateway                                 │
│                                                          │
│  Popup UI (React): live captures, settings, status      │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Les 6 signaux capturés

| # | Signal | Trigger | Données extraites | Latence |
|---|---|---|---|---|
| 1 | Reading | scroll >70% + dwell >45s | title, summary auto, URL, entities | async |
| 2 | AI session end | fin conversation claude.ai / chatgpt.com / etc. | résumé conversation | <3s post-fin |
| 3 | Search | query Google/Bing + clic résultat + dwell >30s | query, page cible, snippet | async |
| 4 | Decision | form submit, checkout, signup, accept ToS | titre form, contexte page | sync |
| 5 | Active work | Notion / Google Docs / Linear / GitHub | titre doc + résumé bloc édité | debounce 60s |
| 6 | Temporal | dates, deadlines extraits NER | entité date + contexte phrase | async |

### 5.3 Context Scorer — algorithme

```typescript
interface ScoringInput {
  content: string;
  url: string;
  signalType: SignalType;
  dwellMs: number;
  scrollDepth: number;
  domNoise: number;  // ratio chrome UI vs main content
}

interface ScoringOutput {
  score: number;       // 0-1
  relevance: number;
  novelty: number;
  intent: number;
  sensitivity: number; // si >0.7 → BLOCK
  reason: string;
}

function score(input: ScoringInput): ScoringOutput {
  const relevance = computeRelevance(input);   // longueur, structure, NER richness
  const novelty   = computeNovelty(input);     // diff vs derniers 50 nœuds (cosine local)
  const intent    = computeIntent(input);      // signal type weight + dwell
  const sensitivity = detectSensitive(input);  // patterns: SSN, IBAN, mots-clés santé/sexe

  const score = relevance * 0.40 + novelty * 0.30 + intent * 0.30;

  return { score, relevance, novelty, intent, sensitivity, reason: explain(score) };
}

// Décision finale
if (sensitivity > 0.7) return DROP_AND_LOG_LOCAL;
if (score > 0.55)      return PUSH_TO_API;
                       return DROP_SILENT;
```

### 5.4 Détection de sensitivity (côté client, local)

Liste de patterns regex + heuristiques compilées localement (jamais envoyés au serveur si bloqués) :

```typescript
const SENSITIVE_PATTERNS = [
  // Identifiants
  /\b\d{13,16}\b/,                          // card numbers
  /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/,        // IBAN
  /\b\d{3}-\d{2}-\d{4}\b/,                  // SSN
  // Auth
  /password\s*[:=]\s*\S+/i,
  /token\s*[:=]\s*[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,                    // OpenAI keys
  // Santé/médical (FR)
  /\b(diagnostic|ordonnance|psychiatr|HIV|sida|cancer|VIH)\b/i,
];

const SENSITIVE_DOMAINS = [
  'mail.google.com','outlook.live.com','protonmail.com','tuta.com',
  'impots.gouv.fr','ameli.fr','service-public.fr','urssaf.fr',
  'doctolib.fr','sante.fr',
  /^https:\/\/.*\.(mabanque|monespace|secure)\./,
  'facebook.com/messages','wa.me','web.whatsapp.com','signal.org',
];
```

### 5.5 Storage local (Dexie / IndexedDB)

```typescript
// db.ts
class MeshLocalDB extends Dexie {
  queue!: Table<QueuedNode>;
  fingerprints!: Table<{ hash: string; ts: number }>;
  settings!: Table<{ key: string; value: any }>;

  constructor() {
    super('mesh-ext-db');
    this.version(1).stores({
      queue: '++id, status, ts',
      fingerprints: 'hash, ts',
      settings: 'key',
    });
  }
}
```

**Politique** :
- Queue offline : max 500 items, FIFO si full
- Fingerprints : retention 30 jours (cleanup automatique)
- Réessai exponentiel sur push échoué (1s, 5s, 30s, 5min)

### 5.6 Permissions Manifest V3

```json
{
  "manifest_version": 3,
  "name": "Mesh — Your AI memory",
  "permissions": ["storage", "activeTab", "scripting", "alarms"],
  "host_permissions": [
    "https://*.claude.ai/*",
    "https://chatgpt.com/*",
    "https://gemini.google.com/*",
    "https://www.perplexity.ai/*",
    "https://api.mesh.so/*"
  ],
  "optional_host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://*/*"], "js": ["content.js"], "run_at": "document_idle" }
  ],
  "action": { "default_popup": "popup.html" }
}
```

**Note critique** : on demande `optional_host_permissions: <all_urls>` à l'install, pas en permission obligatoire. L'user accorde explicitement le watch global après onboarding. Friction acceptable car valeur claire.

### 5.7 Popup UI

Composants (React + Tailwind) :
- **Live capture feed** : 5 derniers nœuds avec score, source, action delete
- **Today's stats** : N captures, M dropped (sensitivity), K injections
- **Quick toggle** : pause global (15min / 1h / jusqu'à demain)
- **Domain controls** : liste des sites actifs/bloqués, ajout rapide
- **Open dashboard** : lien vers web app
- **Account status** : tier, quotas restants

---

## 6. Module 2 — Context Injection Engine (killer feature)

### 6.1 Vue d'ensemble

L'injection cross-agent est **le différenciateur unique** de Mesh. Quand l'utilisateur tape une requête dans un agent supporté, l'extension :

1. Intercepte la requête avant envoi
2. Score la pertinence d'une injection
3. Pull les nœuds pertinents depuis Mesh
4. Filtre selon les Context Rules (ACL agent destinataire)
5. Injecte le contexte dans le prompt
6. Affiche un indicateur visuel et autorise l'edit/skip user

### 6.2 Agents supportés au MVP

| Agent | Méthode d'injection | Stabilité |
|---|---|---|
| Claude.ai | DOM injection (préfixe textarea) | ⚠️ Fragile (UI change) |
| ChatGPT (chatgpt.com) | DOM injection | ⚠️ Fragile |
| Claude Desktop | MCP server natif | ✅ Robuste |
| Cursor | MCP server natif | ✅ Robuste |
| Perplexity | DOM injection | ⚠️ Fragile |
| Gemini | DOM injection | ⚠️ Fragile |

**Stratégie hybride** : MCP partout où c'est supporté (robuste), DOM injection pour les agents web sans MCP (fragile mais nécessaire pour le pitch B2C).

### 6.3 Architecture du flow d'injection

```
User types in agent UI
        │
        ▼
┌──────────────────────────┐
│ QueryInterceptor         │  (Content Script)
│ - Detect submit event    │
│ - Extract query text     │
└─────────┬────────────────┘
          │
          ▼
┌──────────────────────────┐
│ InjectionTriggerScorer   │  (Background)
│ - Local Groq llama-8b    │
│ - Decide: inject Y/N     │  (latence cible <100ms)
└─────────┬────────────────┘
          │ if score > 0.4
          ▼
┌──────────────────────────┐
│ Mesh API: /api/inject    │
│ - pull(query, topK=5)    │  (latence cible <150ms)
│ - apply Context Rules    │
│ - format context block   │
└─────────┬────────────────┘
          │
          ▼
┌──────────────────────────┐
│ InjectionUI overlay      │
│ - Show "+3 nodes ready"  │
│ - Allow edit/skip        │
│ - Auto-confirm <2s       │
└─────────┬────────────────┘
          │
          ▼
┌──────────────────────────┐
│ Inject into agent UI     │
│ - Prefix textarea OR     │
│ - System prompt rewrite  │
└─────────┬────────────────┘
          │
          ▼
   User submits → agent receives augmented prompt
```

### 6.4 Trigger Scorer — décider quand injecter

Pas toutes les requêtes méritent une injection. Le scorer décide en <100ms local :

```typescript
interface TriggerInput {
  query: string;
  agent: string;
  recentNodes: NodePreview[];  // 50 derniers nœuds, cached locally
}

async function shouldInject(input: TriggerInput): Promise<boolean> {
  // 1. Pré-filtre rapide : skip si query trop courte ou trivial
  if (input.query.length < 8) return false;
  if (TRIVIAL_PATTERNS.some(p => p.test(input.query))) return false;
  // ex: "what time", "translate to", "spell check"

  // 2. Entity matching local
  const queryEntities = await extractEntitiesLocal(input.query); // Groq 8b
  const overlap = countEntityOverlap(queryEntities, input.recentNodes);
  if (overlap >= 2) return true;

  // 3. Semantic similarity quick check
  const queryEmbed = await embedLocal(input.query);  // mini embedding model
  const maxSim = computeMaxSimilarity(queryEmbed, input.recentNodes);
  return maxSim > 0.35;
}
```

### 6.5 Format du contexte injecté

```
[Context from Mesh — your personal memory]
- (3 days ago) Sophie is lead designer on Project Falcon, deadline June 15.
- (today) Last conversation with Sophie: she requested less copy in onboarding.
- (1 week ago) Project Falcon budget approved €45k, focus on mobile-first.

Your query:
{original user query here}
```

**Règles de formatage** :
- Max 5 nœuds (configurable Personal/Pro)
- Tri par cosine sim desc puis recency
- Inclure timestamp relatif ("3 days ago") pour aider l'agent à pondérer
- Total injecté ≤ 1500 tokens (sinon truncate)
- Toujours mettre la query user à la fin (pas perdue dans le contexte)

### 6.6 UI overlay d'injection

Component injecté par le Content Script, positionné au-dessus de la textarea cible :

```
┌─────────────────────────────────────────────────┐
│ 🧠 Mesh found 3 relevant context items     [✏️] │
│ ├─ Sophie · lead designer · Project Falcon      │
│ ├─ Last meeting Sophie · less copy request      │
│ └─ Project Falcon · €45k budget · mobile-first  │
│                                                  │
│ [Inject] [Edit] [Skip this time]    auto in 2s  │
└─────────────────────────────────────────────────┘
```

**Comportements** :
- Auto-inject après 2s si pas d'action user (configurable : auto/confirm)
- Edit ouvre un mini-modal pour décocher/réordonner
- Skip mémorise le pattern (skip si query similaire prochaine fois)
- Indicateur "Privacy: ChatGPT will see this content" pour agents non-EU

### 6.7 MCP server (pour agents qui le supportent)

```typescript
// packages/mcp-server/src/index.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const server = new Server({ name: 'mesh', version: '1.0.0' });

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'mesh_pull',
      description: 'Retrieve relevant context from user personal Mesh graph',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'number', default: 5 },
        },
        required: ['query'],
      },
    },
    {
      name: 'mesh_traverse',
      description: 'Explore graph around an entity',
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string' },
          depth: { type: 'number', default: 2 },
        },
        required: ['entity'],
      },
    },
  ],
}));

server.setRequestHandler('tools/call', async (req) => {
  const apiKey = process.env.MESH_API_KEY;
  const response = await fetch(`https://api.mesh.so/v1/${req.params.name}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(req.params.arguments),
  });
  return response.json();
});
```

Installation user : `claude mcp add mesh npx @mesh/mcp-server` avec MESH_API_KEY dans env.

### 6.8 Sécurité de l'injection

- **Jamais injecter sans visibilité user** : overlay obligatoire, même en auto-mode
- **Logging complet** dans table `injections` (audit RGPD)
- **Context Rules priorité absolue** : si une rule bloque, pas d'injection (silencieux côté agent)
- **Rate limit** : max 100 injections/jour Free, 1000 Personal, illimité Pro
- **Kill switch global** : toggle "pause injections" dans extension popup

---

## 7. Module 3 — Backend API & pipeline

### 7.1 API REST publique

Base URL : `https://api.mesh.so/v1`
Auth : `Authorization: Bearer <JWT>` (Supabase Auth) ou API key Pro

#### Endpoints principaux

```
POST   /v1/nodes              Create node (push)
GET    /v1/nodes              List user nodes (paginated)
GET    /v1/nodes/:id          Get single node
PATCH  /v1/nodes/:id          Edit summary/tags/pin
DELETE /v1/nodes/:id          Delete node

POST   /v1/search             Semantic + FTS hybrid search
POST   /v1/traverse           Graph traversal from entity
POST   /v1/inject             Get context for injection (extension)

GET    /v1/connectors         List user connectors
POST   /v1/connectors/:provider/auth   Start OAuth flow
DELETE /v1/connectors/:id     Disconnect

GET    /v1/rules              List context rules
POST   /v1/rules              Create rule
PATCH  /v1/rules/:id          Update rule
DELETE /v1/rules/:id          Delete rule

GET    /v1/insights/weekly    Latest weekly digest
GET    /v1/usage              Current usage vs quotas
GET    /v1/audit              Audit log (read-only)
POST   /v1/export             Full data export (RGPD)
DELETE /v1/account            Request account deletion (RGPD)
```

#### Spec OpenAPI extrait — POST /v1/nodes

```yaml
POST /v1/nodes:
  request:
    content: string (required, max 50000 chars)
    source: string (required)
    source_url: string (optional)
    source_app: string (optional)
    tags: string[] (optional)
    ttl: string (optional, e.g. "30d")
    acl_agents: string[] (optional, default ["*"])
    metadata: object (optional)
  response 201:
    node_id: string (uuid)
    summary: string (Groq-generated, ≤2 sentences)
    entities: Entity[]
    created_at: timestamptz
  errors:
    400: invalid payload
    401: unauthorized
    402: quota exceeded
    429: rate limited
```

### 7.2 Rate limiting

Upstash Redis sliding window. Limites par tier :

| Tier | Writes/min | Pulls/min | Injections/day |
|---|---|---|---|
| Free | 30 | 60 | 100 |
| Personal | 120 | 300 | 1000 |
| Pro | 600 | unlimited | unlimited |

Implementation Deno Edge Function :

```typescript
import { Redis } from 'https://deno.land/x/upstash_redis/mod.ts';
const redis = new Redis({ url: Deno.env.get('UPSTASH_URL')!, token: Deno.env.get('UPSTASH_TOKEN')! });

async function rateLimit(userId: string, action: string, limit: number, windowSec: number) {
  const key = `rl:${userId}:${action}`;
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  await redis.zremrangebyscore(key, 0, windowStart);
  const count = await redis.zcard(key);
  if (count >= limit) throw new Response('Rate limited', { status: 429 });
  await redis.zadd(key, { score: now, member: `${now}-${crypto.randomUUID()}` });
  await redis.expire(key, windowSec);
}
```

### 7.3 Pipeline post-push (9 étapes)

```
push() received
    │
    ▼ STEP 1: Validation & auth (sync)
    │   - JWT verify
    │   - Quota check
    │   - Payload validation (size, schema)
    │
    ▼ STEP 2: Insert initial (sync)
    │   - Generate node_id
    │   - INSERT minimal row (content, user_id, source, fingerprint)
    │   - Return node_id to client < 200ms
    │
    ├─→ STEP 3: Enqueue async jobs (pgmq)
    │       jobs: ['ner', 'summary', 'embed', 'edge_infer']
    │
    ▼ STEP 4: NER (async, ~1-2s)
    │   - Groq llama-3.1-8b
    │   - Extract entities, normalize, write to nodes.entities
    │
    ▼ STEP 5: Summary (async, ~2-4s)
    │   - Groq llama-3.3-70b
    │   - Generate ≤2 sentence summary
    │   - Update nodes.summary
    │
    ▼ STEP 6: Embedding (async, ~300-800ms)
    │   - Jina v3 API call
    │   - Update nodes.embedding
    │   - Trigger HNSW index update
    │
    ▼ STEP 7: Edge inference (async, ~1-3s)
    │   - Find nodes sharing entities (last 1000)
    │   - For each candidate: compute combined score
    │   - INSERT context_edges where score > 0.3
    │
    ▼ STEP 8: Realtime notify (async)
    │   - Supabase Realtime broadcast on user channel
    │   - Web app + extension popup update
    │
    ▼ STEP 9: Audit log (async)
        - INSERT audit_log row
```

### 7.4 Workers (pgmq + pg_cron)

```sql
-- Queues
SELECT pgmq.create('ner');
SELECT pgmq.create('summary');
SELECT pgmq.create('embed');
SELECT pgmq.create('edge_infer');
SELECT pgmq.create('connector_sync');
SELECT pgmq.create('account_wipe');
SELECT pgmq.create('weekly_insights');

-- Cron jobs (pg_cron)
SELECT cron.schedule('cleanup-ttl', '*/15 * * * *', $$
  DELETE FROM context_nodes WHERE ttl_at < now();
$$);

SELECT cron.schedule('connector-sync', '*/10 * * * *', $$
  SELECT pgmq.send('connector_sync', jsonb_build_object('connector_id', id))
  FROM connectors WHERE status = 'active'
    AND (last_sync_at IS NULL OR last_sync_at < now() - interval '10 minutes');
$$);

SELECT cron.schedule('weekly-insights', '0 9 * * 1', $$
  SELECT pgmq.send('weekly_insights', jsonb_build_object('user_id', id))
  FROM users WHERE tier IN ('personal','pro') AND deleted_at IS NULL;
$$);
```

Workers consomment depuis Edge Functions invoquées sur trigger Realtime ou cron-poll. Pattern :

```typescript
// supabase/functions/worker-embed/index.ts
Deno.serve(async () => {
  const messages = await pgmq.read('embed', vt=30, qty=10);
  for (const msg of messages) {
    try {
      const node = await db.from('context_nodes').select('*').eq('id', msg.message.node_id).single();
      const embedding = await jinaEmbed(node.summary || node.content);
      await db.from('context_nodes').update({ embedding }).eq('id', node.id);
      await pgmq.delete('embed', msg.msg_id);
    } catch (e) {
      // archive after 5 retries
      if (msg.read_ct >= 5) await pgmq.archive('embed', msg.msg_id);
    }
  }
  return new Response('ok');
});
```

### 7.5 Search hybride (dense + sparse)

```sql
CREATE OR REPLACE FUNCTION hybrid_search(
  p_user_id uuid,
  p_query text,
  p_query_embedding vector(1024),
  p_top_k integer DEFAULT 5,
  p_filter_tags text[] DEFAULT NULL,
  p_filter_since interval DEFAULT NULL
) RETURNS TABLE(...) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH dense AS (
    SELECT id, 1 - (embedding <=> p_query_embedding) AS score
    FROM context_nodes
    WHERE user_id = p_user_id
      AND (p_filter_tags IS NULL OR tags && p_filter_tags)
      AND (p_filter_since IS NULL OR created_at > now() - p_filter_since)
    ORDER BY embedding <=> p_query_embedding
    LIMIT 50
  ),
  sparse AS (
    SELECT id, ts_rank(content_tsv, plainto_tsquery('french', p_query)) AS score
    FROM context_nodes
    WHERE user_id = p_user_id
      AND content_tsv @@ plainto_tsquery('french', p_query)
    LIMIT 50
  ),
  combined AS (
    SELECT id, COALESCE(d.score,0) * 0.7 + COALESCE(s.score,0) * 0.3 AS final_score
    FROM dense d FULL OUTER JOIN sparse s USING (id)
  )
  SELECT n.*, c.final_score
  FROM combined c JOIN context_nodes n ON n.id = c.id
  ORDER BY c.final_score DESC
  LIMIT p_top_k;
END;
$$;
```

### 7.6 SLA cibles

| Endpoint | P50 | P95 | P99 |
|---|---|---|---|
| POST /nodes | <150ms | <300ms | <600ms |
| POST /search | <80ms | <150ms | <350ms |
| POST /inject | <120ms | <200ms | <450ms |
| POST /traverse | <150ms | <300ms | <700ms |
| WS realtime event | <500ms post-event | <1s | <2s |

---

## 8. Module 4 — Connecteurs API (Agent Hub)

### 8.1 Connecteurs prioritaires au MVP

| # | Provider | Méthode | Capture | Priorité |
|---|---|---|---|---|
| 1 | Gmail | OAuth + Gmail API watch | Emails envoyés uniquement (pas reçus) | P0 |
| 2 | Google Calendar | OAuth + Calendar API watch | Events à venir + participants | P0 |
| 3 | Slack | OAuth + Events API (RTM/webhook) | Messages dans channels choisis (pas DMs par défaut) | P1 |
| 4 | Notion | OAuth + polling diff | Pages éditées, blocs ajoutés | P1 |

V2 (mois 8+) : Linear, GitHub, Google Docs, Figma.

### 8.2 Architecture connecteur générique

```typescript
interface Connector {
  provider: string;
  oauthFlow(): OAuthFlow;
  sync(state: SyncState): Promise<SyncResult>;
  webhook?(payload: unknown): Promise<void>;
  scopes: string[];
  syncIntervalSec: number;
}

interface SyncResult {
  newNodes: NodeInput[];
  nextCursor: string;
  errors: SyncError[];
}
```

### 8.3 Exemple détaillé — Gmail connector

```typescript
class GmailConnector implements Connector {
  provider = 'gmail';
  scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  syncIntervalSec = 600;  // 10 min

  oauthFlow() {
    return new GoogleOAuthFlow({
      clientId: env.GOOGLE_CLIENT_ID,
      scopes: this.scopes,
      redirectUri: `${env.PUBLIC_URL}/api/connectors/gmail/callback`,
    });
  }

  async sync(state: SyncState): Promise<SyncResult> {
    const cursor = state.cursor ?? null;
    const gmail = google.gmail({ version: 'v1', auth: state.oauthClient });

    // Use Gmail history API for incremental sync
    const history = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: cursor ?? undefined,
      historyTypes: ['messageAdded'],
      labelId: 'SENT',
    });

    const newNodes: NodeInput[] = [];
    for (const h of history.data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.message.id, format: 'full' });
        const content = extractTextFromMessage(msg.data);
        if (content.length < 50) continue;  // skip trivial
        newNodes.push({
          content,
          source: 'connector:gmail',
          source_app: 'gmail',
          tags: ['email','sent'],
          metadata: { subject: extractSubject(msg.data), to: extractTo(msg.data) },
        });
      }
    }

    return {
      newNodes,
      nextCursor: history.data.historyId,
      errors: [],
    };
  }
}
```

### 8.4 Sécurité des tokens OAuth

```sql
-- Chiffrement at rest avec pgcrypto
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Fonction helper
CREATE OR REPLACE FUNCTION encrypt_token(p_token text) RETURNS text
LANGUAGE sql AS $$
  SELECT encode(
    pgp_sym_encrypt(p_token, current_setting('app.encryption_key')),
    'base64'
  );
$$;

CREATE OR REPLACE FUNCTION decrypt_token(p_encrypted text) RETURNS text
LANGUAGE sql AS $$
  SELECT pgp_sym_decrypt(
    decode(p_encrypted, 'base64')::bytea,
    current_setting('app.encryption_key')
  );
$$;
```

`app.encryption_key` est défini via Supabase Vault, jamais en clair dans le code.

### 8.5 UI Agent Hub

Composant dashboard, route `/settings/connectors` :

```
┌────────────────────────────────────────────────┐
│ Agent Hub — Connect your tools                  │
├────────────────────────────────────────────────┤
│  ✅ Gmail         · Synced 3 min ago    [⚙️] [❌]│
│     Captures sent emails only                   │
│                                                  │
│  ✅ Google Cal    · Synced 8 min ago    [⚙️] [❌]│
│     Upcoming events + participants              │
│                                                  │
│  ⚪ Slack         · Not connected       [Connect]│
│  ⚪ Notion        · Not connected       [Connect]│
│                                                  │
│  Coming soon: Linear, GitHub, Figma             │
└────────────────────────────────────────────────┘
```

### 8.6 Settings granulaires par connecteur

Exemple Slack :
- Channels à surveiller (default: none, opt-in chaque channel)
- Inclure les DMs ? (default: off)
- Inclure les mentions uniquement ? (filter)
- Période de rétention des messages (TTL override)

Exemple Gmail :
- Filtrer par label
- Exclure les emails à certains domaines (ex: pas les newsletters)
- Inclure les drafts ? (default: off)

---

## 9. Module 5 — Application web (dashboard utilisateur)

### 9.1 Routes principales

```
/                    Landing public
/login               Magic link + OAuth
/onboarding          Wizard 5 étapes (post-signup)
/timeline            Memory timeline (vue chronologique) [HOME]
/search              Search avancée
/graph               Graph Explorer (Cytoscape)
/insights            Weekly digests
/connectors          Agent Hub
/rules               Context Rules (drag-and-drop)
/agents              Cross-agent injection settings
/settings            Account, billing, privacy
/settings/export     RGPD export
/settings/delete     Account deletion
```

### 9.2 Memory Timeline (vue principale)

Layout :

```
┌─────────────────────────────────────────────────────────────┐
│ Search bar (semantic + filters)                              │
├──────────────┬──────────────────────────────────────────────┤
│ Filters      │ Today                                          │
│ ─────────    │ ┌─────────────────────────────────────────┐  │
│ ▶ Sources    │ │ 14:32 · claude.ai · 0.78               │  │
│  ☑ Extension │ │ Conversation about Project Falcon      │  │
│  ☑ Gmail     │ │ Entities: Sophie, Falcon, June 15      │  │
│  ☑ Slack     │ │ [Edit] [Delete] [Pin]                  │  │
│ ▶ Tags       │ └─────────────────────────────────────────┘  │
│ ▶ Date range │                                                │
│ ▶ Entities   │ Yesterday                                      │
│              │ ┌─────────────────────────────────────────┐  │
│              │ │ 09:15 · gmail · 0.65                   │  │
│ ...          │ │ Sent email to Sophie re: copy revisions│  │
│              │ └─────────────────────────────────────────┘  │
└──────────────┴──────────────────────────────────────────────┘
```

**Features** :
- Pagination infinite scroll (20 items/batch)
- Inline edit du summary
- Delete avec confirmation (irréversible, log audit)
- Pin (exclu du FIFO Free tier)
- Multi-select pour bulk delete/tag
- Filtres combinables, persistés en URL params

### 9.3 Graph Explorer

Cytoscape force-directed, performance jusqu'à 5k nodes :

- Nodes colorés par source (extension/gmail/slack/manual)
- Taille proportionnelle au degré (nombre d'edges)
- Edge types visuellement distincts (couleur/style)
- Clic node → side panel avec détails
- Hover → highlight neighbors
- Recherche entité → centre + zoom
- Time slider → filter par date range
- Export PNG / JSON

### 9.4 Context Rules — drag-and-drop UI

```
┌──────────────────────────────────────────────────────────┐
│ Context Rules — Who sees what                             │
├──────────────────────────────────────────────────────────┤
│                                                            │
│   AGENTS         │  WHAT THEY CAN ACCESS                  │
│   ─────────      │  ─────────────────────                 │
│   Claude     ──→ │  ☑ Work  ☑ Personal  ☑ Health         │
│                  │  Drag tags here to allow/block         │
│                  │                                         │
│   ChatGPT    ──→ │  ☑ Work  ☐ Personal  ☐ Health         │
│                  │  [Personal blocked]                     │
│                  │                                         │
│   Gemini     ──→ │  ☐ Work  ☐ Personal  ☐ Health         │
│                  │  [Fully blocked — opt-in required]     │
│                  │                                         │
│   Cursor     ──→ │  ☑ Work-tech only                     │
│                                                            │
│   [+ Add custom rule]                                     │
│                                                            │
│   PREVIEW: "If ChatGPT pulled right now, it would see    │
│             127 nodes (out of 482)"                       │
└──────────────────────────────────────────────────────────┘
```

### 9.5 Weekly Insights

Email + page web. Généré par DeepSeek tous les lundis 9h locale user.

Format :
- **Top 3 thèmes** de la semaine (entités/tags dominants)
- **Personnes clés** mentionnées (réseau social inféré)
- **Décisions prises** (signal type 'decision')
- **Things you'll forget if you don't act** (TTL imminent)
- **Contradictions détectées** (si applicable)

---

## 10. Module 6 — IA layer (embeddings, NER, scoring)

### 10.1 Choix des modèles et coûts

| Tâche | Modèle | Fournisseur | Latence | Coût/req (€) |
|---|---|---|---|---|
| Embeddings | jina-embeddings-v3 | Jina AI | ~300ms | 0.0001 |
| NER sync | llama-3.1-8b-instant | Groq | ~80ms | 0.0005 |
| Summary | llama-3.3-70b-versatile | Groq | ~1.5s | 0.004 |
| Trigger scorer | llama-3.1-8b-instant | Groq | ~80ms | 0.0005 |
| Contradictions | deepseek-reasoner | DeepSeek | ~20s | 0.002 |
| Weekly insights | deepseek-reasoner | DeepSeek | ~30s | 0.005 |

### 10.2 Coût par utilisateur (worst case)

**Persona prosumer actif** :
- 80 nœuds créés/jour
- 30 injections/jour
- Edge inference background

Coût LLM par user/mois :
```
80 nodes/day × 30 days × (NER 0.0005 + Summary 0.004 + Embed 0.0001) = €10.95
30 injections/day × 30 days × (trigger 0.0005 + pull search) = €0.45
Edge inference background = ~€0.50
Weekly insight 4× = €0.02
Total ≈ €11.92/mois
```

À **€19-29/mois** prosumer pricing, marge brute = 40-60%. **À surveiller de très près au lancement.**

**Optimisations critiques** :

1. **Cache embeddings** : ne pas re-embedder si fingerprint hit (Redis 90 jours). Économie ~30%.
2. **Batch les NER** : Groq batch API accepte 50 docs en 1 call. Économie ~40%.
3. **Lazy summary** : seulement si node pulled ou pinned. Économie ~50% sur summaries.
4. **Tier Free agressif sur quotas** : max 30 nodes/jour → bornes le coût à €4.5/mois pour Free.

Après optimisations, coût prosumer cible : **€6-8/mois** → marge **70%+**.

### 10.3 NER pipeline détaillé

```typescript
async function extractEntities(content: string): Promise<Entity[]> {
  const prompt = `Extract named entities from this text. Return JSON array.
  Types: PERSON, ORG, LOCATION, DATE, PROJECT, PRODUCT, TOPIC.
  For each entity: {"type": ..., "value": ..., "normalized": ...}.
  Normalize = lowercase, no accents, singular.

  Text: """${content.slice(0, 4000)}"""

  JSON only, no other text:`;

  const result = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  return JSON.parse(result.choices[0].message.content).entities;
}
```

### 10.4 Edge inference

```typescript
async function inferEdges(node: Node): Promise<Edge[]> {
  // 1. Find candidate nodes sharing entities
  const candidates = await db.query(`
    SELECT id, entities, embedding, created_at
    FROM context_nodes
    WHERE user_id = $1
      AND id != $2
      AND entities ?| $3   -- jsonb operator: any shared entity
    ORDER BY created_at DESC
    LIMIT 100
  `, [node.user_id, node.id, node.entities.map(e => e.normalized)]);

  const edges: Edge[] = [];
  for (const c of candidates) {
    const sharedEntities = intersect(node.entities, c.entities);
    if (sharedEntities.length === 0) continue;

    const freqScore = Math.min(sharedEntities.length / 3, 1.0);
    const freshScore = computeFreshness(c.created_at);
    const simScore = cosineSimilarity(node.embedding, c.embedding);

    const finalScore = freqScore * 0.4 + freshScore * 0.3 + simScore * 0.3;
    if (finalScore >= 0.3) {
      edges.push({
        from_node: node.id,
        to_node: c.id,
        relation_type: 'inferred',
        confidence: finalScore,
        shared_entity: sharedEntities[0].normalized,
      });
    }
  }

  return edges;
}
```

---

## 11. Sécurité, privacy & conformité

### 11.1 Principes fondamentaux

1. **Privacy by design** — chaque feature doit répondre "comment ça respecte le RGPD ?" avant d'être codée
2. **Data minimization** — ne capturer que ce qui passe le score, jamais "au cas où"
3. **User control absolu** — toute donnée est visible, éditable, supprimable individuellement
4. **EU by default** — Supabase Frankfurt, jamais de transfert hors EU sans opt-in
5. **Pas de pub, pas de revente** — engagement contractuel CGU, impossible légalement

### 11.2 Chiffrement

| Couche | Mécanisme |
|---|---|
| Transit | TLS 1.3 obligatoire partout |
| At rest DB | Supabase storage encryption (AES-256) |
| OAuth tokens | pgcrypto AES-256 via Vault |
| Local extension | IndexedDB chiffré via Web Crypto API (clé dérivée user password) |
| Backups | Encrypted, EU only, 30 jours retention |

### 11.3 RGPD — droits utilisateur implémentés

| Droit (Article) | Implémentation |
|---|---|
| Information (13-14) | Privacy policy détaillée, consent screens granulaires |
| Accès (15) | `GET /v1/audit` + `POST /v1/export` |
| Rectification (16) | Edit inline summary + tags |
| Effacement (17) | `DELETE /v1/account` cascade 72h |
| Limitation (18) | Pause global + per-connector + per-domain |
| Portabilité (20) | Export JSON complet (nodes, edges, audit, rules) |
| Opposition (21) | Opt-out total, désactivation features |
| Décision auto (22) | Edge inference + injection toujours explicables + override user |

### 11.4 EU AI Act

Mesh = **système AI à risque limité** (Art. 50, transparence).

Obligations respectées :
- Documentation publique des modèles utilisés et limites
- Audit log structuré de chaque décision automatisée (edge, contradiction, injection)
- Explicabilité humaine sur demande (`GET /v1/nodes/:id/explain`)
- Pas de profiling commercial, jamais

### 11.5 Domaines sensibles bloqués par défaut

(cf. section 5.4 pour la liste). User peut ajouter mais pas retirer les blocages santé/banque/gouv.

### 11.6 Threat model abrégé

| Menace | Mitigation |
|---|---|
| Compromission compte user | 2FA obligatoire à partir de Personal, magic link sur Free |
| Fuite token OAuth | Chiffrement pgcrypto + rotation refresh tokens |
| Exfiltration DB | RLS strict, jamais de query cross-user possible |
| Extension XSS (site malveillant) | Content Script isolé, CSP strict |
| Prompt injection via contenu capturé | Sanitization avant injection, jamais d'exécution |
| Insider Mesh staff | Solo founder → minimisation accès, audit interne |
| Subpoena US (CLOUD Act) | Hébergement EU strict, pas de subsidiaire US |

### 11.7 Audits et certifications visés

- **An 1** : DPIA (analyse d'impact) documentée, RGPD self-assessment
- **An 2** : ISO 27001 (si revenus >€500k)
- **An 3** : SOC 2 Type II (si entrée B2B teams)

---

## 12. Authentification, billing & comptes

### 12.1 Auth

Supabase Auth avec providers :
- Email magic link (default)
- Google OAuth
- GitHub OAuth (pour prosumer dev cible)
- (V2) Apple Sign-in

2FA TOTP optionnel Free, obligatoire Personal+.

### 12.2 Onboarding

5 étapes max, skippable :

1. **Welcome** : pitch en 1 écran (15s vidéo)
2. **Install extension** : bouton "Add to Chrome" (lien direct Web Store)
3. **First capture** : page de test, extension capture devant l'user
4. **Connect agents** : link extension à compte web (auto si même browser)
5. **Optional connectors** : suggestion Gmail/Cal (skip OK)

Time-to-value cible : **< 90 secondes** entre signup et 1ère capture visible.

### 12.3 Billing (Stripe)

| Tier | Stripe Price | Periodicité |
|---|---|---|
| Personal | €9/mois ou €90/an (-17%) | Sub mensuelle |
| Pro | €19/mois ou €190/an | Sub mensuelle |

Webhooks Stripe traités :
- `customer.subscription.created` → upgrade tier
- `customer.subscription.updated` → tier change
- `customer.subscription.deleted` → downgrade Free (grace 7j)
- `invoice.payment_failed` → email + retry 3× puis downgrade

TVA EU gérée automatiquement par Stripe Tax.

### 12.4 Grille pricing

| Tier | Prix | Inclus |
|---|---|---|
| **Free** | €0 | 1000 nodes max (FIFO), extension uniquement, 100 injections/jour, TTL 30j max, 1 connecteur |
| **Personal** | €9/mois | Nodes illimités, 3 connecteurs, 1000 injections/jour, weekly insights, TTL permanent |
| **Pro** | €19/mois | + connecteurs illimités, injections illimitées, export, priority support, MCP server access, namespaces privés |

### 12.5 Quotas implementation

```typescript
const QUOTAS = {
  free:     { nodes_max: 1000, connectors_max: 1, injections_day: 100, ttl_max_days: 30 },
  personal: { nodes_max: null, connectors_max: 3, injections_day: 1000, ttl_max_days: null },
  pro:      { nodes_max: null, connectors_max: null, injections_day: null, ttl_max_days: null },
};

async function checkQuota(userId: string, action: 'create_node' | 'add_connector' | 'inject') {
  const user = await db.users.findUnique({ where: { id: userId } });
  const q = QUOTAS[user.tier];
  // ... check vs current usage
}
```

---

## 13. Observabilité & monitoring

### 13.1 Stack monitoring

| Couche | Outil |
|---|---|
| App errors | Sentry (browser + edge) |
| Logs structurés | Supabase logs + Logtail (forward) |
| Métriques business | PostHog (auto-capture + custom events) |
| Uptime checks | BetterStack ($10/mo) |
| Cost tracking | Custom dashboard via `usage_metrics` |
| LLM observability | Helicone (Groq, Jina, DeepSeek proxy) |

### 13.2 SLOs internes

| SLO | Cible | Période |
|---|---|---|
| API uptime | 99.5% | 30 jours |
| POST /nodes P95 latency | <300ms | 7 jours |
| Embedding job lag | <2 min | 24h |
| Connector sync success rate | >98% | 7 jours |
| Injection accept rate (user) | >40% | 30 jours |

### 13.3 Alerting

PagerDuty (free tier 5 users) :
- API down >2 min → email + SMS
- Job queue backlog >1000 → email
- Error rate >2% sur 5min → email
- LLM cost >€50/jour (anomalie) → email

### 13.4 Dashboards business à suivre

- **DAU/WAU/MAU** par tier
- **Conversion funnel** : signup → install ext → 1st capture → 10th capture → paid
- **Capture/jour/user** distribution
- **Injection accept rate** par agent
- **Churn cohort** mensuel
- **LLM cost per user** distribution (détecter outliers)

---

## 14. Tests, CI/CD & qualité

### 14.1 Stratégie de tests

| Niveau | Outil | Cible coverage |
|---|---|---|
| Unit (frontend) | Vitest | 60%+ logique critique |
| Unit (backend Deno) | Deno test | 70%+ |
| Integration (DB) | pgTAP | RLS policies 100% |
| E2E web app | Playwright | Happy paths + critical |
| E2E extension | Playwright + crxjs | Capture + injection flows |
| Load test | k6 | API endpoints critiques |

### 14.2 Tests RLS obligatoires

Chaque table tenant-scoped doit avoir un test :

```sql
-- tests/rls/nodes.sql
BEGIN;
SELECT plan(3);

-- Setup
INSERT INTO users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'a@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@test.com');
INSERT INTO context_nodes (user_id, content, fingerprint) VALUES
  ('11111111-1111-1111-1111-111111111111', 'A content', 'fp1'),
  ('22222222-2222-2222-2222-222222222222', 'B content', 'fp2');

-- Test: user A cannot see user B nodes
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
SELECT is(
  (SELECT count(*) FROM context_nodes WHERE content = 'B content')::int,
  0,
  'User A cannot see User B nodes'
);

-- Test: user A can see own nodes
SELECT is(
  (SELECT count(*) FROM context_nodes)::int,
  1,
  'User A sees only own nodes'
);

-- Test: user A cannot delete user B nodes
PREPARE evil AS DELETE FROM context_nodes WHERE content = 'B content';
SELECT lives_ok('EXECUTE evil', 'No error but...');
SELECT is(
  (SELECT count(*) FROM context_nodes WHERE user_id = '22222222-2222-2222-2222-222222222222')::int,
  1,
  '... B nodes still exist'
);

SELECT * FROM finish();
ROLLBACK;
```

### 14.3 CI pipeline (GitHub Actions)

```yaml
name: ci
on: [push, pull_request]
jobs:
  lint-typecheck:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - pnpm install
      - pnpm lint
      - pnpm typecheck

  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - pnpm test:unit
      - upload coverage

  db-tests:
    runs-on: ubuntu-latest
    services:
      postgres: { image: supabase/postgres:15, env: ... }
    steps:
      - run migrations
      - pgtap tests
      - rls tests

  e2e:
    runs-on: ubuntu-latest
    needs: [unit-tests, db-tests]
    steps:
      - start preview deploy
      - playwright tests
```

### 14.4 Deploy

- **Frontend web app** : Vercel ou Cloudflare Pages (EU region)
- **Edge Functions** : `supabase functions deploy`
- **Extension** : auto-build sur tag, manuel upload Chrome Web Store / Firefox Add-ons
- **MCP server** : npm publish auto sur tag
- **Migrations DB** : `supabase db push` avec dry-run + review obligatoire

---

## 15. Roadmap de développement

### 15.1 Phases globales (solo founder, 12 mois pour atteindre PMF B2C)

| Phase | Durée | Output | Métrique de fin |
|---|---|---|---|
| **P0 — Foundations** | Semaines 1-3 | DB, auth, API minimale, infra | `POST /nodes` + `POST /search` en prod EU |
| **P1 — Extension capture** | Semaines 4-8 | Extension WXT, 6 signaux, scorer | 50 captures/jour test user |
| **P2 — Web app v1** | Semaines 9-12 | Timeline, search, settings, billing | Onboarding fonctionnel signup→capture |
| **P3 — Injection cross-agent** | Semaines 13-18 | Killer feature, DOM + MCP | 30 injections/jour test user, accept rate >40% |
| **P4 — Connecteurs** | Semaines 19-24 | Gmail, Calendar, Slack, Notion | 4 connecteurs live, sync stable |
| **P5 — Polish + launch** | Semaines 25-32 | Insights, graph viz, rules UI, marketing | Public launch sur PH + HN |
| **P6 — Growth** | Mois 9-12 | A/B test funnel, retention loops, optim coûts | 1000 users, 50 payants |

### 15.2 Détail Phase 0 (semaines 1-3)

**Semaine 1**
- Setup mono-repo (Turbo + pnpm)
- Project Supabase EU Frankfurt
- Migrations DB : `users`, `context_nodes`, `audit_log`, `usage_metrics`
- RLS policies + tests pgTAP
- Auth Supabase + magic link

**Semaine 2**
- Edge Function `POST /v1/nodes` (validation + insert sync)
- pgmq queues + workers stubs (NER, embed, summary)
- Worker NER avec Groq llama-3.1-8b
- Worker embed avec Jina v3
- Tests intégration push pipeline

**Semaine 3**
- Edge Function `POST /v1/search` (hybrid search SQL)
- Edge Function `GET /v1/nodes` (paginated list)
- Realtime channels par user
- Rate limiting Upstash
- Sentry + Logtail wired
- Smoke test end-to-end : signup → push via curl → search

### 15.3 Détail Phase 1 (semaines 4-8) — Extension

**Semaine 4** : Setup WXT, manifest MV3, popup React minimal, auth (magic link → token stored)
**Semaine 5** : Content Script avec DOMObserver, signal 1 (reading) + signal 2 (AI session)
**Semaine 6** : Signal 3 (search), 4 (decision), 5 (active work), 6 (temporal)
**Semaine 7** : Context Scorer + sensitivity detection + Dedup queue Dexie + offline buffering
**Semaine 8** : Popup UI complète, beta install chez 3 testeurs, fix bugs

### 15.4 Détail Phase 3 (semaines 13-18) — Injection

**Semaine 13** : QueryInterceptor pour claude.ai, ChatGPT, Gemini, Perplexity (DOM injection)
**Semaine 14** : Trigger Scorer (Groq local), `POST /v1/inject` endpoint
**Semaine 15** : InjectionUI overlay React injected into agent pages
**Semaine 16** : Context Rules schema + UI drag-and-drop simplifiée
**Semaine 17** : MCP server v1, publish npm, doc setup Claude Desktop / Cursor
**Semaine 18** : Beta closed avec 10 prosumers, monitor accept rate, fix UX

### 15.5 Priorités absolues (ne PAS dévier)

1. **L'injection cross-agent doit être le pitch #1** dès la web app v1
2. **Privacy/RGPD visible** sur chaque écran (badge "EU stored", "delete in 1 click")
3. **Free tier généreux** pour acquisition, pas radin
4. **Pas de feature mobile, pas de team, pas de B2B** avant mois 12

### 15.6 Critères Go/No-Go par phase

| Fin phase | Critère Go | Si No-Go |
|---|---|---|
| P1 | 50 captures/jour fonctionnels en test perso pendant 7 jours | Refactor scorer, pas de P2 |
| P2 | 5 beta testers prosumer activés (>30 captures en 1 sem) | Re-pitch produit, peut-être tier différent |
| P3 | Accept rate injection >40% chez beta | Si <20%, repenser injection (vraiment ?) |
| P4 | 3/4 connecteurs stables (uptime >95%) | Couper le 4e, focus stabilité |
| P5 | Public launch génère >200 signups en 7 jours | Iter marketing pendant 4 sem avant nouveau push |

---

## 16. Pricing, économie unitaire & projections

### 16.1 Grille de tarif

(cf. 12.4 pour détails)

| Tier | Prix mensuel | Cible % users | Cible % revenu |
|---|---|---|---|
| Free | €0 | 80% | 0% |
| Personal | €9 | 14% | 50% |
| Pro | €19 | 6% | 50% |

### 16.2 Coût LLM par user/mois (après optimisations cache + batch)

| Tier | Captures/jour | Injections/jour | Coût LLM estimé |
|---|---|---|---|
| Free | 30 (capped) | 100 (capped) | €1.8-2.5 |
| Personal | 60 (moyenne réelle) | 300 (moyenne) | €4.5-6 |
| Pro | 120 (moyenne réelle) | 800 (moyenne) | €8-11 |

### 16.3 Coûts fixes (estimés mois 12, 1000 users actifs)

| Poste | Coût mensuel |
|---|---|
| Supabase Pro (EU) | €25 |
| Upstash Redis | €20 |
| Vercel/Cloudflare | €20 |
| Sentry, Logtail, PostHog, BetterStack | €100 |
| Stripe fees | ~2% du MRR |
| Resend (emails) | €20 |
| Domain, certs, divers | €30 |
| **Total fixe** | **~€215/mois** |

### 16.4 Projection MRR (médian, B2C uniquement)

| Mois | Signups cumulés | Free actifs | Personal | Pro | MRR |
|---|---|---|---|---|---|
| 4 | 100 | 70 | 5 | 1 | €64 |
| 6 | 500 | 350 | 30 | 8 | €422 |
| 9 | 2 000 | 1 400 | 150 | 50 | €2 300 |
| 12 | 6 000 | 4 200 | 500 | 200 | €8 300 |
| 18 | 18 000 | 12 600 | 1 700 | 700 | €28 600 |
| 24 | 40 000 | 28 000 | 4 200 | 1 800 | €72 000 |

ARR mois 24 : **~€850k**. Atteint principalement si :
- Conversion free→paid se maintient >6% combiné (Personal+Pro)
- Churn mensuel <5% (capture passive aide énormément à la rétention)
- Acquisition : Product Hunt + HN au mois 5-6 (boost initial), puis Chrome Web Store organique + content marketing

### 16.5 Break-even

Mois 7-9 selon trajectoire d'acquisition. À €2 300 MRR, coûts (fixes €215 + variables ~€1 000) = €1 215. Net positif **~€1 000/mois**. Suffisant pour soutenir le founder à mi-temps.

Mois 12 : €8 300 MRR, coûts ~€3 500 → net **~€4 800/mois**. Founder full-time soutenable.

### 16.6 Levée de fonds : nécessaire ?

**Scénario pas de levée** : trajectoire ci-dessus tenable solo. Atteint €70k MRR à 24 mois. ARR €850k.

**Scénario levée pré-seed €300-500k mois 9-12** : permet d'embaucher 1 DevRel + 1 ingé senior. Trajectoire accélérée vers €2-3M ARR à 24 mois.

**Décision** : ne pas lever avant mois 9 minimum, juger sur traction PH/HN launch.

---

## 17. Risques techniques & mitigations

| Risque | Niveau | Impact | Mitigation |
|---|---|---|---|
| **Coût LLM dépasse marges** | Élevé | MRR négatif net | Cache agressif, batch Groq, monitor /user dès J1, alertes >€2/user/mois |
| **Anthropic/OpenAI sort un compete natif** | Moyen-élevé | Erosion B2C | Avance MCP-cross-agent, RGPD moat, pivot B2B si nécessaire |
| **DOM injection casse à chaque update agent UI** | Élevé | Killer feature down | Tests E2E quotidiens sur les 4 agents, alerting auto, fallback MCP |
| **Permission "tous les sites" effraie users** | Moyen | Conversion install basse | Optional permission post-onboard, demo vidéo claire |
| **Capture trop bruyante (graphe pollué)** | Moyen | Churn produit perçu inutile | Threshold scorer ajustable, feedback "ce nœud n'est pas pertinent" |
| **Supabase region down EU** | Faible-moyen | Outage user-visible | Backups offsite quotidien, multi-region V2 |
| **Détection bot Google/OpenAI sur l'extension** | Moyen | Compte agent user banni | User Agent normal, throttle injection, ne pas modifier outbound network |
| **Scope creep (ajout features non roadmap)** | **Très élevé** | MVP jamais shipped | Règle d'or : tout ajout = -1 feature roadmap. Solo founder discipliné. |
| **Burnout solo founder** | Élevé | Projet abandonné | Sprints 2 semaines, 1 jour off/sem strict, accountability weekly check |
| **Qualité scorer (faux positifs/négatifs)** | Moyen | UX dégradée | Feedback loop user, réentraînement seuils mensuel, A/B test |

---

## 18. Annexes

### 18.1 Glossaire

| Terme | Définition |
|---|---|
| **Context node** | Unité de mémoire dans Mesh : contenu, résumé, embedding, entités, ACL, TTL |
| **Context edge** | Relation entre 2 nœuds (inférée, explicite, temporelle, etc.) |
| **Injection** | Insertion automatique de contexte Mesh dans la requête d'un agent AI |
| **Connector** | Intégration OAuth avec une app tierce (Gmail, Slack, etc.) |
| **Context Rule** | Règle utilisateur : "agent X peut voir tags Y, pas Z" |
| **HNSW** | Algorithme d'indexation vectorielle pour ANN search |
| **MCP** | Model Context Protocol (Anthropic), standard cross-agent tools |
| **NER** | Named Entity Recognition |
| **pgmq** | Postgres Message Queue, extension Supabase |
| **RLS** | Row Level Security, isolation niveau ligne PostgreSQL |
| **Scorer** | Algorithme qui décide si un signal mérite capture / injection |

### 18.2 Stack reference card (vue résumée)

```
Frontend       React 18 + Vite + TS + Tailwind + Zustand + TanStack Query
Extension      WXT (MV3) + React + Dexie + Web Crypto
Backend        Supabase Edge Functions (Deno) + PostgreSQL 16 + pgvector + pgmq
Auth           Supabase Auth (JWT RS256)
Cache          Upstash Redis (EU)
AI             Jina v3 (embed) + Groq llama (NER/scoring/summary) + DeepSeek (reasoning)
Billing        Stripe (EU, Tax auto)
Monitor        Sentry + Logtail + PostHog + BetterStack + Helicone
Deploy         Vercel (web) + Supabase (edge+db) + Chrome/Firefox stores (ext)
CI             GitHub Actions + Playwright + Vitest + pgTAP
```

### 18.3 Liens et ressources

- WXT framework : https://wxt.dev
- Supabase pgvector : https://supabase.com/docs/guides/database/extensions/pgvector
- Jina embeddings v3 : https://jina.ai/embeddings/
- Groq inference : https://groq.com
- MCP spec : https://modelcontextprotocol.io
- Stripe Tax EU : https://stripe.com/tax

### 18.4 Conventions de code

- TypeScript strict mode partout
- ESLint + Prettier configurés
- Commits : conventional commits (`feat:`, `fix:`, `chore:`)
- Branches : `main` protégée, `feat/*` PR obligatoires
- Migrations DB : versionnées, jamais d'edit historique
- Secrets : `.env.local` git-ignored, Supabase Vault en prod

### 18.5 Décisions à prendre avant le kickoff (semaine 1)

1. **Nom de domaine** : `mesh.so` disponible ? Alternatives : `usemesh.app`, `meshmemory.io`
2. **Logo et brand** : à briefer ASAP (designer freelance, budget €500-1500)
3. **Statut juridique** : SAS française recommandée (TVA EU OK, BSPCE possible)
4. **DPO** : non obligatoire <250 employés mais documenter le rôle "DPO-équivalent"
5. **Conditions de vente** : CGV + Politique de confidentialité rédigées par avocat (~€1500)
6. **Compte bancaire pro** : Qonto / Shine pour démarrer

---

**Fin du document. Total : ~75 pages équivalent A4.**

**Prochaine étape** : lecture critique par toi, ajustements éventuels, puis kickoff semaine 1 — setup Supabase + monorepo.
