/**
 * Context Rules engine.
 *
 * Rules are stored per-user with priority + action. They filter which nodes
 * a target agent may see, based on rule_type:
 *
 *  - agent_acl    : applies to a specific target_agent (e.g. 'chatgpt.com')
 *                   action: 'allow' | 'deny' | 'redact'
 *                   filter: { tags?: string[], sources?: string[] }
 *                     - empty filter on 'deny' = blanket deny everything for this agent
 *                     - filter.tags on 'deny' = block nodes carrying ANY of these tags
 *                     - filter.tags on 'allow' = restrict to nodes carrying ANY of these tags
 *                     - 'redact' replaces summary/content excerpt with [redacted]
 *
 *  - tag_block    : global block of a tag for all agents
 *                   target: ignored, filter: { tags: string[] }
 *
 *  - domain_block : block any node whose source_url matches a domain
 *                   target: domain string, action: 'deny'
 *
 *  - time_window  : restrict by time (e.g. only nodes from past 7d)
 *                   filter: { since?: string, until?: string }
 *
 * Evaluation: rules ordered by priority DESC; first matching deny wins, otherwise
 * the most restrictive allow set applies.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export interface Rule {
  id: string;
  rule_type: 'agent_acl' | 'tag_block' | 'domain_block' | 'time_window';
  target: string;
  action: 'allow' | 'deny' | 'redact';
  filter: {
    tags?: string[];
    sources?: string[];
    since?: string;
    until?: string;
  };
  priority: number;
  enabled: boolean;
}

export interface RuleEvalNode {
  id: string;
  tags: string[];
  source: string;
  source_url: string | null;
  created_at: string;
  summary: string | null;
  content: string;
}

export interface RuleEvalResult {
  allowed: boolean;
  redacted: boolean;
  reason?: string;
}

function arrayIntersects<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.some((x) => b.includes(x));
}

function tagMatches(node: RuleEvalNode, tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  return arrayIntersects(node.tags, tags);
}

function sourceMatches(node: RuleEvalNode, sources?: string[]): boolean {
  if (!sources || sources.length === 0) return true;
  return sources.includes(node.source);
}

function domainMatches(node: RuleEvalNode, domain: string): boolean {
  if (!node.source_url) return false;
  try {
    const host = new URL(node.source_url).hostname.toLowerCase();
    return host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`);
  } catch {
    return false;
  }
}

function timeWindowOk(node: RuleEvalNode, filter: Rule['filter']): boolean {
  const ts = new Date(node.created_at).getTime();
  if (filter.since) {
    const sinceMs = parseDurationToMs(filter.since);
    if (sinceMs !== null && ts < Date.now() - sinceMs) return false;
  }
  if (filter.until) {
    const untilMs = parseDurationToMs(filter.until);
    if (untilMs !== null && ts > Date.now() - untilMs) return false;
  }
  return true;
}

function parseDurationToMs(value: string): number | null {
  const m = value.match(/^(\d+)([hdwm])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'h':
      return n * 3600_000;
    case 'd':
      return n * 86400_000;
    case 'w':
      return n * 604800_000;
    case 'm':
      return n * 2592000_000;
    default:
      return null;
  }
}

/**
 * Evaluate a single node against the rule set for a target agent.
 */
export function evaluateNode(
  node: RuleEvalNode,
  targetAgent: string,
  rules: Rule[],
): RuleEvalResult {
  let redacted = false;
  let explicitAllow = false;
  let hasAllowRules = false;

  // Process in priority order (DESC). First deny wins.
  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.rule_type === 'tag_block') {
      if (tagMatches(node, rule.filter.tags)) {
        return { allowed: false, redacted: false, reason: `tag_block:${rule.filter.tags?.join(',')}` };
      }
      continue;
    }

    if (rule.rule_type === 'domain_block') {
      if (domainMatches(node, rule.target)) {
        return { allowed: false, redacted: false, reason: `domain_block:${rule.target}` };
      }
      continue;
    }

    if (rule.rule_type === 'time_window') {
      if (!timeWindowOk(node, rule.filter)) {
        return { allowed: false, redacted: false, reason: 'time_window' };
      }
      continue;
    }

    if (rule.rule_type === 'agent_acl') {
      if (rule.target !== targetAgent && rule.target !== '*') continue;

      const filterEmpty =
        !rule.filter ||
        ((!rule.filter.tags || rule.filter.tags.length === 0) &&
          (!rule.filter.sources || rule.filter.sources.length === 0));

      if (rule.action === 'deny') {
        if (filterEmpty) {
          return { allowed: false, redacted: false, reason: `agent_deny:${targetAgent}` };
        }
        if (tagMatches(node, rule.filter.tags) && sourceMatches(node, rule.filter.sources)) {
          return {
            allowed: false,
            redacted: false,
            reason: `agent_deny_filtered:${targetAgent}`,
          };
        }
      } else if (rule.action === 'redact') {
        if (filterEmpty || (tagMatches(node, rule.filter.tags) && sourceMatches(node, rule.filter.sources))) {
          redacted = true;
        }
      } else if (rule.action === 'allow') {
        hasAllowRules = true;
        if (filterEmpty || (tagMatches(node, rule.filter.tags) && sourceMatches(node, rule.filter.sources))) {
          explicitAllow = true;
        }
      }
    }
  }

  // If allow rules exist for this agent, the node must match at least one.
  if (hasAllowRules && !explicitAllow) {
    return { allowed: false, redacted: false, reason: 'no_matching_allow' };
  }

  return { allowed: true, redacted };
}

/**
 * Load active rules for a user from the DB, ordered by priority DESC.
 */
export async function loadUserRules(
  client: SupabaseClient,
  userId: string,
): Promise<Rule[]> {
  const { data, error } = await client
    .from('context_rules')
    .select('id, rule_type, target, action, filter, priority, enabled')
    .eq('user_id', userId)
    .eq('enabled', true)
    .order('priority', { ascending: false });

  if (error || !data) return [];
  return data as Rule[];
}

/**
 * Apply a redaction to a hit (clamp text to non-revealing summary).
 */
export function redactHit<T extends { summary: string | null; content: string }>(hit: T): T {
  return {
    ...hit,
    summary: '[redacted by your Context Rules]',
    content: '[redacted by your Context Rules]',
  };
}
