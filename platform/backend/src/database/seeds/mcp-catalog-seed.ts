// ─────────────────────────────────────────────────────────────────────────────
// CATALOG ENTRIES: n8n-mcp and excalidraw-mcp
//
// Add these to wherever your catalog is seeded/stored.
// Based on the internalMcpCatalogTable schema in:
//   backend/src/database/schemas/internal-mcp-catalog.ts
//
// If you have a seed file (e.g. seeds/mcp-catalog.ts), append both objects.
// If you store catalog entries via an admin API, POST them to that endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import type { InternalMcpCatalog } from "@/types"; // adjust import as needed

export const n8nMcpCatalogEntry: InternalMcpCatalog = {
  name: "n8n-mcp",
  version: "1.0.0",
  description:
    "Exposes n8n workflow automation as MCP tools. Trigger workflows, list executions, " +
    "inspect results, and manage credentials — all from your AI assistant.",
  instructions:
    "Connect to your self-hosted or cloud n8n instance. " +
    "Provide the n8n base URL and an API key with workflow execution permissions.",
  repository: "https://github.com/leonardsellem/n8n-mcp-server",
  installationCommand: "npx -y n8n-mcp-server",
  requiresAuth: true,
  authDescription:
    "Requires an n8n API key and the base URL of your n8n instance.",
  authFields: [
    {
      name: "N8N_BASE_URL",
      label: "n8n Base URL",
      description: "e.g. https://your-n8n.example.com",
      type: "text",
      required: true,
    },
    {
      name: "N8N_API_KEY",
      label: "n8n API Key",
      description: "Found under Settings → API in your n8n dashboard.",
      type: "secret",
      required: true,
    },
  ],
  serverType: "local", // runs as a local stdio MCP server via npx
  localConfig: {
    command: "npx",
    arguments: ["-y", "n8n-mcp-server"],
    env: {
      N8N_BASE_URL: "{{N8N_BASE_URL}}",
      N8N_API_KEY: "{{N8N_API_KEY}}",
    },
  },
  userConfig: {},
  icon: "🔄",
  scope: "org",
};

export const excalidrawMcpCatalogEntry: InternalMcpCatalog = {
  name: "excalidraw-mcp",
  version: "1.0.0",
  description:
    "Lets your AI assistant create, read, and update Excalidraw diagrams. " +
    "Results render as interactive whiteboard canvases directly in the chat.",
  instructions:
    "No external credentials needed for local use. " +
    "For Excalidraw+ cloud sync, supply your storage backend URL and API key.",
  repository: "https://github.com/i-am-bee/excalidraw-mcp",
  installationCommand: "npx -y excalidraw-mcp",
  requiresAuth: false,
  authDescription: null,
  authFields: [],
  serverType: "local",
  localConfig: {
    command: "npx",
    arguments: ["-y", "excalidraw-mcp"],
    env: {},
  },
  userConfig: {},
  // The tool result will carry _meta.ui.resourceUri = "ui://excalidraw/<id>"
  // which McpAppView will render as an iframe canvas.
  icon: "✏️",
  scope: "org",
};

// ─────────────────────────────────────────────────────────────────────────────
// If you use a Drizzle seed script, insert like this:
// ─────────────────────────────────────────────────────────────────────────────

/*
import { db } from "@/database";
import internalMcpCatalogTable from "@/database/schemas/internal-mcp-catalog";

await db
  .insert(internalMcpCatalogTable)
  .values([n8nMcpCatalogEntry, excalidrawMcpCatalogEntry])
  .onConflictDoNothing(); // skip if name already exists (add a unique index on `name` if needed)
*/
