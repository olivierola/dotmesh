/**
 * Unit tests for Zod schemas.
 */
import { describe, it, expect } from 'vitest';
import {
  entityTypeSchema,
  entitySchema,
  tierSchema,
  ttlSchema,
  createNodeSchema,
  updateNodeSchema,
  createEdgeSchema,
  createRuleSchema,
  createConnectorSchema,
  createInjectionSchema,
  createNoteSchema,
  updateNoteSchema,
  searchQuerySchema,
  chatMessageSchema,
  createCollectionSchema,
  updateCollectionSchema,
  createInstructionSchema,
  updateInstructionSchema,
  createWebhookSchema,
  createAgentSchema,
  updateAgentSchema,
} from './schemas.js';

describe('entityTypeSchema', () => {
  it('parses valid entity types', () => {
    expect(entityTypeSchema.parse('PERSON')).toBe('PERSON');
    expect(entityTypeSchema.parse('ORG')).toBe('ORG');
    expect(entityTypeSchema.parse('LOCATION')).toBe('LOCATION');
    expect(entityTypeSchema.parse('DATE')).toBe('DATE');
    expect(entityTypeSchema.parse('PROJECT')).toBe('PROJECT');
    expect(entityTypeSchema.parse('PRODUCT')).toBe('PRODUCT');
    expect(entityTypeSchema.parse('TOPIC')).toBe('TOPIC');
  });

  it('rejects invalid entity types', () => {
    expect(() => entityTypeSchema.parse('INVALID')).toThrow();
    expect(() => entityTypeSchema.parse('')).toThrow();
    expect(() => entityTypeSchema.parse('person')).toThrow();
  });
});

describe('entitySchema', () => {
  it('parses a valid entity', () => {
    const result = entitySchema.parse({
      type: 'PERSON',
      value: 'John Doe',
      normalized: 'john doe',
    });
    expect(result.value).toBe('John Doe');
    expect(result.normalized).toBe('john doe');
  });

  it('rejects entity with empty value', () => {
    expect(() =>
      entitySchema.parse({ type: 'PERSON', value: '', normalized: '' }),
    ).toThrow();
  });

  it('rejects entity with value exceeding 200 chars', () => {
    expect(() =>
      entitySchema.parse({
        type: 'PERSON',
        value: 'x'.repeat(201),
        normalized: 'x'.repeat(201),
      }),
    ).toThrow();
  });
});

describe('tierSchema', () => {
  it('parses valid tiers', () => {
    expect(tierSchema.parse('free')).toBe('free');
    expect(tierSchema.parse('personal')).toBe('personal');
    expect(tierSchema.parse('pro')).toBe('pro');
  });

  it('rejects invalid tiers', () => {
    expect(() => tierSchema.parse('enterprise')).toThrow();
    expect(() => tierSchema.parse('')).toThrow();
  });
});

describe('ttlSchema', () => {
  it('parses valid TTL values', () => {
    expect(ttlSchema.parse('30d')).toBe('30d');
    expect(ttlSchema.parse('7d')).toBe('7d');
    expect(ttlSchema.parse('24h')).toBe('24h');
    expect(ttlSchema.parse('12w')).toBe('12w');
    expect(ttlSchema.parse('1m')).toBe('1m');
  });

  it('accepts null and undefined', () => {
    expect(ttlSchema.parse(null)).toBeNull();
    expect(ttlSchema.parse(undefined)).toBeUndefined();
  });

  it('rejects invalid TTL formats', () => {
    expect(() => ttlSchema.parse('30')).toThrow();
    expect(() => ttlSchema.parse('abc')).toThrow();
    expect(() => ttlSchema.parse('30x')).toThrow();
  });
});

describe('createNodeSchema', () => {
  it('parses a minimal valid node', () => {
    const result = createNodeSchema.parse({
      content: 'Test memory',
      summary: 'Test',
    });
    expect(result.content).toBe('Test memory');
    expect(result.summary).toBe('Test');
  });

  it('parses a full node with all fields', () => {
    const result = createNodeSchema.parse({
      content: 'Full test memory',
      summary: 'Full test',
      source: 'manual',
      source_url: 'https://example.com',
      tags: ['test', 'example'],
      entities: [{ type: 'TOPIC', value: 'Testing', normalized: 'testing' }],
      ttl: '30d',
    });
    expect(result.source).toBe('manual');
    expect(result.tags).toEqual(['test', 'example']);
    expect(result.entities).toHaveLength(1);
  });

  it('rejects node without content', () => {
    expect(() => createNodeSchema.parse({ summary: 'Test' })).toThrow();
  });

  it('rejects node without summary', () => {
    expect(() => createNodeSchema.parse({ content: 'Test' })).toThrow();
  });

  it('rejects node with empty content', () => {
    expect(() => createNodeSchema.parse({ content: '', summary: 'Test' })).toThrow();
  });

  it('rejects node with content exceeding 10000 chars', () => {
    expect(() =>
      createNodeSchema.parse({ content: 'x'.repeat(10001), summary: 'Test' }),
    ).toThrow();
  });

  it('rejects node with invalid source', () => {
    expect(() =>
      createNodeSchema.parse({
        content: 'Test',
        summary: 'Test',
        source: 'invalid_source',
      }),
    ).toThrow();
  });

  it('rejects node with invalid TTL', () => {
    expect(() =>
      createNodeSchema.parse({
        content: 'Test',
        summary: 'Test',
        ttl: 'invalid',
      }),
    ).toThrow();
  });
});

describe('updateNodeSchema', () => {
  it('parses a partial update', () => {
    const result = updateNodeSchema.parse({ content: 'Updated content' });
    expect(result.content).toBe('Updated content');
  });

  it('accepts empty object (no fields to update)', () => {
    const result = updateNodeSchema.parse({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('rejects invalid fields', () => {
    expect(() => updateNodeSchema.parse({ invalid_field: true })).toThrow();
  });
});

describe('createEdgeSchema', () => {
  it('parses a valid edge', () => {
    const result = createEdgeSchema.parse({
      source_node_id: 'node-1',
      target_node_id: 'node-2',
      relation: 'inferred',
    });
    expect(result.relation).toBe('inferred');
  });

  it('rejects edge without source', () => {
    expect(() =>
      createEdgeSchema.parse({ target_node_id: 'node-2', relation: 'inferred' }),
    ).toThrow();
  });

  it('rejects edge without target', () => {
    expect(() =>
      createEdgeSchema.parse({ source_node_id: 'node-1', relation: 'inferred' }),
    ).toThrow();
  });

  it('rejects edge with invalid relation', () => {
    expect(() =>
      createEdgeSchema.parse({
        source_node_id: 'node-1',
        target_node_id: 'node-2',
        relation: 'invalid_relation',
      }),
    ).toThrow();
  });
});

describe('createRuleSchema', () => {
  it('parses a valid rule', () => {
    const result = createRuleSchema.parse({
      rule_type: 'agent_acl',
      target: 'chatgpt.com',
      action: 'deny',
    });
    expect(result.rule_type).toBe('agent_acl');
    expect(result.action).toBe('deny');
  });

  it('parses a rule with filter', () => {
    const result = createRuleSchema.parse({
      rule_type: 'agent_acl',
      target: 'claude.ai',
      action: 'deny',
      filter: { tags: ['finance'] },
    });
    expect(result.filter?.tags).toEqual(['finance']);
  });

  it('rejects rule without rule_type', () => {
    expect(() =>
      createRuleSchema.parse({ target: 'chatgpt.com', action: 'deny' }),
    ).toThrow();
  });
});

describe('createConnectorSchema', () => {
  it('parses a valid connector', () => {
    const result = createConnectorSchema.parse({
      provider: 'gmail',
    });
    expect(result.provider).toBe('gmail');
  });

  it('rejects invalid provider', () => {
    expect(() => createConnectorSchema.parse({ provider: 'invalid' })).toThrow();
  });
});

describe('createInjectionSchema', () => {
  it('parses a valid injection', () => {
    const result = createInjectionSchema.parse({
      content: 'Injected content',
      source_url: 'https://example.com',
    });
    expect(result.content).toBe('Injected content');
  });

  it('rejects injection without content', () => {
    expect(() => createInjectionSchema.parse({ source_url: 'https://example.com' })).toThrow();
  });
});

describe('createNoteSchema / updateNoteSchema', () => {
  it('parses a valid note', () => {
    const result = createNoteSchema.parse({
      title: 'My Note',
      content: 'Note content',
    });
    expect(result.title).toBe('My Note');
  });

  it('rejects note without title', () => {
    expect(() => createNoteSchema.parse({ content: 'Content' })).toThrow();
  });

  it('parses a partial note update', () => {
    const result = updateNoteSchema.parse({ title: 'Updated title' });
    expect(result.title).toBe('Updated title');
  });
});

describe('searchQuerySchema', () => {
  it('parses a valid search query', () => {
    const result = searchQuerySchema.parse({ q: 'test query' });
    expect(result.q).toBe('test query');
  });

  it('rejects empty search query', () => {
    expect(() => searchQuerySchema.parse({ q: '' })).toThrow();
  });

  it('rejects search query exceeding 500 chars', () => {
    expect(() => searchQuerySchema.parse({ q: 'x'.repeat(501) })).toThrow();
  });
});

describe('chatMessageSchema', () => {
  it('parses a valid chat message', () => {
    const result = chatMessageSchema.parse({
      role: 'user',
      content: 'Hello',
    });
    expect(result.role).toBe('user');
    expect(result.content).toBe('Hello');
  });

  it('rejects invalid role', () => {
    expect(() =>
      chatMessageSchema.parse({ role: 'admin', content: 'Hello' }),
    ).toThrow();
  });
});

describe('createCollectionSchema / updateCollectionSchema', () => {
  it('parses a valid collection', () => {
    const result = createCollectionSchema.parse({
      name: 'Test Collection',
      description: 'A test collection',
    });
    expect(result.name).toBe('Test Collection');
  });

  it('rejects collection without name', () => {
    expect(() => createCollectionSchema.parse({ description: 'Desc' })).toThrow();
  });

  it('parses a partial collection update', () => {
    const result = updateCollectionSchema.parse({ name: 'Renamed' });
    expect(result.name).toBe('Renamed');
  });
});

describe('createInstructionSchema / updateInstructionSchema', () => {
  it('parses a valid instruction', () => {
    const result = createInstructionSchema.parse({
      content: 'Always be helpful',
      agent_id: 'agent-1',
    });
    expect(result.content).toBe('Always be helpful');
  });

  it('rejects instruction without content', () => {
    expect(() =>
      createInstructionSchema.parse({ agent_id: 'agent-1' }),
    ).toThrow();
  });

  it('parses a partial instruction update', () => {
    const result = updateInstructionSchema.parse({ content: 'Updated instruction' });
    expect(result.content).toBe('Updated instruction');
  });
});

describe('createWebhookSchema', () => {
  it('parses a valid webhook', () => {
    const result = createWebhookSchema.parse({
      url: 'https://hooks.example.com/callback',
      events: ['node.created'],
    });
    expect(result.url).toBe('https://hooks.example.com/callback');
  });

  it('rejects webhook with invalid URL', () => {
    expect(() =>
      createWebhookSchema.parse({
        url: 'not-a-url',
        events: ['node.created'],
      }),
    ).toThrow();
  });
});

describe('createAgentSchema / updateAgentSchema', () => {
  it('parses a valid agent', () => {
    const result = createAgentSchema.parse({
      name: 'My Agent',
      system_prompt: 'You are a helpful assistant',
    });
    expect(result.name).toBe('My Agent');
  });

  it('rejects agent without name', () => {
    expect(() =>
      createAgentSchema.parse({ system_prompt: 'Prompt' }),
    ).toThrow();
  });

  it('parses a partial agent update', () => {
    const result = updateAgentSchema.parse({ name: 'Renamed Agent' });
    expect(result.name).toBe('Renamed Agent');
  });
});
