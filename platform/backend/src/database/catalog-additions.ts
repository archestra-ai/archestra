/**
 * catalog-additions.ts
 *
 * New catalog entries for n8n-mcp and excalidraw-mcp.
 *
 * HOW TO INTEGRATE:
 * Find the file in the backend that seeds or defines catalog entries
 * (likely backend/src/database/seeds/ or backend/src/routes/internal-mcp-catalog.ts).
 *
 * The format below follows the internalMcpCatalogTable schema.
 * Add these objects to wherever catalog items are defined.
 */

// ── n8n MCP ────────────────────────────────────────────────────────────────

export const N8N_MCP_CATALOG_ENTRY = {
  // The npm package: https://github.com/czlonkowski/n8n-mcp
  name: "n8n-mcp",
  displayName: "n8n Workflow Automation",
  description:
    "Connect AI agents to your n8n instance. Create, trigger, and monitor n8n workflows directly from chat. " +
    "Supports MCP Apps — renders a live workflow visualization UI inline in the chat.",
  icon: "https://n8n.io/favicon.ico",
  githubUrl: "https://github.com/czlonkowski/n8n-mcp",
  npmPackage: "@czlonkowski/n8n-mcp",

  // Transport: stdio (run via npx)
  transport: "stdio" as const,
  command: "npx",
  args: ["@czlonkowski/n8n-mcp"],

  // Environment variables required by the user during installation
  envVars: [
    {
      name: "N8N_BASE_URL",
      label: "n8n Base URL",
      description:
        "URL of your n8n instance (e.g. http://localhost:5678 or https://your-n8n.domain.com)",
      required: true,
      type: "url",
    },
    {
      name: "N8N_API_KEY",
      label: "n8n API Key",
      description: "Your n8n API key (Settings → API → Create API Key)",
      required: true,
      type: "secret",
    },
  ],

  // MCP Apps capability declared
  hasMcpAppsUi: true,

  categories: ["automation", "workflow", "integration"],
  tags: ["n8n", "workflow", "automation", "no-code"],
  scope: "org" as const,
};

// ── Excalidraw MCP ────────────────────────────────────────────────────────

export const EXCALIDRAW_MCP_CATALOG_ENTRY = {
  // Official server: https://mcp.excalidraw.com/mcp
  name: "excalidraw-mcp",
  displayName: "Excalidraw Diagrams",
  description:
    "Create, edit, and view Excalidraw diagrams inline in chat. " +
    "Ask the AI to draw architecture diagrams, flowcharts, and sketches — " +
    "they render as an interactive canvas directly in the conversation. " +
    "Uses MCP Apps for live collaborative drawing.",
  icon: "https://excalidraw.com/favicon.ico",
  githubUrl: "https://github.com/excalidraw/excalidraw-mcp",

  // Transport: streamable HTTP (remote, no local install needed)
  transport: "http" as const,
  url: "https://mcp.excalidraw.com/mcp",

  // No auth required for the official public endpoint
  authType: "none" as const,

  // MCP Apps capability declared
  hasMcpAppsUi: true,

  categories: ["design", "diagramming", "visualization"],
  tags: ["excalidraw", "diagram", "drawing", "canvas", "whiteboard"],
  scope: "org" as const,
};

/**
 * ── SQL Version ────────────────────────────────────────────────────────────
 *
 * If the catalog is seeded via SQL rather than TypeScript, use:
 *
 * INSERT INTO internal_mcp_catalog (name, display_name, description, icon, github_url, transport, config, has_mcp_apps_ui, categories, tags, scope)
 * VALUES
 *   (
 *     'n8n-mcp',
 *     'n8n Workflow Automation',
 *     'Connect AI agents to n8n. Create, trigger, and monitor workflows from chat. Supports MCP Apps UI.',
 *     'https://n8n.io/favicon.ico',
 *     'https://github.com/czlonkowski/n8n-mcp',
 *     'stdio',
 *     '{"command": "npx", "args": ["@czlonkowski/n8n-mcp"], "envVars": [{"name": "N8N_BASE_URL", "required": true}, {"name": "N8N_API_KEY", "required": true, "secret": true}]}'::jsonb,
 *     true,
 *     ARRAY['automation', 'workflow', 'integration'],
 *     ARRAY['n8n', 'workflow', 'automation', 'no-code'],
 *     'org'
 *   ),
 *   (
 *     'excalidraw-mcp',
 *     'Excalidraw Diagrams',
 *     'Create and view Excalidraw diagrams inline in chat. AI draws architecture diagrams and flowcharts as interactive canvases.',
 *     'https://excalidraw.com/favicon.ico',
 *     'https://github.com/excalidraw/excalidraw-mcp',
 *     'http',
 *     '{"url": "https://mcp.excalidraw.com/mcp", "auth": "none"}'::jsonb,
 *     true,
 *     ARRAY['design', 'diagramming', 'visualization'],
 *     ARRAY['excalidraw', 'diagram', 'drawing', 'canvas'],
 *     'org'
 *   );
 */
