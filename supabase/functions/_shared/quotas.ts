import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export type Tier = 'free' | 'personal' | 'pro';

interface QuotaCheckInput {
  tier: Tier;
  action: 'create_node' | 'add_connector' | 'inject';
  currentCounts: {
    nodes_total?: number;
    connectors_total?: number;
    injections_today?: number;
  };
}

const LIMITS: Record<Tier, Record<string, number | null>> = {
  free: { nodes_max: 1000, connectors_max: 1, injections_per_day: 100 },
  personal: { nodes_max: null, connectors_max: 3, injections_per_day: 1000 },
  pro: { nodes_max: null, connectors_max: null, injections_per_day: null },
};

export function isWithinQuota(input: QuotaCheckInput): { ok: boolean; reason?: string } {
  const limits = LIMITS[input.tier];
  if (input.action === 'create_node') {
    const max = limits.nodes_max;
    if (max !== null && (input.currentCounts.nodes_total ?? 0) >= max) {
      return { ok: false, reason: `nodes_max_reached (${max})` };
    }
  }
  if (input.action === 'add_connector') {
    const max = limits.connectors_max;
    if (max !== null && (input.currentCounts.connectors_total ?? 0) >= max) {
      return { ok: false, reason: `connectors_max_reached (${max})` };
    }
  }
  if (input.action === 'inject') {
    const max = limits.injections_per_day;
    if (max !== null && (input.currentCounts.injections_today ?? 0) >= max) {
      return { ok: false, reason: `injections_per_day_reached (${max})` };
    }
  }
  return { ok: true };
}

export async function getUserTier(client: SupabaseClient, userId: string): Promise<Tier> {
  const { data, error } = await client
    .from('users')
    .select('tier')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return 'free';
  return data.tier as Tier;
}
