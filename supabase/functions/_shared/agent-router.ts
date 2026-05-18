/**
 * Agent router — decides whether the user's chat query should trigger
 * one of the autonomous agents (daily briefing, follow-up, meeting prep).
 *
 * Strategy: a single cheap llama-8b classification call in JSON mode,
 * then a service-role invocation of the matching agent function.
 *
 * The returned text is meant to be prepended to the assistant prompt as
 * additional context — NOT a final answer. The streaming LLM still writes
 * the final user-facing reply.
 */

import { groqChat } from './ai.ts';

export type AgentIntent = 'none' | 'daily_briefing' | 'follow_up' | 'meeting_prep';

const FN_MAP: Record<Exclude<AgentIntent, 'none'>, string> = {
  daily_briefing: 'agents-daily-briefing',
  follow_up: 'agents-follow-up',
  meeting_prep: 'agents-meeting-prep',
};

/**
 * Classify a user query. Returns 'none' for plain Q&A.
 *
 * Examples that should match:
 *   "what's on my plate today?"         → daily_briefing
 *   "give me my morning brief"          → daily_briefing
 *   "what did I promise this week?"     → follow_up
 *   "any unfinished follow-ups?"        → follow_up
 *   "prep me for my next meeting"       → meeting_prep
 *   "who am I meeting with at 2pm?"     → meeting_prep
 */
export async function detectAgentIntent(message: string): Promise<AgentIntent> {
  // Heuristic short-circuits — avoid the LLM call for obviously-not-agent queries.
  if (message.length < 10) return 'none';

  const result = await groqChat({
    model: 'llama-3.1-8b-instant',
    systemPrompt:
      'You classify user queries into one of: daily_briefing, follow_up, meeting_prep, none. Output JSON only.',
    userPrompt: `Classify this query.

- "daily_briefing" = the user asks for a summary of their day, what's happening today, morning brief, what they need to do.
- "follow_up" = the user asks about commitments/promises they made, unfinished things, what they owe people.
- "meeting_prep" = the user asks for context about an upcoming meeting, who they're meeting, prep notes.
- "none" = anything else (factual questions, normal conversation, search through memory).

Query: """${message.slice(0, 500)}"""

Return: {"intent": "daily_briefing" | "follow_up" | "meeting_prep" | "none", "confidence": 0..1}`,
    jsonMode: true,
    maxTokens: 60,
    feature: 'chat-agent-router',
  });

  if (!result) return 'none';
  try {
    const parsed = JSON.parse(result) as { intent?: string; confidence?: number };
    const intent = parsed.intent as AgentIntent | undefined;
    if (!intent || intent === 'none') return 'none';
    if ((parsed.confidence ?? 0) < 0.6) return 'none';
    if (['daily_briefing', 'follow_up', 'meeting_prep'].includes(intent)) return intent;
    return 'none';
  } catch {
    return 'none';
  }
}

interface AgentInvocationResult {
  title: string;
  summary: string;
  items: Array<{ text: string; due?: string | null }>;
}

/**
 * Invoke an agent function as a service-role request and return its output.
 * Times out fast (15s); on timeout we just return null and the chat continues
 * without the agent context.
 */
export async function invokeAgent(
  intent: Exclude<AgentIntent, 'none'>,
  userId: string,
): Promise<AgentInvocationResult | null> {
  const fn = FN_MAP[intent];
  const supaUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supaUrl || !serviceKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${supaUrl}/functions/v1/${fn}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: userId, triggered_by: 'manual' }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      output?: AgentInvocationResult;
      skipped?: string;
    };
    return data.output ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Format an agent output into a text block to inject into the chat context. */
export function formatAgentBlock(intent: Exclude<AgentIntent, 'none'>, out: AgentInvocationResult): string {
  const lines: string[] = [
    `--- Agent result: ${intent} ---`,
    `Title: ${out.title}`,
    `Summary: ${out.summary}`,
  ];
  if (out.items && out.items.length > 0) {
    lines.push('Items:');
    for (const it of out.items) {
      lines.push(`  - ${it.text}${it.due ? ` (due ${it.due})` : ''}`);
    }
  }
  lines.push('--- end agent result ---');
  return lines.join('\n');
}
