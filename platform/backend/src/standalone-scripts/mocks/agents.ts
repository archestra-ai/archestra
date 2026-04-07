import { randomUUID } from "node:crypto";
import { urlSlugify } from "@shared";
import type { AgentScope, AgentType } from "@/types";

// Raw agent data for direct database insertion (without junction table fields like teams)
type MockAgentRaw = {
  id: string;
  name: string;
  slug: string | null;
  organizationId: string;
  authorId: string | null;
  scope: AgentScope;
  agentType: AgentType;

  isDefault: boolean;
  considerContextUntrusted: boolean;
};

export type MockAgentWithTeams = MockAgentRaw & {
  teamIds: string[];
};

export type GenerateMockAgentsParams = {
  organizationId: string;
  agentType: MockAgentRaw["agentType"];
  /** Prefix used in naming, e.g. "agent", "gw", "proxy" */
  namePrefix: string;
  users: Array<{ id: string; name: string; personalCount: number }>;
  teamConfig: Array<{ teamId: string; teamName: string; count: number }>;
  orgCount: number;
};

/**
 * Generate mock agents/gateways/proxies with explicit ownership patterns:
 * - Personal per user (only visible to that user)
 * - Team-scoped assigned to specific teams
 * - Org-wide visible to everyone
 */
export function generateMockAgents(
  params: GenerateMockAgentsParams,
): MockAgentWithTeams[] {
  const agents: MockAgentWithTeams[] = [];
  const { namePrefix: pfx } = params;

  // Personal per user
  for (const user of params.users) {
    for (let i = 1; i <= user.personalCount; i++) {
      const name = `${user.name}-${pfx}-personal-${i}`;
      agents.push({
        id: randomUUID(),
        name,
        slug: params.agentType === "mcp_gateway" ? urlSlugify(name) : null,
        organizationId: params.organizationId,
        authorId: user.id,
        scope: "personal",
        agentType: params.agentType,
        teamIds: [],

        isDefault: false,
        considerContextUntrusted: false,
      });
    }
  }

  // Team-scoped
  for (const config of params.teamConfig) {
    for (let i = 1; i <= config.count; i++) {
      const name = `${config.teamName}-${pfx}-team-${i}`;
      agents.push({
        id: randomUUID(),
        name,
        slug: params.agentType === "mcp_gateway" ? urlSlugify(name) : null,
        organizationId: params.organizationId,
        authorId: null,
        scope: "team",
        agentType: params.agentType,
        teamIds: [config.teamId],

        isDefault: false,
        considerContextUntrusted: false,
      });
    }
  }

  // Org-wide
  for (let i = 1; i <= params.orgCount; i++) {
    const name = `${pfx}-org-${i}`;
    agents.push({
      id: randomUUID(),
      name,
      slug: params.agentType === "mcp_gateway" ? urlSlugify(name) : null,
      organizationId: params.organizationId,
      authorId: null,
      scope: "org",
      agentType: params.agentType,
      teamIds: [],
      isDefault: false,
      considerContextUntrusted: false,
    });
  }

  return agents;
}
