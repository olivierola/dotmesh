# @mesh/mcp-server

MCP server for Mesh. Exposes your personal memory graph to MCP-compatible AI agents (Claude Desktop, Cursor, Continue, Windsurf).

## Install

```bash
npx @mesh/mcp-server
```

## Configure (Claude Desktop)

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mesh": {
      "command": "npx",
      "args": ["@mesh/mcp-server"],
      "env": {
        "MESH_ACCESS_TOKEN": "your-token-here"
      }
    }
  }
}
```

Get a token from https://mesh.so/settings/api once authenticated.

## Tools exposed

- `mesh_pull(query, top_k?)` — semantic search over your memory
- `mesh_push(content, tags?)` — explicit memory save
- `mesh_traverse(entity, depth?)` — graph exploration

## Development

```bash
pnpm build
node dist/index.js  # stdio mode
```
