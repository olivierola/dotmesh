/**
 * Unit tests for the context rules engine.
 * Run: deno test supabase/functions/_shared/rules_test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { evaluateNode, type Rule, type RuleEvalNode } from './rules.ts';

function node(over: Partial<RuleEvalNode> = {}): RuleEvalNode {
  return {
    id: 'n1',
    tags: [],
    source: 'extension',
    source_url: null,
    created_at: new Date().toISOString(),
    summary: 's',
    content: 'c',
    ...over,
  };
}

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: crypto.randomUUID(),
    rule_type: 'agent_acl',
    target: 'chatgpt.com',
    action: 'deny',
    filter: {},
    priority: 100,
    enabled: true,
    ...over,
  };
}

Deno.test('empty rules → allow all', () => {
  const r = evaluateNode(node(), 'chatgpt.com', []);
  assertEquals(r.allowed, true);
  assertEquals(r.redacted, false);
});

Deno.test('blanket deny for target agent blocks node', () => {
  const r = evaluateNode(node(), 'chatgpt.com', [rule()]);
  assertEquals(r.allowed, false);
  assertEquals(r.reason, 'agent_deny:chatgpt.com');
});

Deno.test('blanket deny does not affect other agents', () => {
  const r = evaluateNode(node(), 'claude.ai', [rule()]);
  assertEquals(r.allowed, true);
});

Deno.test('tag-scoped deny: matches → blocked', () => {
  const r = evaluateNode(
    node({ tags: ['health', 'work'] }),
    'chatgpt.com',
    [rule({ filter: { tags: ['health'] } })],
  );
  assertEquals(r.allowed, false);
});

Deno.test('tag-scoped deny: no match → allowed', () => {
  const r = evaluateNode(
    node({ tags: ['work'] }),
    'chatgpt.com',
    [rule({ filter: { tags: ['health'] } })],
  );
  assertEquals(r.allowed, true);
});

Deno.test('global tag_block applies regardless of agent', () => {
  const r = evaluateNode(
    node({ tags: ['finance'] }),
    'claude.ai',
    [
      rule({
        rule_type: 'tag_block',
        target: '*',
        action: 'deny',
        filter: { tags: ['finance'] },
      }),
    ],
  );
  assertEquals(r.allowed, false);
});

Deno.test('redact marks node without blocking', () => {
  const r = evaluateNode(
    node({ tags: ['personal'] }),
    'chatgpt.com',
    [rule({ action: 'redact', filter: { tags: ['personal'] } })],
  );
  assertEquals(r.allowed, true);
  assertEquals(r.redacted, true);
});

Deno.test('explicit allow restricts to allow set', () => {
  const r1 = evaluateNode(
    node({ tags: ['work'] }),
    'chatgpt.com',
    [rule({ action: 'allow', filter: { tags: ['work'] } })],
  );
  assertEquals(r1.allowed, true);

  const r2 = evaluateNode(
    node({ tags: ['personal'] }),
    'chatgpt.com',
    [rule({ action: 'allow', filter: { tags: ['work'] } })],
  );
  assertEquals(r2.allowed, false);
  assertEquals(r2.reason, 'no_matching_allow');
});

Deno.test('domain_block matches source_url subdomain', () => {
  const r = evaluateNode(
    node({ source_url: 'https://docs.example.com/secret' }),
    'chatgpt.com',
    [rule({ rule_type: 'domain_block', target: 'example.com', action: 'deny' })],
  );
  assertEquals(r.allowed, false);
  assertEquals(r.reason, 'domain_block:example.com');
});

Deno.test('disabled rules are ignored', () => {
  const r = evaluateNode(node(), 'chatgpt.com', [rule({ enabled: false })]);
  assertEquals(r.allowed, true);
});

Deno.test('wildcard target * matches any agent', () => {
  const r = evaluateNode(
    node({ tags: ['secret'] }),
    'gemini.google.com',
    [
      rule({
        target: '*',
        action: 'deny',
        filter: { tags: ['secret'] },
      }),
    ],
  );
  assertEquals(r.allowed, false);
});
