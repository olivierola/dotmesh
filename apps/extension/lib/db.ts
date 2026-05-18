import Dexie, { type Table } from 'dexie';

export interface QueuedItem {
  id?: number;
  status: 'pending' | 'sent' | 'failed';
  payload: {
    content: string;
    source: string;
    source_url?: string;
    source_app?: string;
    tags?: string[];
    score?: number;
    sensitivity?: number;
    metadata?: Record<string, unknown>;
  };
  attempts: number;
  ts: number;
  fingerprint: string;
}

export interface FingerprintRow {
  hash: string;
  ts: number;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

class MeshDB extends Dexie {
  queue!: Table<QueuedItem, number>;
  fingerprints!: Table<FingerprintRow, string>;
  settings!: Table<SettingRow, string>;

  constructor() {
    super('mesh-ext');
    this.version(1).stores({
      queue: '++id, status, ts',
      fingerprints: 'hash, ts',
      settings: 'key',
    });
  }
}

export const db = new MeshDB();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return (row?.value as T) ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
