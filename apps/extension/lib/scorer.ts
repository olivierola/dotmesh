/**
 * Local content scorer.
 * Decides whether a captured signal is worth pushing to the Mesh API.
 *
 * score = 0.40 * relevance + 0.30 * novelty + 0.30 * intent
 * - score > 0.55: PUSH
 * - sensitivity > 0.7: BLOCK (never sent)
 * - otherwise: DROP
 */

export interface SignalInput {
  content: string;
  url: string;
  signalType: 'reading' | 'ai_session' | 'search' | 'decision' | 'active_work' | 'temporal';
  dwellMs: number;
  scrollDepth: number;
}

export interface ScoringResult {
  score: number;
  relevance: number;
  novelty: number;
  intent: number;
  sensitivity: number;
  reason: string;
  decision: 'push' | 'drop' | 'block';
}

const SIGNAL_INTENT: Record<SignalInput['signalType'], number> = {
  reading: 0.5,
  ai_session: 0.85,
  search: 0.65,
  decision: 0.9,
  active_work: 0.75,
  temporal: 0.6,
};

const SENSITIVE_PATTERNS = [
  /\b\d{13,19}\b/,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /password\s*[:=]\s*\S+/i,
  /api[_-]?key\s*[:=]\s*\S{8,}/i,
  /sk-[A-Za-z0-9_-]{16,}/,
  /token\s*[:=]\s*[A-Za-z0-9_.-]{20,}/i,
];

function computeRelevance(input: SignalInput): number {
  const len = input.content.length;
  if (len < 40) return 0.1;
  if (len < 200) return 0.4;
  if (len < 1000) return 0.7;
  return 0.85;
}

function computeIntent(input: SignalInput): number {
  const base = SIGNAL_INTENT[input.signalType] ?? 0.5;
  const dwellBonus = Math.min(input.dwellMs / 60_000, 1) * 0.15;
  return Math.min(base + dwellBonus, 1);
}

function detectSensitivity(input: SignalInput): number {
  for (const re of SENSITIVE_PATTERNS) {
    if (re.test(input.content)) return 1.0;
  }
  return 0;
}

/**
 * Novelty is best computed against recent fingerprints (in background).
 * For pure-content scoring without DB access, default to 0.7.
 */
export function scoreSignal(input: SignalInput, novelty = 0.7): ScoringResult {
  const sensitivity = detectSensitivity(input);
  if (sensitivity > 0.7) {
    return {
      score: 0,
      relevance: 0,
      novelty: 0,
      intent: 0,
      sensitivity,
      reason: 'sensitive_content',
      decision: 'block',
    };
  }

  const relevance = computeRelevance(input);
  const intent = computeIntent(input);
  const score = relevance * 0.4 + novelty * 0.3 + intent * 0.3;

  return {
    score,
    relevance,
    novelty,
    intent,
    sensitivity,
    reason: score >= 0.55 ? 'above_threshold' : 'below_threshold',
    decision: score >= 0.55 ? 'push' : 'drop',
  };
}
