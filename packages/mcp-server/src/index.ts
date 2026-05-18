#!/usr/bin/env node
/**
 * Mesh MCP server.
 * Exposes user's personal Mesh memory as tools to MCP-compatible agents
 * (Claude Desktop, Cursor, Continue, Windsurf).
 *
 * Install in Claude Desktop:
 *   claude mcp add mesh npx @mesh/mcp-server
 * with env MESH_API_KEY or MESH_ACCESS_TOKEN set.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.MESH_API_URL ?? 'https://api.mesh.so/v1';
const ACCESS_TOKEN = process.env.MESH_ACCESS_TOKEN ?? process.env.MESH_API_KEY ?? '';

if (!ACCESS_TOKEN) {
  console.error(
    '[mesh-mcp] MESH_ACCESS_TOKEN missing. Set it in your MCP client config.',
  );
}

async function apiCall(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Mesh API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const server = new Server(
  { name: 'mesh', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'mesh_pull',
      description:
        'Retrieve relevant context from the user personal Mesh graph. Use when the user asks about people, projects, dates, or anything they may have discussed/read before.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language query' },
          top_k: { type: 'number', default: 5, description: 'How many results (max 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'mesh_push',
      description:
        'Save a piece of information into the user Mesh graph. Use for facts the user explicitly asks to remember.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['content'],
      },
    },
    {
      name: 'mesh_traverse',
      description: 'Explore the graph around an entity (people, project, topic).',
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string' },
          depth: { type: 'number', default: 2 },
        },
        required: ['entity'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === 'mesh_pull') {
      const result = await apiCall('/search', { query: args?.query, top_k: args?.top_k ?? 5 });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'mesh_push') {
      const result = await apiCall('/nodes', {
        content: args?.content,
        source: 'mcp',
        tags: args?.tags ?? [],
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    if (name === 'mesh_traverse') {
      const result = await apiCall('/traverse', {
        entity: args?.entity,
        depth: args?.depth ?? 2,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mesh-mcp] server ready');
}

main().catch((e) => {
  console.error('[mesh-mcp] fatal', e);
  process.exit(1);
});
