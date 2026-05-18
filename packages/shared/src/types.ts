/**
 * Mesh shared TypeScript types.
 * Mirrors the public DB schema.
 */

export type Tier = 'free' | 'personal' | 'pro';

export type NodeSource =
  | 'extension'
  | 'manual'
  | 'mcp'
  | `connector:${ConnectorProvider}`;

export type ConnectorProvider =
  | 'gmail'
  | 'gcal'
  | 'slack'
  | 'notion'
  | 'linear'
  | 'github'
  | 'figma'
  | 'gdocs';

export type ConnectorStatus = 'active' | 'paused' | 'error' | 'revoked';

export type EdgeRelation =
  | 'inferred'
  | 'explicit'
  | 'temporal'
  | 'contradicts'
  | 'supersedes'
  | 'user_linked';

export type EntityType =
  | 'PERSON'
  | 'ORG'
  | 'LOCATION'
  | 'DATE'
  | 'PROJECT'
  | 'PRODUCT'
  | 'TOPIC';

export interface Entity {
  type: EntityType;
  value: string;
  normalized: string;
}

export interface ContextNode {
  id: string;
  user_id: string;
  source: NodeSource;
  source_url: string | null;
  source_app: string | null;
  content: string;
  summary: string | null;
  embedding: number[] | null;
  embedding_model: string;
  entities: Entity[];
  tags: string[];
  user_tags: string[];
  score: number | null;
  sensitivity: number | null;
  acl_agents: string[];
  ttl_at: string | null;
  pinned: boolean;
  edited_summary: string | null;
  fingerprint: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ContextEdge {
  id: string;
  user_id: string;
  from_node: string;
  to_node: string;
  relation_type: EdgeRelation;
  confidence: number | null;
  shared_entity: string | null;
  note: string | null;
  created_at: string;
}

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  tier: Tier;
  stripe_customer_id: string | null;
  region: string;
  locale: string;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface InjectionLog {
  id: string;
  user_id: string;
  target_agent: string;
  query_hash: string;
  query_excerpt: string | null;
  node_ids: string[];
  injected_text: string | null;
  user_accepted: boolean | null;
  latency_ms: number | null;
  created_at: string;
}

export interface SearchResult {
  id: string;
  content: string;
  summary: string | null;
  source: string;
  source_url: string | null;
  source_app: string | null;
  entities: Entity[];
  tags: string[];
  created_at: string;
  score: number;
}
