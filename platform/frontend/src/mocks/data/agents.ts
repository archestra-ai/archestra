import type { archestraApiTypes } from "@archestra/shared";

type AgentsList = archestraApiTypes.GetAgentsResponses["200"];
type Agent = AgentsList["data"][number];
type AgentCatalog = archestraApiTypes.GetAgentCatalogResponses["200"];
export type ExternalAgent = Extract<
  AgentCatalog["data"][number],
  { type: "external" }
>["value"];

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent",
    organizationId: "test-org",
    authorId: "test-user-admin",
    createdByServiceAccountId: null,
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
    runtime: null,
    runtimeSecretId: null,
    missingCredentialBehavior: "allow",
    accessAllTools: false,
    accessAllSubagents: false,
    accessAllSkills: false,
    activationSkillMode: "all",
    activationSkillPolicyRevision: 0,
    builtInAgentConfig: null,
    builtIn: null,
    latestVersion: 0,
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
    pinnedAt: null,
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
  const total = overrides.pagination?.total ?? agents.length;
  return {
    data: agents,
    pagination: makePagination(total, overrides.pagination),
  };
}

export function makeAgentCatalog({
  agents = [],
  externalAgents = [],
  total = agents.length + externalAgents.length,
  agentTotal = agents.length,
  externalAgentTotal = externalAgents.length,
}: {
  agents?: Agent[];
  externalAgents?: ExternalAgent[];
  total?: number;
  agentTotal?: number;
  externalAgentTotal?: number;
} = {}): AgentCatalog {
  return {
    data: [
      ...externalAgents.map((value) => ({ type: "external" as const, value })),
      ...agents.map((value) => ({ type: "agent" as const, value })),
    ],
    pagination: makePagination(total),
    totals: {
      agents: agentTotal,
      externalAgents: externalAgentTotal,
    },
  };
}

export function makeExternalAgent(
  overrides: Partial<ExternalAgent> = {},
): ExternalAgent {
  return {
    id: "external-agent",
    organizationId: "org-1",
    name: "Partner Agent",
    description: "Delegates work to a partner system",
    discoveryMode: "well_known",
    discoveryUrl: "https://agent.example.com",
    agentCard: { name: "Partner Agent" },
    cardHash: "card-hash",
    lastDiscoveredAt: "2026-09-08T12:00:00.000Z",
    createdAt: "2026-09-08T12:00:00.000Z",
    updatedAt: "2026-09-08T12:00:00.000Z",
    scope: "org",
    authorId: "user-1",
    createdByServiceAccountId: null,
    authorName: "Test User",
    createdBy: {
      id: "user-1",
      type: "user",
      name: "Test User",
      email: "test@example.com",
    },
    teams: [],
    users: [],
    connection: {
      id: "connection-1",
      remoteAgentId: "external-agent",
      selectedInterface: {
        url: "https://agent.example.com/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
      securityRequirement: null,
      authType: "none",
      authConfig: {},
      enabled: true,
      lastVerifiedAt: "2026-09-08T12:00:00.000Z",
      createdAt: "2026-09-08T12:00:00.000Z",
      updatedAt: "2026-09-08T12:00:00.000Z",
      hasCredential: false,
    },
    toolId: "tool-1",
    assignmentCount: 1,
    lastUsedAt: null,
    ...overrides,
  };
}

export const agentsSeed = makeAgentsList();

function makePagination(
  total: number,
  overrides: Partial<AgentsList["pagination"]> = {},
): AgentsList["pagination"] {
  const currentPage = overrides.currentPage ?? 1;
  const limit = overrides.limit ?? 50;
  const totalPages = Math.ceil(total / limit);
  return {
    currentPage,
    limit,
    total,
    totalPages,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
    ...overrides,
  };
}
