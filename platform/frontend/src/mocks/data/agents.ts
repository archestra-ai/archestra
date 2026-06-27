import type { archestraApiTypes } from "@archestra/shared";

type AgentsList = archestraApiTypes.GetAgentsResponses["200"];
type Agent = AgentsList["data"][number];

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent",
    organizationId: "test-org",
    authorId: "test-user-admin",
    scope: "personal",
    name: "test-agent",
    slug: null,
    isDefault: false,
    isPersonalGateway: false,
    isPersonalProxy: false,
    considerContextUntrusted: false,
    agentType: "agent",
    systemPrompt: null,
    description: null,
    icon: null,
    incomingEmailEnabled: false,
    incomingEmailSecurityMode: "private",
    incomingEmailAllowedDomain: null,
    llmApiKeyId: null,
    llmModel: null,
    modelId: null,
    identityProviderId: null,
    environmentId: null,
    passthroughHeaders: null,
    toolExposureMode: "full",
    accessAllTools: false,
    builtInAgentConfig: null,
    builtIn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    tools: [],
    teams: [],
    labels: [],
    authorName: "Test Admin",
    knowledgeBaseIds: [],
    connectorIds: [],
    suggestedPrompts: [],
    ...overrides,
  };
}

export function makeAgentsList(
  overrides: {
    agents?: Agent[];
    pagination?: Partial<AgentsList["pagination"]>;
  } = {},
): AgentsList {
  const agents = overrides.agents ?? [];
  return {
    data: agents,
    pagination: {
      currentPage: 1,
      limit: 50,
      total: agents.length,
      totalPages: agents.length === 0 ? 0 : 1,
      hasNext: false,
      hasPrev: false,
      ...overrides.pagination,
    },
  };
}

export const agentsSeed = makeAgentsList();
