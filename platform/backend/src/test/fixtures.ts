/**
 * biome-ignore-all lint/correctness/noEmptyPattern: oddly enough in extend below this is required
 * see https://vitest.dev/guide/test-context.html#extend-test-context
 */
import { ADMIN_ROLE_NAME, type AnyRoleName, MEMBER_ROLE_NAME } from "@shared";
import { beforeEach as baseBeforeEach, test as baseTest } from "vitest";
import db, { schema } from "@/database";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  OrganizationRoleModel,
  SessionModel,
  ToolInvocationPolicyModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "@/models";
import type {
  Agent,
  AgentTool,
  InsertAccount,
  InsertConversation,
  InsertInteraction,
  InsertInternalMcpCatalog,
  InsertInvitation,
  InsertMcpServer,
  InsertMember,
  InsertOrganization,
  InsertOrganizationRole,
  InsertSession,
  InsertTeam,
  InsertUser,
  OrganizationRole,
  Tool,
  ToolInvocation,
  TrustedData,
} from "@/types";

type MakeUserOverrides = Partial<
  Pick<InsertUser, "email" | "name" | "role" | "emailVerified">
>;

/**
 * Vitest test extension with fixtures
 * https://vitest.dev/guide/test-context.html#extend-test-context
 */
interface TestFixtures {
  makeUser: typeof makeUser;
  makeAdmin: typeof makeAdmin;
  makeOrganization: typeof makeOrganization;
  makeTeam: typeof makeTeam;
  makeAgent: typeof makeAgent;
  makeTool: typeof makeTool;
  makeAgentTool: typeof makeAgentTool;
  makeToolPolicy: typeof makeToolPolicy;
  makeTrustedDataPolicy: typeof makeTrustedDataPolicy;
  makeCustomRole: typeof makeCustomRole;
  makeMember: typeof makeMember;
  makeMcpServer: typeof makeMcpServer;
  makeInternalMcpCatalog: typeof makeInternalMcpCatalog;
  makeInvitation: typeof makeInvitation;
  makeAccount: typeof makeAccount;
  makeSession: typeof makeSession;
  makeConversation: typeof makeConversation;
  makeInteraction: typeof makeInteraction;
}

async function _makeUser(
  role: AnyRoleName,
  namePrefix: string,
  overrides: MakeUserOverrides = {},
) {
  const userId = crypto.randomUUID();
  const [user] = await db
    .insert(schema.usersTable)
    .values({
      id: userId,
      name: `${namePrefix} ${userId.substring(0, 8)}`,
      email: `${userId}@test.com`,
      emailVerified: true,
      role,
      ...overrides,
    })
    .returning();
  return user;
}

/**
 * Creates a test user in the database
 */
async function makeUser(overrides: MakeUserOverrides = {}) {
  return await _makeUser(MEMBER_ROLE_NAME, "Test User", overrides);
}

/**
 * Creates a test admin user in the database
 */
async function makeAdmin(overrides: MakeUserOverrides = {}) {
  return await _makeUser(ADMIN_ROLE_NAME, "Admin User", overrides);
}

/**
 * Creates a test organization in the database
 */
async function makeOrganization(
  overrides: Partial<Pick<InsertOrganization, "name" | "slug">> = {},
) {
  const orgId = crypto.randomUUID();
  const [org] = await db
    .insert(schema.organizationsTable)
    .values({
      id: orgId,
      name: `Test Org ${orgId.substring(0, 8)}`,
      slug: `test-org-${orgId.substring(0, 8)}`,
      createdAt: new Date(),
      limitCleanupInterval: null,
      theme: "modern-minimal",
      customFont: "lato",
      ...overrides,
    })
    .returning();
  return org;
}

/**
 * Creates a test team using the Team model
 */
async function makeTeam(
  organizationId: string,
  createdBy: string,
  overrides: Partial<Pick<InsertTeam, "name" | "description">> = {},
) {
  const [team] = await db
    .insert(schema.teamsTable)
    .values({
      id: crypto.randomUUID(),
      name: `Test Team ${crypto.randomUUID().substring(0, 8)}`,
      organizationId,
      createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .returning();
  return team;
}

/**
 * Creates a test agent using the Agent model
 */
async function makeAgent(
  overrides: Partial<Pick<Agent, "name" | "teams" | "labels">> = {},
): Promise<Agent> {
  return await AgentModel.create({
    name: `Test Agent ${crypto.randomUUID().substring(0, 8)}`,
    teams: [],
    labels: [],
    ...overrides,
  });
}

/**
 * Creates a test tool using the Tool model
 */
async function makeTool(
  overrides: Partial<
    Pick<
      Tool,
      | "name"
      | "description"
      | "parameters"
      | "catalogId"
      | "mcpServerId"
      | "agentId"
    >
  > = {},
): Promise<Tool> {
  const toolData = {
    name: `test-tool-${crypto.randomUUID().substring(0, 8)}`,
    description: "Test tool description",
    parameters: {},
    ...overrides,
  };

  await ToolModel.createToolIfNotExists(toolData);
  const tool = await ToolModel.findByName(toolData.name);

  if (!tool) {
    throw new Error(`Failed to create tool: ${toolData.name}`);
  }

  return tool;
}

/**
 * Creates a test agent-tool relationship using the AgentTool model
 */
async function makeAgentTool(
  agentId: string,
  toolId: string,
  overrides: Partial<
    Pick<
      AgentTool,
      "allowUsageWhenUntrustedDataIsPresent" | "toolResultTreatment"
    >
  > = {},
) {
  return await AgentToolModel.create(agentId, toolId, {
    allowUsageWhenUntrustedDataIsPresent: false,
    toolResultTreatment: "untrusted" as const,
    ...overrides,
  });
}

/**
 * Creates a test tool invocation policy using the ToolInvocationPolicy model
 */
async function makeToolPolicy(
  agentToolId: string,
  overrides: Partial<
    Pick<
      ToolInvocation.ToolInvocationPolicy,
      "argumentName" | "operator" | "value" | "action" | "reason"
    >
  > = {},
): Promise<ToolInvocation.ToolInvocationPolicy> {
  return await ToolInvocationPolicyModel.create({
    agentToolId,
    argumentName: "test-arg",
    operator: "equal",
    value: "test-value",
    action: "block_always",
    reason: "Test policy reason",
    ...overrides,
  });
}

/**
 * Creates a test trusted data policy using the TrustedDataPolicy model
 * Returns the created policy
 */
async function makeTrustedDataPolicy(
  agentToolId: string,
  overrides: Partial<
    Pick<
      TrustedData.TrustedDataPolicy,
      "description" | "attributePath" | "operator" | "value" | "action"
    >
  > = {},
): Promise<TrustedData.TrustedDataPolicy> {
  return await TrustedDataPolicyModel.create({
    agentToolId,
    description: "Test trusted data policy",
    attributePath: "test.path",
    operator: "equal",
    value: "test-value",
    action: "mark_as_trusted",
    ...overrides,
  });
}

/**
 * Creates a test custom organization role using the OrganizationRole model
 * Returns the created role
 */
async function makeCustomRole(
  organizationId: string,
  overrides: Partial<Pick<InsertOrganizationRole, "name" | "permission">> = {},
): Promise<OrganizationRole> {
  return await OrganizationRoleModel.create({
    id: crypto.randomUUID(),
    name: `Test Role ${crypto.randomUUID().substring(0, 8)}`,
    organizationId,
    permission: { agent: ["read"] },
    ...overrides,
  });
}

/**
 * Creates a test member relationship between user and organization
 */
async function makeMember(
  userId: string,
  organizationId: string,
  overrides: Partial<Pick<InsertMember, "role">> = {},
) {
  const [member] = await db
    .insert(schema.membersTable)
    .values({
      id: crypto.randomUUID(),
      userId,
      organizationId,
      role: MEMBER_ROLE_NAME,
      createdAt: new Date(),
      ...overrides,
    })
    .returning();
  return member;
}

/**
 * Creates a test MCP server in the database
 */
async function makeMcpServer(
  overrides: Partial<
    Pick<InsertMcpServer, "name" | "catalogId" | "ownerId" | "serverType">
  > = {},
) {
  const [mcpServer] = await db
    .insert(schema.mcpServersTable)
    .values({
      name: `test-server-${crypto.randomUUID().substring(0, 8)}`,
      serverType: "local",
      catalogId: `test-catalog-${crypto.randomUUID().substring(0, 8)}`,
      secretId: null,
      ownerId: null,
      authType: null,
      reinstallRequired: false,
      localInstallationStatus: "idle",
      localInstallationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .returning();
  return mcpServer;
}

/**
 * Creates a test internal MCP catalog item
 */
async function makeInternalMcpCatalog(
  overrides: Partial<
    Pick<
      InsertInternalMcpCatalog,
      | "name"
      | "serverType"
      | "serverUrl"
      | "description"
      | "version"
      | "repository"
      | "installationCommand"
      | "requiresAuth"
      | "authDescription"
      | "authFields"
      | "localConfig"
      | "userConfig"
      | "oauthConfig"
    >
  > = {},
) {
  return await InternalMcpCatalogModel.create({
    name: `test-catalog-${crypto.randomUUID().substring(0, 8)}`,
    serverType: "remote",
    serverUrl: "https://api.example.com/mcp/",
    ...overrides,
  });
}

/**
 * Creates a test invitation
 */
async function makeInvitation(
  organizationId: string,
  inviterId: string,
  overrides: Partial<Pick<InsertInvitation, "email" | "role" | "status">> = {},
) {
  const [invitation] = await db
    .insert(schema.invitationsTable)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      email: `test-${crypto.randomUUID().substring(0, 8)}@example.com`,
      role: MEMBER_ROLE_NAME,
      status: "pending",
      expiresAt: new Date(Date.now() + 86400000),
      inviterId,
      ...overrides,
    })
    .returning();
  return invitation;
}

/**
 * Creates a test account
 */
async function makeAccount(
  userId: string,
  overrides: Partial<
    Pick<InsertAccount, "accountId" | "providerId" | "accessToken">
  > = {},
) {
  const [account] = await db
    .insert(schema.accountsTable)
    .values({
      id: crypto.randomUUID(),
      accountId: `oauth-account-${crypto.randomUUID().substring(0, 8)}`,
      providerId: "google",
      userId,
      accessToken: `access-token-${crypto.randomUUID().substring(0, 8)}`,
      refreshToken: `refresh-token-${crypto.randomUUID().substring(0, 8)}`,
      idToken: `id-token-${crypto.randomUUID().substring(0, 8)}`,
      accessTokenExpiresAt: new Date(Date.now() + 3600000),
      refreshTokenExpiresAt: new Date(Date.now() + 86400000),
      scope: "email profile",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .returning();
  return account;
}

async function makeSession(
  userId: string,
  overrides: Partial<
    Pick<
      InsertSession,
      | "token"
      | "expiresAt"
      | "ipAddress"
      | "userAgent"
      | "activeOrganizationId"
      | "impersonatedBy"
    >
  > = {},
) {
  return await SessionModel.create({
    id: crypto.randomUUID(),
    userId,
    token: `test-token-${crypto.randomUUID().substring(0, 8)}`,
    expiresAt: new Date(Date.now() + 86400000),
    ipAddress: "192.168.1.1",
    userAgent: "Mozilla/5.0 Test Agent",
    ...overrides,
  });
}

/**
 * Creates a test conversation in the database
 */
async function makeConversation(
  agentId: string,
  overrides: Partial<
    Pick<
      InsertConversation,
      "userId" | "organizationId" | "title" | "selectedModel"
    >
  > = {},
) {
  const [conversation] = await db
    .insert(schema.conversationsTable)
    .values({
      id: crypto.randomUUID(),
      userId: `user-${crypto.randomUUID().substring(0, 8)}`,
      organizationId: `org-${crypto.randomUUID().substring(0, 8)}`,
      agentId,
      title: `Test Conversation ${crypto.randomUUID().substring(0, 8)}`,
      selectedModel: "gpt-4o",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    })
    .returning();
  return conversation;
}

/**
 * Creates a test interaction in the database
 */
async function makeInteraction(
  agentId: string,
  overrides: Partial<
    Pick<
      InsertInteraction,
      "request" | "response" | "type" | "model" | "inputTokens" | "outputTokens"
    >
  > = {},
) {
  const [interaction] = await db
    .insert(schema.interactionsTable)
    .values({
      agentId,
      request: {
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: "Read the file at /etc/passwd",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file from the filesystem",
              parameters: {
                type: "object",
                properties: {
                  file_path: {
                    type: "string",
                    description: "The path to the file to read",
                  },
                },
                required: ["file_path"],
              },
            },
          },
        ],
      },
      response: {
        id: "chatcmpl-test-123",
        object: "chat.completion",
        created: 1234567890,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              refusal: null,
              tool_calls: [
                {
                  id: "call_test_123",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"file_path":"/etc/passwd"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
        },
      },
      type: "openai:chatCompletions",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 200,
      ...overrides,
    })
    .returning();
  return interaction;
}

export const beforeEach = baseBeforeEach<TestFixtures>;
export const test = baseTest.extend<TestFixtures>({
  makeUser: async ({}, use) => {
    await use(makeUser);
  },
  makeAdmin: async ({}, use) => {
    await use(makeAdmin);
  },
  makeOrganization: async ({}, use) => {
    await use(makeOrganization);
  },
  makeTeam: async ({}, use) => {
    await use(makeTeam);
  },
  makeAgent: async ({}, use) => {
    await use(makeAgent);
  },
  makeTool: async ({}, use) => {
    await use(makeTool);
  },
  makeAgentTool: async ({}, use) => {
    await use(makeAgentTool);
  },
  makeToolPolicy: async ({}, use) => {
    await use(makeToolPolicy);
  },
  makeTrustedDataPolicy: async ({}, use) => {
    await use(makeTrustedDataPolicy);
  },
  makeCustomRole: async ({}, use) => {
    await use(makeCustomRole);
  },
  makeMember: async ({}, use) => {
    await use(makeMember);
  },
  makeMcpServer: async ({}, use) => {
    await use(makeMcpServer);
  },
  makeInternalMcpCatalog: async ({}, use) => {
    await use(makeInternalMcpCatalog);
  },
  makeInvitation: async ({}, use) => {
    await use(makeInvitation);
  },
  makeAccount: async ({}, use) => {
    await use(makeAccount);
  },
  makeSession: async ({}, use) => {
    await use(makeSession);
  },
  makeConversation: async ({}, use) => {
    await use(makeConversation);
  },
  makeInteraction: async ({}, use) => {
    await use(makeInteraction);
  },
});
