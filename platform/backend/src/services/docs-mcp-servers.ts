import { resolveDynamicTool } from "@/archestra-mcp-server/dynamic-tools";
import { AgentModel, McpServerModel, ToolModel } from "@/models";
import type { Agent } from "@/types";

export type DocsMcpServer = {
  catalogId: string;
  name: string;
  description: string;
  serverUrl: string;
  docsUrl: string;
  icon: string;
  suggestedPrompt: { summaryTitle: string; prompt: string };
};

// The project logos, used as the catalog icons. Declared before the server
// list, which reads them at module load.
const ARCHESTRA_LOGO_SVG = `<svg width="32" height="32" viewBox="0 0 994 953" xmlns="http://www.w3.org/2000/svg"><rect width="993.958" height="952.543" rx="204.92" fill="black"/><path fill-rule="evenodd" clip-rule="evenodd" d="M390.871 664.818C427.68 664.818 460.629 641.985 473.553 607.519L565.238 363.026C586.887 305.296 544.211 243.715 482.556 243.715C445.747 243.715 412.798 266.548 399.874 301.014L308.189 545.507C286.54 603.237 329.216 664.818 390.871 664.818Z" fill="white"/><ellipse cx="638.487" cy="577.095" rx="87.7298" ry="81.1501" fill="white"/></svg>`;

const OPENAPPA_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges"><rect width="32" height="32" rx="6.6" fill="#211e1b" shape-rendering="geometricPrecision"/><g transform="translate(4,5)"><rect x="5" y="0" width="2" height="2" fill="#efece6"/><rect x="17" y="0" width="2" height="2" fill="#efece6"/><rect x="4" y="2" width="16" height="1" fill="#efece6"/><rect x="3" y="3" width="18" height="3" fill="#efece6"/><rect x="3" y="6" width="3" height="3" fill="#efece6"/><rect x="9" y="6" width="6" height="3" fill="#efece6"/><rect x="18" y="6" width="3" height="3" fill="#efece6"/><rect x="6" y="6" width="3" height="3" fill="#211e1b"/><rect x="15" y="6" width="3" height="3" fill="#211e1b"/><rect x="3" y="9" width="18" height="1" fill="#efece6"/><rect x="3" y="10" width="7" height="2" fill="#efece6"/><rect x="14" y="10" width="7" height="2" fill="#efece6"/><rect x="10" y="10" width="4" height="1" fill="#8f8b86"/><rect x="10" y="11" width="1" height="1" fill="#8f8b86"/><rect x="11" y="11" width="2" height="1" fill="#211e1b"/><rect x="13" y="11" width="1" height="1" fill="#8f8b86"/><rect x="3" y="12" width="18" height="1" fill="#efece6"/><rect x="4" y="13" width="16" height="1" fill="#efece6"/><rect x="1" y="14" width="22" height="1" fill="#efece6"/><rect x="0" y="15" width="24" height="5" fill="#efece6"/><rect x="0" y="20" width="5" height="1" fill="#efece6"/><rect x="7" y="20" width="4" height="1" fill="#efece6"/><rect x="13" y="20" width="4" height="1" fill="#efece6"/><rect x="19" y="20" width="5" height="1" fill="#efece6"/><rect x="0" y="21" width="5" height="1" fill="#8f8b86"/><rect x="7" y="21" width="4" height="1" fill="#8f8b86"/><rect x="13" y="21" width="4" height="1" fill="#8f8b86"/><rect x="19" y="21" width="5" height="1" fill="#8f8b86"/></g></svg>`;

/**
 * The public docs MCP servers a fresh community instance installs (see
 * seedDocsMcpServers). Each has a fixed catalog id.
 */
export const DOCS_MCP_SERVERS: DocsMcpServer[] = [
  {
    catalogId: "00000000-0000-4000-8000-000000000003",
    name: "Archestra Docs",
    description: "The Archestra documentation",
    serverUrl: "https://archestra.ai/mcp",
    docsUrl: "https://archestra.ai/docs",
    icon: svgDataUrl(ARCHESTRA_LOGO_SVG),
    suggestedPrompt: {
      summaryTitle: "What can Archestra do?",
      prompt:
        "What can Archestra do? Use the Archestra Docs tools to read the current documentation, then give me a short tour of the main features, with links to the docs pages.",
    },
  },
  {
    catalogId: "00000000-0000-4000-8000-000000000004",
    name: "OpenAPPA Docs",
    description: "The OpenAPPA documentation",
    serverUrl: "https://www.openappa.com/mcp",
    docsUrl: "https://www.openappa.com",
    icon: svgDataUrl(OPENAPPA_LOGO_SVG),
    suggestedPrompt: {
      summaryTitle: "How does OpenAPPA protect agents?",
      prompt:
        "How does OpenAPPA keep my agents from leaking data? Use the OpenAPPA Docs tools to read the current documentation, then explain it in a few short points, with links to the docs pages.",
    },
  },
];

export const DOCS_MCP_CATALOG_IDS = DOCS_MCP_SERVERS.map(
  (server) => server.catalogId,
);

/**
 * Suggested prompts for the docs servers, shown in chat but never stored.
 *
 * Only the caller's own personal chat agent (My Assistant) gets them, and only
 * while it has no suggested prompts of its own. Each server's prompt is
 * offered only while the agent can run that server's tools for the caller:
 * the server is installed, and the tool resolves through the same dynamic
 * access path run_tool uses (catalog visibility, environment, per-agent
 * exclusions, and tool permissions).
 */
export async function getDocsSuggestedPrompts(params: {
  agent: Pick<Agent, "id" | "suggestedPrompts">;
  userId: string;
  organizationId: string;
}): Promise<DocsMcpServer["suggestedPrompt"][]> {
  const { agent, userId, organizationId } = params;
  if (agent.suggestedPrompts.length > 0) return [];
  const personalChatAgentId = await AgentModel.findPersonalChatAgentId({
    userId,
    organizationId,
  });
  if (personalChatAgentId !== agent.id) return [];

  const reachable = await Promise.all(
    DOCS_MCP_SERVERS.map((server) =>
      canRunServerTools({ server, agentId: agent.id, userId, organizationId }),
    ),
  );
  return DOCS_MCP_SERVERS.filter((_, index) => reachable[index]).map(
    (server) => server.suggestedPrompt,
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

async function canRunServerTools(params: {
  server: DocsMcpServer;
  agentId: string;
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  const { server, agentId, userId, organizationId } = params;
  // Discovery follows catalog visibility, not installs, so an uninstalled
  // server's tools would still resolve. Its prompt could only fail.
  const installs = await McpServerModel.findByCatalogId(server.catalogId);
  if (installs.length === 0) return false;
  const [tool] = await ToolModel.findByCatalogId(server.catalogId);
  if (!tool) return false;
  const resolved = await resolveDynamicTool({
    toolName: tool.name,
    agentId,
    userId,
    organizationId,
  });
  return resolved !== null;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
