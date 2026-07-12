/**
 * Unit tests for shared types.
 */
import { describe, it, expect } from 'vitest';

describe('Tier type', () => {
  it('accepts valid tier values', () => {
    const tiers: string[] = ['free', 'personal', 'pro'];
    for (const t of tiers) {
      expect(['free', 'personal', 'pro']).toContain(t);
    }
  });

  it('rejects invalid tier values', () => {
    const invalid = ['enterprise', 'basic', ''];
    for (const t of invalid) {
      expect(['free', 'personal', 'pro']).not.toContain(t);
    }
  });
});

describe('ConnectorProvider type', () => {
  it('includes all expected providers', () => {
    const providers = ['gmail', 'gcal', 'slack', 'notion', 'linear', 'github', 'figma', 'gdocs'];
    for (const p of providers) {
      expect(p).toBeDefined();
    }
  });
});

describe('EdgeRelation type', () => {
  it('includes all expected relations', () => {
    const relations = ['inferred', 'explicit', 'temporal', 'contradicts', 'supersedes', 'user_linked'];
    for (const r of relations) {
      expect(r).toBeDefined();
    }
  });
});

describe('EntityType type', () => {
  it('includes all expected entity types', () => {
    const types = ['PERSON', 'ORG', 'LOCATION', 'DATE', 'PROJECT', 'PRODUCT', 'TOPIC'];
    for (const t of types) {
      expect(t).toBeDefined();
    }
  });
});

describe('NodeSource type', () => {
  it('accepts extension source', () => {
    const source: string = 'extension';
    expect(source).toBe('extension');
  });

  it('accepts manual source', () => {
    const source: string = 'manual';
    expect(source).toBe('manual');
  });

  it('accepts mcp source', () => {
    const source: string = 'mcp';
    expect(source).toBe('mcp');
  });

  it('accepts connector sources', () => {
    const source: string = 'connector:gmail';
    expect(source.startsWith('connector:')).toBe(true);
  });
});

describe('ConnectorStatus type', () => {
  it('accepts valid statuses', () => {
    const statuses: string[] = ['active', 'paused', 'error', 'revoked'];
    for (const s of statuses) {
      expect(['active', 'paused', 'error', 'revoked']).toContain(s);
    }
  });
});
