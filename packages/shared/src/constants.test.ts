/**
 * Unit tests for shared constants.
 */
import { describe, it, expect } from 'vitest';
import { TIER_QUOTAS, type TierQuotas } from './constants.js';

describe('TIER_QUOTAS', () => {
  it('defines quotas for all tiers', () => {
    expect(TIER_QUOTAS).toHaveProperty('free');
    expect(TIER_QUOTAS).toHaveProperty('personal');
    expect(TIER_QUOTAS).toHaveProperty('pro');
  });

  it('free tier has limited nodes', () => {
    const free = TIER_QUOTAS.free;
    expect(free.nodes_max).toBe(1000);
    expect(free.connectors_max).toBe(1);
    expect(free.injections_per_day).toBe(100);
    expect(free.ttl_max_days).toBe(30);
  });

  it('personal tier has higher limits', () => {
    const personal = TIER_QUOTAS.personal;
    expect(personal.nodes_max).toBe(10000);
    expect(personal.connectors_max).toBe(5);
    expect(personal.injections_per_day).toBe(1000);
    expect(personal.ttl_max_days).toBe(365);
  });

  it('pro tier has unlimited nodes', () => {
    const pro = TIER_QUOTAS.pro;
    expect(pro.nodes_max).toBeNull();
    expect(pro.connectors_max).toBeNull();
    expect(pro.injections_per_day).toBeNull();
    expect(pro.ttl_max_days).toBeNull();
  });

  it('rate limits increase with tier', () => {
    expect(TIER_QUOTAS.free.writes_per_minute).toBeLessThanOrEqual(
      TIER_QUOTAS.personal.writes_per_minute,
    );
    expect(TIER_QUOTAS.personal.writes_per_minute).toBeLessThanOrEqual(
      TIER_QUOTAS.pro.writes_per_minute,
    );
  });

  it('all tiers have positive rate limits', () => {
    for (const tier of Object.values(TIER_QUOTAS)) {
      expect(tier.writes_per_minute).toBeGreaterThan(0);
      expect(tier.pulls_per_minute).toBeGreaterThan(0);
    }
  });

  it('all tiers define all quota fields', () => {
    const fields: (keyof TierQuotas)[] = [
      'nodes_max',
      'connectors_max',
      'injections_per_day',
      'ttl_max_days',
      'writes_per_minute',
      'pulls_per_minute',
    ];
    for (const tier of Object.values(TIER_QUOTAS)) {
      for (const field of fields) {
        expect(tier).toHaveProperty(field);
      }
    }
  });
});
