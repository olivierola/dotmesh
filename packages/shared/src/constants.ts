import type { Tier } from './types.js';

/**
 * Tier quotas — single source of truth.
 * Enforced both client-side (UX) and server-side (API gating).
 */
export interface TierQuotas {
  nodes_max: number | null; // null = unlimited
  connectors_max: number | null;
  injections_per_day: number | null;
  ttl_max_days: number | null;
  writes_per_minute: number;
  pulls_per_minute: number;
}

export const TIER_QUOTAS: Record<Tier, TierQuotas> = {
  free: {
    nodes_max: 1000,
    connectors_max: 1,
    injections_per_day: 100,
    ttl_max_days: 30,
    writes_per_minute: 30,
    pulls_per_minute: 60,
  },
  personal: {
    nodes_max: null,
    connectors_max: 3,
    injections_per_day: 1000,
    ttl_max_days: null,
    writes_per_minute: 120,
    pulls_per_minute: 300,
  },
  pro: {
    nodes_max: null,
    connectors_max: null,
    injections_per_day: null,
    ttl_max_days: null,
    writes_per_minute: 600,
    pulls_per_minute: 1200,
  },
};

export const EMBEDDING_DIM = 1024;
export const EMBEDDING_MODEL = 'jina-embeddings-v3';
export const NER_MODEL = 'llama-3.1-8b-instant';
export const SUMMARY_MODEL = 'llama-3.3-70b-versatile';
export const REASONING_MODEL = 'deepseek-reasoner';

export const SCORE_PUSH_THRESHOLD = 0.55;
export const SCORE_SENSITIVITY_BLOCK = 0.7;
export const EDGE_INFER_THRESHOLD = 0.3;
export const INJECTION_TRIGGER_THRESHOLD = 0.4;

export const MAX_INJECTION_TOKENS = 1500;
export const MAX_INJECTION_NODES = 5;

/**
 * Sensitive domains blocked by default in the extension.
 * User can extend but not shrink the health/banking/gov categories.
 */
export const BLOCKED_DOMAINS_DEFAULT = [
  // Mail
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'protonmail.com',
  'tutanota.com',
  // Government (FR-centric, will expand per locale)
  'impots.gouv.fr',
  'ameli.fr',
  'service-public.fr',
  'urssaf.fr',
  // Healthcare
  'doctolib.fr',
  'sante.fr',
  // Messaging
  'facebook.com/messages',
  'wa.me',
  'web.whatsapp.com',
  'signal.org',
  'instagram.com/direct',
];

/** Patterns triggering local sensitivity block (never sent to server). */
export const SENSITIVE_PATTERNS = [
  /\b\d{13,19}\b/, // card numbers (basic)
  /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/, // IBAN
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-like
  /password\s*[:=]\s*\S+/i,
  /api[_-]?key\s*[:=]\s*\S{8,}/i,
  /sk-[A-Za-z0-9_-]{16,}/,
  /token\s*[:=]\s*[A-Za-z0-9_.-]{20,}/i,
];
