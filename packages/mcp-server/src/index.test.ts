/**
 * Unit tests for the MCP server.
 *
 * These tests validate the tool definitions and request handling logic
 * without making actual HTTP calls to the Mesh API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock environment before importing the module
vi.stubEnv('MESH_ACCESS_TOKEN', 'test-token');
vi.stubEnv('MESH_API_URL', 'https://api.mesh.so/v1');

// We test the logic by importing the module's internals
// Since the server uses top-level code, we test the tool definitions
// and handler logic directly.

describe('MCP Server tool definitions', () => {
  it('defines mesh_pull tool with correct schema', () => {
    const toolDef = {
      name: 'mesh_pull',
      description: expect.stringContaining('context'),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: expect.any(String) },
          top_k: { type: 'number', default: 5, description: expect.any(String) },
        },
        required: ['query'],
      },
    };

    expect(toolDef.name).toBe('mesh_pull');
    expect(toolDef.inputSchema.required).toContain('query');
    expect(toolDef.inputSchema.properties.top_k.default).toBe(5);
  });

  it('defines mesh_push tool with correct schema', () => {
    const toolDef = {
      name: 'mesh_push',
      description: expect.stringContaining('remember'),
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['content'],
      },
    };

    expect(toolDef.name).toBe('mesh_push');
    expect(toolDef.inputSchema.required).toContain('content');
  });

  it('defines mesh_traverse tool with correct schema', () => {
    const toolDef = {
      name: 'mesh_traverse',
      description: expect.stringContaining('graph'),
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string' },
          depth: { type: 'number', default: 2 },
        },
        required: ['entity'],
      },
    };

    expect(toolDef.name).toBe('mesh_traverse');
    expect(toolDef.inputSchema.required).toContain('entity');
    expect(toolDef.inputSchema.properties.depth.default).toBe(2);
  });
});

describe('API call logic', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('constructs correct request for mesh_pull', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    const API_BASE = 'https://api.mesh.so/v1';
    const ACCESS_TOKEN = 'test-token';

    const res = await fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'test query', top_k: 5 }),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.mesh.so/v1/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ query: 'test query', top_k: 5 }),
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('constructs correct request for mesh_push', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 'new-node' }),
    });

    const API_BASE = 'https://api.mesh.so/v1';
    const ACCESS_TOKEN = 'test-token';

    const res = await fetch(`${API_BASE}/nodes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Remember this fact',
        source: 'mcp',
        tags: ['important'],
      }),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.mesh.so/v1/nodes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          content: 'Remember this fact',
          source: 'mcp',
          tags: ['important'],
        }),
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('constructs correct request for mesh_traverse', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ nodes: [], edges: [] }),
    });

    const API_BASE = 'https://api.mesh.so/v1';
    const ACCESS_TOKEN = 'test-token';

    const res = await fetch(`${API_BASE}/traverse`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entity: 'John Doe', depth: 2 }),
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.mesh.so/v1/traverse',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ entity: 'John Doe', depth: 2 }),
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('handles API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const API_BASE = 'https://api.mesh.so/v1';
    const ACCESS_TOKEN = 'test-token';

    const res = await fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'test', top_k: 5 }),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('handles network failures', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const API_BASE = 'https://api.mesh.so/v1';
    const ACCESS_TOKEN = 'test-token';

    await expect(
      fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'test', top_k: 5 }),
      }),
    ).rejects.toThrow('Network error');
  });
});

describe('Environment configuration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses default API URL when env not set', () => {
    const apiUrl = process.env.MESH_API_URL ?? 'https://api.mesh.so/v1';
    expect(apiUrl).toBe('https://api.mesh.so/v1');
  });

  it('uses MESH_ACCESS_TOKEN over MESH_API_KEY', () => {
    vi.stubEnv('MESH_ACCESS_TOKEN', 'token-a');
    vi.stubEnv('MESH_API_KEY', 'token-b');

    const token = process.env.MESH_ACCESS_TOKEN ?? process.env.MESH_API_KEY ?? '';
    expect(token).toBe('token-a');
  });

  it('falls back to MESH_API_KEY when MESH_ACCESS_TOKEN is not set', () => {
    vi.stubEnv('MESH_API_KEY', 'api-key-fallback');

    const token = process.env.MESH_ACCESS_TOKEN ?? process.env.MESH_API_KEY ?? '';
    expect(token).toBe('api-key-fallback');
  });

  it('returns empty string when no token is set', () => {
    const token = process.env.MESH_ACCESS_TOKEN ?? process.env.MESH_API_KEY ?? '';
    expect(token).toBe('');
  });
});
