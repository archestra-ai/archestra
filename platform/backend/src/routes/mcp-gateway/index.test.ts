import {
  AGENT_TOOL_PREFIX,
  MCP_APPS_EXTENSION_ID,
  MCP_ENTERPRISE_AUTH_EXTENSION_ID,
  MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID,
  SKILL_TOOL_PREFIX,
  slugify,
  TOOL_CANCEL_TASK_FULL_NAME,
  TOOL_DELETE_FILE_FULL_NAME,
  TOOL_DOWNLOAD_FILE_FULL_NAME,
  TOOL_EDIT_FILE_FULL_NAME,
  TOOL_GET_TASK_FULL_NAME,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_LIST_SKILLS_FULL_NAME,
  TOOL_LIST_TASKS_FULL_NAME,
  TOOL_LOAD_SKILL_FULL_NAME,
  TOOL_READ_FILE_FULL_NAME,
  TOOL_RUN_COMMAND_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SAVE_FILE_FULL_NAME,
  TOOL_SEARCH_FILES_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_STEER_TASK_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_UPLOAD_FILE_FULL_NAME,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import {
  AgentExcludedSubagentModel,
  AgentModel,
  AppModel,
  McpServerModel,
  McpToolCallModel,
  SkillModel,
  TeamTokenModel,
  ToolModel,
  UserTokenModel,
} from "@/models";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mustExist,
  test,
} from "@/test";
import mcpGatewayRoutes from "./index";
import { MCP_SERVER_INFO_META_KEY } from "./protocol";

/**
 * Helper to create MCP gateway request headers
 * The MCP SDK requires Accept header with both application/json and text/event-stream
 */
function makeMcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

async function initializeMcpSession(params: {
  app: FastifyInstance;
  agentId: string;
  token: string;
}) {
  const response = await params.app.inject({
    method: "POST",
    url: `/v1/mcp/${params.agentId}`,
    headers: makeMcpHeaders(params.token),
    payload: {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
      id: 1,
    },
  });

  expect(response.statusCode).toBe(200);
}

async function callMcpTool(params: {
  app: FastifyInstance;
  agentId: string;
  token: string;
  name: string;
  arguments: Record<string, unknown>;
}) {
  return params.app.inject({
    method: "POST",
    url: `/v1/mcp/${params.agentId}`,
    headers: makeMcpHeaders(params.token),
    payload: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: params.name,
        arguments: params.arguments,
      },
      id: 2,
    },
  });
}

function getPolicyBlockedText(response: {
  statusCode: number;
  json(): {
    result: {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
  };
}): string {
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.result.isError).toBe(true);
  return body.result.content.map((item) => item.text ?? "").join("\n");
}

describe("MCP Gateway (stateless mode)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Create a test Fastify app
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("handles initialize request successfully (stateless)", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();

    // Create an org token for authentication
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    // Pin the skills flag rather than inherit it from the developer's .env:
    // this test asserts the flag-off extension set, and the flag-on
    // declaration is protocol.test.ts's business.
    const original = config.mcpGateway.skillsEnabled;
    let initResponse: Awaited<ReturnType<typeof app.inject>>;
    try {
      config.mcpGateway.skillsEnabled = false;
      // Send initialize request
      initResponse = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
          id: 1,
        },
      });
    } finally {
      config.mcpGateway.skillsEnabled = original;
    }

    expect(initResponse.statusCode).toBe(200);

    // In stateless mode, no session ID should be returned
    // (or if returned, it's ephemeral and not stored)
    const result = initResponse.json();
    expect(result).toHaveProperty("result");
    expect(result.result.capabilities.extensions).toEqual({
      [MCP_APPS_EXTENSION_ID]: {},
      [MCP_ENTERPRISE_AUTH_EXTENSION_ID]: {},
      [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID]: {},
    });
  });

  test("records the background execution id on gateway audit rows", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    const token = await TeamTokenModel.create({
      organizationId: organization.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    const executionId = crypto.randomUUID();

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        ...makeMcpHeaders(token.value),
        "x-archestra-execution-id": executionId,
      },
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "background-agent", version: "1.0.0" },
        },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const rows = await McpToolCallModel.findAllPaginated(
      { limit: 10, offset: 0 },
      undefined,
      undefined,
      undefined,
      { search: executionId },
    );
    expect(rows.data).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        method: "initialize",
        executionId,
      }),
    ]);
  });

  test("reserves the skill://archestra namespace while the skills surface is off", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // The skills surface is off here (the deployment flag is off), which is
    // exactly the window where falling through would let an upstream server
    // answer for the platform's own prefix. A parseable skill URI must come
    // back not-found — never be proxied upstream.
    const agent = await makeAgent();
    const org = await makeOrganization();
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    // A well-formed URI, an unknown scope, and malformed percent-encoding all
    // stay inside the reserved authority.
    for (const uri of [
      "skill://archestra/shared/refunds/SKILL.md",
      "skill://archestra/unknown-scope/evil.md",
      "skill://archestra/shared/%zz/SKILL.md",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: {
          jsonrpc: "2.0",
          method: "resources/read",
          params: { uri },
          id: 2,
        },
      });

      expect(response.statusCode, uri).toBe(200);
      const body = response.json();
      // SEP-2164 retired the MCP-specific -32002 for missing resources; the
      // current revision (and SEP-2640 for skill URIs) answers -32602.
      expect(body.error.code, uri).toBe(-32602);
      expect(body.error.message, uri).toContain("Resource not found");
    }
  });

  test("dispatches skills/list only while the skills surface is enabled", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // Everything else about the skills surface is tested by calling its
    // handlers directly. This is the one test that proves the handlers are
    // REACHABLE: an inverted guard, a wrong config key, or a dropped
    // `isSkillMethod` check would ship the whole feature dead — the method
    // falling through to the SDK, which answers -32601 — with the rest of the
    // suite still green.
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const listSkills = async () =>
      await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: { jsonrpc: "2.0", method: "skills/list", params: {}, id: 3 },
      });

    const original = config.mcpGateway.skillsEnabled;
    try {
      config.mcpGateway.skillsEnabled = false;
      const off = (await listSkills()).json();
      expect(off.error.code).toBe(-32601);

      config.mcpGateway.skillsEnabled = true;
      const on = (await listSkills()).json();
      expect(on.error).toBeUndefined();
      expect(on.result.skills).toEqual([]);
      // The current revision's result envelope. The skill methods are
      // dispatched ahead of the SDK, so nothing downstream stamps this for
      // them — dropping the wrap here would ship results without the
      // mandatory `resultType`.
      expect(on.result.resultType).toBe("complete");
      expect(on.result._meta[MCP_SERVER_INFO_META_KEY]).toMatchObject({
        name: `archestra-agent-${agent.id}`,
      });
    } finally {
      config.mcpGateway.skillsEnabled = original;
    }
  });

  test("a skills notification gets 202 and no JSON-RPC response", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // A notification — same method, no id — must never be answered. The skill
    // dispatch refuses bodies without an id, so the spelling falls through to
    // the SDK transport, whose notification path acknowledges with 202 and an
    // empty body — never a JSON-RPC response with `id: null`.
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const original = config.mcpGateway.skillsEnabled;
    try {
      config.mcpGateway.skillsEnabled = true;
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: { jsonrpc: "2.0", method: "skills/list", params: {} },
      });
      expect(response.statusCode).toBe(202);
      expect(response.body).toBe("");
    } finally {
      config.mcpGateway.skillsEnabled = original;
    }
  });

  test("serves a skill:// read only while the skills surface is enabled", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // The read half of the reachability check above. `resources/read` is an
    // ordinary SDK request whose handler branches on the flag, so an inverted
    // guard there ships every skill read as not-found while listings work —
    // and no other test reaches that branch with the flag on.
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      accessAllSkills: true,
    });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        name: "reachable-skill",
        description: "Served over the gateway",
        content: "# Instructions",
        scope: "org",
      },
      files: [],
    });

    const readManifest = async () =>
      await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: {
          jsonrpc: "2.0",
          method: "resources/read",
          params: {
            uri: "skill://archestra/shared/reachable-skill/SKILL.md",
          },
          id: 4,
        },
      });

    const original = config.mcpGateway.skillsEnabled;
    try {
      config.mcpGateway.skillsEnabled = false;
      expect((await readManifest()).json().error.code).toBe(-32602);

      config.mcpGateway.skillsEnabled = true;
      const on = (await readManifest()).json();
      expect(on.error).toBeUndefined();
      expect(on.result.contents[0]).toMatchObject({
        uri: "skill://archestra/shared/reachable-skill/SKILL.md",
        mimeType: "text/markdown",
      });
      expect(on.result.contents[0].text).toContain("name: reachable-skill");
    } finally {
      config.mcpGateway.skillsEnabled = original;
    }
  });

  test("handles tools/list request successfully (stateless)", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    // Send tools/list request directly without prior initialize
    // In stateless mode, each request creates a fresh server
    const toolsResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1,
      },
    });

    // The MCP SDK may require initialize first, which would return an error
    // But the gateway itself should handle the request without session errors
    expect([200, 400]).toContain(toolsResponse.statusCode);

    if (toolsResponse.statusCode === 400) {
      const body = toolsResponse.json();
      // If error, it should be "Server not initialized", not a session error
      expect(body.error?.message).toContain("Server not initialized");
    }
  });

  test("Auto subagent mode: tools/list advertises caller-accessible delegation tools without explicit assignment, honoring exclusions", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const caller = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Gateway Auto Caller",
    });
    await AgentModel.update(caller.id, { accessAllSubagents: true });

    const target = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
      name: "Gateway Auto Target",
    });
    const excluded = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
      name: "Gateway Auto Excluded",
    });
    await AgentExcludedSubagentModel.replaceForAgent(caller.id, [excluded.id]);

    // A user token so the gateway resolves a real caller; Auto expansion is
    // gated on an authenticated user.
    const token = await UserTokenModel.create(user.id, org.id);

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${caller.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 },
    });

    expect(response.statusCode).toBe(200);
    const toolNames = response
      .json()
      .result.tools.map((tool: { name: string }) => tool.name);

    // No agent_tools rows exist for the caller: the delegation surface must
    // come from the Auto resolver, not the assigned-tools query.
    expect(toolNames).toContain(`${AGENT_TOOL_PREFIX}${slugify(target.name)}`);
    expect(toolNames).not.toContain(
      `${AGENT_TOOL_PREFIX}${slugify(excluded.name)}`,
    );
    // The agent never delegates to itself.
    expect(toolNames).not.toContain(
      `${AGENT_TOOL_PREFIX}${slugify(caller.name)}`,
    );
  });

  test("skill delegation: tools/list advertises skill__ tools and tools/call routes them to the skill-delegation dispatch", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const caller = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Gateway Skill Caller",
    });
    const target = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
      name: "Gateway Skill Target",
    });

    await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        name: "gateway-delegated-skill",
        description: "Runs in a subagent.",
        content: "Do the thing.",
        agentName: target.name,
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    // A skill designating a nonexistent agent: never advertised, and its
    // dispatch fails inside the skill-delegation resolver.
    await SkillModel.createWithFiles({
      skill: {
        organizationId: org.id,
        name: "gateway-orphan-skill",
        description: "Designates a missing agent.",
        content: "Do the thing.",
        agentName: "Ghost Bot",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });

    const token = await UserTokenModel.create(user.id, org.id);

    const listResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${caller.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 1 },
    });
    expect(listResponse.statusCode).toBe(200);
    const toolNames = listResponse
      .json()
      .result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain(`${SKILL_TOOL_PREFIX}gateway_delegated_skill`);
    expect(toolNames).not.toContain(`${SKILL_TOOL_PREFIX}gateway_orphan_skill`);

    // tools/call on a skill__ name must route into the skill-delegation
    // dispatch (executeArchestraTool), not the third-party tool gate — the
    // orphan skill's resolver error proves the routing without running an
    // actual subagent. The old bug surfaced here as a "not enabled for this
    // conversation" refusal from the invocation-policy enabled-tools filter.
    const callResponse = await callMcpTool({
      app,
      agentId: caller.id,
      token: token.value,
      name: `${SKILL_TOOL_PREFIX}gateway_orphan_skill`,
      arguments: { message: "run it" },
    });
    expect(callResponse.statusCode).toBe(200);
    const result = callResponse.json().result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'designates the agent "Ghost Bot"',
    );
    expect(result.content[0].text).not.toContain("not enabled");
  });

  test("derives a human 'Open <app>' title for an app launch tool, leaving its slug name and other tools' titles untouched", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "full",
      accessAllTools: false,
    });

    // An app backing (serverType "app") whose catalog name is the human app name.
    const appCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Bug Tracker",
      serverType: "app",
      scope: "org",
    });
    // The launch tool keeps its unique, id-suffixed slug name and stores no title.
    const launchTool = await makeTool({
      catalogId: appCatalog.id,
      name: "bug_tracker-1a2b3c4d__open",
      description: 'Open the "Bug Tracker" app and render its UI.',
      meta: { _meta: { ui: { resourceUri: "ui://archestra/app/1a2b3c4d" } } },
    });
    await makeAgentTool(agent.id, launchTool.id, {
      credentialResolutionMode: "dynamic",
    });

    // A regular (non-app) tool to prove the derivation is app-only.
    const remoteCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Linear",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    });
    const remoteTool = await makeTool({
      catalogId: remoteCatalog.id,
      name: "linear_search_issues",
    });
    await makeAgentTool(agent.id, remoteTool.id, {
      credentialResolutionMode: "dynamic",
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    await initializeMcpSession({ app, agentId: agent.id, token: token.value });
    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 },
    });

    expect(response.statusCode).toBe(200);
    const tools: Array<{ name: string; title?: string }> =
      response.json().result.tools;

    const launch = tools.find((t) => t.name === "bug_tracker-1a2b3c4d__open");
    expect(launch).toBeDefined();
    // Slug name is preserved for invocation; only the display title is friendly.
    expect(launch?.title).toBe("Open Bug Tracker");

    const remote = tools.find((t) => t.name === "linear_search_issues");
    expect(remote).toBeDefined();
    // A non-app tool's title still falls back to its name — derivation is app-only.
    expect(remote?.title).toBe("linear_search_issues");
  });

  test("Auto-tool mode exclusions: tools/list drops excluded assigned tools and their catalog from the search_tools description", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    // accessAllTools forces search_and_run_only, so tools/list advertises the
    // meta tools; the search_tools description names the assigned catalogs.
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      accessAllTools: true,
    });

    const keptCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Kept Server",
    });
    const keptTool = await makeTool({
      catalogId: keptCatalog.id,
      name: "kept__do_thing",
    });
    await makeAgentTool(agent.id, keptTool.id);

    const excludedCatalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "Excluded Server",
    });
    const excludedTool = await makeTool({
      catalogId: excludedCatalog.id,
      name: "excluded__do_thing",
    });
    await makeAgentTool(agent.id, excludedTool.id);

    const { agentToolExclusionsService } = await import(
      "@/services/agent-tool-exclusions"
    );
    await agentToolExclusionsService.replaceExclusions({
      agentId: agent.id,
      organizationId: org.id,
      excludedToolIds: [excludedTool.id],
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    await initializeMcpSession({ app, agentId: agent.id, token: token.value });
    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 },
    });

    expect(response.statusCode).toBe(200);
    const tools: Array<{ name: string; description?: string }> =
      response.json().result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
    expect(names).not.toContain("excluded__do_thing");

    const searchTool = tools.find(
      (t) => t.name === TOOL_SEARCH_TOOLS_FULL_NAME,
    );
    expect(searchTool?.description).toContain("Kept Server");
    expect(searchTool?.description).not.toContain("Excluded Server");
  });

  test("Auto-tool mode exclusions: an excluded always-exposed built-in (load_skill) is dropped from tools/list", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    // accessAllTools forces search_and_run_only, where always-exposed
    // built-ins like load_skill normally stay top-level in tools/list.
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      accessAllTools: true,
    });
    await seedAndAssignArchestraTools(agent.id);

    const loadSkill = await ToolModel.findByName(TOOL_LOAD_SKILL_FULL_NAME);
    if (!loadSkill) {
      throw new Error("Expected seeded load_skill tool");
    }

    const { agentToolExclusionsService } = await import(
      "@/services/agent-tool-exclusions"
    );
    await agentToolExclusionsService.replaceExclusions({
      agentId: agent.id,
      organizationId: org.id,
      excludedToolIds: [loadSkill.id],
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    await initializeMcpSession({ app, agentId: agent.id, token: token.value });
    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 },
    });

    expect(response.statusCode).toBe(200);
    const names = response
      .json()
      .result.tools.map((tool: { name: string }) => tool.name);
    // The exclusion takes effect: the excluded always-exposed tool is gone,
    // while its non-excluded sibling and the meta tools stay advertised.
    expect(names).not.toContain(TOOL_LOAD_SKILL_FULL_NAME);
    expect(names).toContain(TOOL_LIST_SKILLS_FULL_NAME);
    expect(names).toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
    expect(names).toContain(TOOL_RUN_TOOL_FULL_NAME);
  });

  test("Auto-tool mode: a disabled app's launch tool is undiscoverable until enabled, even for its own author", async ({
    makeAgent,
    makeApp,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    await makeMember(author.id, org.id, { role: "admin" });
    // Org-scoped so it is otherwise dynamically discoverable regardless of any
    // explicit assignment — isolating the disabled-exclusion behavior itself.
    const disabledApp = await makeApp({
      organizationId: org.id,
      authorId: author.id,
      scope: "org",
      enabled: false,
    });
    const server = mustExist(
      await McpServerModel.findById(mustExist(disabledApp.mcpServerId)),
    );
    const [launchTool] = await ToolModel.findByCatalogIdWithMeta(
      server.catalogId,
    );
    const launchToolName = launchTool.name;

    // "Agent auto mode": the gateway agent has accessAllTools on, so the tool
    // is reached by dynamic discovery rather than explicit assignment. Auto mode
    // deliberately advertises only search_tools/run_tool, so the disabled-app
    // rule is observed where dynamic discovery actually happens — search_tools —
    // over the real /v1/mcp route.
    const gatewayAgent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      accessAllTools: true,
    });
    const token = await UserTokenModel.create(author.id, org.id);

    async function searchToolNames(): Promise<string[]> {
      await initializeMcpSession({
        app,
        agentId: gatewayAgent.id,
        token: token.value,
      });
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${gatewayAgent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: TOOL_SEARCH_TOOLS_FULL_NAME,
            arguments: { query: launchToolName, limit: 20 },
          },
          id: 2,
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.result.isError).toBeFalsy();
      return (body.result.structuredContent?.tools ?? []).map(
        (tool: { toolName: string }) => tool.toolName,
      );
    }

    // Undiscoverable while disabled — even for the app's own author.
    expect(await searchToolNames()).not.toContain(launchToolName);

    // Enabling surfaces it, over the same real route, for the same caller.
    await AppModel.setEnabled(disabledApp.id, true);
    expect(await searchToolNames()).toContain(launchToolName);
  });

  test("Auto-tool mode: tools/list advertises only the search/run pair even when an app is dynamically reachable", async ({
    makeAgent,
    makeApp,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    await makeMember(author.id, org.id, { role: "admin" });
    // An enabled, org-scoped app: dynamically reachable by the caller, and its
    // launch tool carries a ui:// resource — the class that used to be
    // advertised top-level and blew the listing up on installs with many apps.
    await makeApp({
      organizationId: org.id,
      authorId: author.id,
      scope: "org",
      enabled: true,
    });
    const gatewayAgent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      accessAllTools: true,
    });
    const token = await UserTokenModel.create(author.id, org.id);

    await initializeMcpSession({
      app,
      agentId: gatewayAgent.id,
      token: token.value,
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${gatewayAgent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 },
    });

    expect(response.statusCode).toBe(200);
    const names = response
      .json()
      .result.tools.map((tool: { name: string }) => tool.name)
      .sort();
    expect(names).toEqual(
      [TOOL_RUN_TOOL_FULL_NAME, TOOL_SEARCH_TOOLS_FULL_NAME].sort(),
    );
  });

  test("returns 401 with WWW-Authenticate header for missing authorization header", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // No authorization header
      },
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(401);

    // Verify WWW-Authenticate header is present with resource_metadata URL
    const wwwAuth = response.headers["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain(
      `/.well-known/oauth-protected-resource/v1/mcp/${agent.id}`,
    );
  });

  test("ignores forwarded public origin in WWW-Authenticate when proxy trust is disabled", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.slug}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "localhost:9000",
        "x-forwarded-host": "gateway.example.com",
        "x-forwarded-proto": "https",
      },
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain(
      `resource_metadata="http://localhost:9000/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}"`,
    );
  });

  test("uses forwarded public origin in WWW-Authenticate when proxy trust is enabled", async ({
    makeAgent,
  }) => {
    const originalAllowlist = process.env.ARCHESTRA_API_BASE_URL;
    process.env.ARCHESTRA_API_BASE_URL = "https://gateway.example.com";
    const proxyApp = Fastify({
      trustProxy: true,
    }).withTypeProvider<ZodTypeProvider>();
    proxyApp.setValidatorCompiler(validatorCompiler);
    proxyApp.setSerializerCompiler(serializerCompiler);
    await proxyApp.register(mcpGatewayRoutes);

    try {
      const agent = await makeAgent();

      const response = await proxyApp.inject({
        method: "POST",
        url: `/v1/mcp/${agent.slug}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost:9000",
          "x-forwarded-host": "gateway.example.com",
          "x-forwarded-proto": "https",
        },
        payload: {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
          id: 1,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain(
        `resource_metadata="https://gateway.example.com/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}"`,
      );
    } finally {
      await proxyApp.close();
      if (originalAllowlist === undefined) {
        delete process.env.ARCHESTRA_API_BASE_URL;
      } else {
        process.env.ARCHESTRA_API_BASE_URL = originalAllowlist;
      }
    }
  });

  test("uses forwarded public origin when CIDR proxy trust matches the remote address", async ({
    makeAgent,
  }) => {
    const originalAllowlist = process.env.ARCHESTRA_API_BASE_URL;
    process.env.ARCHESTRA_API_BASE_URL = "https://gateway.example.com";
    const proxyApp = Fastify({
      trustProxy: "127.0.0.1/32",
    }).withTypeProvider<ZodTypeProvider>();
    proxyApp.setValidatorCompiler(validatorCompiler);
    proxyApp.setSerializerCompiler(serializerCompiler);
    await proxyApp.register(mcpGatewayRoutes);

    try {
      const agent = await makeAgent();

      const response = await proxyApp.inject({
        method: "POST",
        url: `/v1/mcp/${agent.slug}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost:9000",
          "x-forwarded-host": "gateway.example.com",
          "x-forwarded-proto": "https",
        },
        payload: {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
          id: 1,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain(
        `resource_metadata="https://gateway.example.com/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}"`,
      );
    } finally {
      await proxyApp.close();
      if (originalAllowlist === undefined) {
        delete process.env.ARCHESTRA_API_BASE_URL;
      } else {
        process.env.ARCHESTRA_API_BASE_URL = originalAllowlist;
      }
    }
  });

  test("ignores forwarded public origin when CIDR proxy trust does not match the remote address", async ({
    makeAgent,
  }) => {
    const proxyApp = Fastify({
      trustProxy: "10.0.0.0/8",
    }).withTypeProvider<ZodTypeProvider>();
    proxyApp.setValidatorCompiler(validatorCompiler);
    proxyApp.setSerializerCompiler(serializerCompiler);
    await proxyApp.register(mcpGatewayRoutes);

    try {
      const agent = await makeAgent();

      const response = await proxyApp.inject({
        method: "POST",
        url: `/v1/mcp/${agent.slug}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost:9000",
          "x-forwarded-host": "gateway.example.com",
          "x-forwarded-proto": "https",
        },
        payload: {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
          id: 1,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain(
        `resource_metadata="http://localhost:9000/.well-known/oauth-protected-resource/v1/mcp/${agent.slug}"`,
      );
    } finally {
      await proxyApp.close();
    }
  });

  test("returns 401 with WWW-Authenticate header for invalid token", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders("archestra_invalid_token_12345"),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(401);

    // Verify WWW-Authenticate header is present
    const wwwAuth = response.headers["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
  });

  test("GET endpoint returns 401 with WWW-Authenticate header for missing authorization", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        accept: "application/json",
        // No authorization header
      },
    });

    expect(response.statusCode).toBe(401);

    const wwwAuth = response.headers["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
  });

  test("GET endpoint returns server discovery info", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent();
    const org = await makeOrganization();

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("name", `archestra-agent-${agent.id}`);
    expect(body).toHaveProperty("transport", "http");
    expect(body).toHaveProperty("capabilities");
    expect(body.capabilities).toHaveProperty("tools", true);
  });

  test("GET endpoint serves discovery info without tokenAuth for an invalid token", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders("archestra_invalid_token_12345"),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("name", `archestra-agent-${agent.id}`);
    expect(body).toHaveProperty("agentId", agent.id);
    expect(body).toHaveProperty("transport", "http");
    expect(body.capabilities).toHaveProperty("tools", true);
    expect(body.tokenAuth).toBeUndefined();
  });

  test("handles whoami tool call successfully after initialize", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(agent.id);

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });
    expect(initResponse.statusCode).toBe(200);

    const callResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "archestra__whoami",
          arguments: {},
        },
        id: 2,
      },
    });

    expect(callResponse.statusCode).toBe(200);
    expect(callResponse.json().result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(agent.id),
        }),
      ]),
    );
  });

  test("direct tools/call applies target input-based invocation policies", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `policy_target_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "Blocked recipient",
      conditions: [{ key: "recipient", operator: "equal", value: "external" }],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: tool.name,
      arguments: { recipient: "external" },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("Blocked recipient");
  });

  test("run_tool applies target input-based invocation policies", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `run_policy_target_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "Blocked transfer",
      conditions: [{ key: "action", operator: "equal", value: "wire" }],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: {
        tool_name: tool.name,
        tool_args: { action: "wire" },
      },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("Blocked transfer");
  });

  test("direct tools/call blocks target tools that require approval", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `approval_direct_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: tool.name,
      arguments: {},
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  });

  test("run_tool blocks target tools that require approval", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
    makeToolPolicy,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `approval_run_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "require_approval",
      conditions: [],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: {
        tool_name: tool.name,
        tool_args: {},
      },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  });

  test("direct tools/call applies untrusted-context invocation policies", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `untrusted_direct_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      considerContextUntrusted: true,
    });
    await makeAgentTool(agent.id, tool.id);

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: tool.name,
      arguments: {},
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("untrusted");
  });

  test("run_tool applies untrusted-context invocation policies to the target tool", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `untrusted_run_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
      considerContextUntrusted: true,
    });
    await makeAgentTool(agent.id, tool.id);

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: {
        tool_name: tool.name,
        tool_args: {},
      },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("untrusted");
  });

  test("run_tool applies target context-condition invocation policies", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeTool,
    makeToolPolicy,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: `team_policy_target_${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [team.id],
      toolExposureMode: "search_and_run_only",
    });
    await makeAgentTool(agent.id, tool.id);
    await makeToolPolicy(tool.id, {
      action: "block_always",
      reason: "Blocked for this team",
      conditions: [
        { key: "context.teamIds", operator: "contains", value: team.id },
      ],
    });

    const { value: token } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await initializeMcpSession({ app, agentId: agent.id, token });

    const response = await callMcpTool({
      app,
      agentId: agent.id,
      token,
      name: TOOL_RUN_TOOL_FULL_NAME,
      arguments: {
        tool_name: tool.name,
        tool_args: {},
      },
    });
    const text = getPolicyBlockedText(response);
    expect(text).toContain(tool.name);
    expect(text).toContain("Blocked for this team");
  });

  test("keeps only meta and always-exposed tools in tools/list when toolExposureMode is search_and_run_only", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });
    await seedAndAssignArchestraTools(agent.id);

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });
    expect(initResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    const toolNames = response
      .json()
      .result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames.sort()).toEqual(
      [
        TOOL_LIST_SKILLS_FULL_NAME,
        TOOL_LOAD_SKILL_FULL_NAME,
        TOOL_RUN_TOOL_FULL_NAME,
        TOOL_SEARCH_TOOLS_FULL_NAME,
      ].sort(),
    );
    expect(toolNames).not.toContain(TOOL_TODO_WRITE_FULL_NAME);
  });

  test("keeps sandbox runtime tools top-level in tools/list when the sandbox runtime is enabled", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const config = (await import("@/config")).default;
    const originalSandboxEnabled = config.skillsSandbox.enabled;
    (config.skillsSandbox as { enabled: boolean }).enabled = true;

    try {
      const org = await makeOrganization();
      // sandbox tools are gated by sandbox:execute — authenticate as an admin so
      // RBAC does not strip them before exposure filtering runs.
      const adminUser = await makeUser();
      await makeMember(adminUser.id, org.id, { role: "admin" });
      const agent = await makeAgent({
        organizationId: org.id,
        agentType: "mcp_gateway",
        toolExposureMode: "search_and_run_only",
      });
      await seedAndAssignArchestraTools(agent.id);

      const token = await UserTokenModel.create(adminUser.id, org.id);

      const initResponse = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: {
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
          id: 1,
        },
      });
      expect(initResponse.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: makeMcpHeaders(token.value),
        payload: {
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
          id: 2,
        },
      });

      expect(response.statusCode).toBe(200);
      const toolNames = response
        .json()
        .result.tools.map((tool: { name: string }) => tool.name);
      // App tools are deliberately absent: in search_and_run_only mode the
      // whole app surface is reached through search_tools/run_tool. Task
      // lifecycle controls stay top-level because delegated work is durable.
      expect(toolNames.sort()).toEqual(
        [
          TOOL_CANCEL_TASK_FULL_NAME,
          TOOL_DELETE_FILE_FULL_NAME,
          TOOL_DOWNLOAD_FILE_FULL_NAME,
          TOOL_EDIT_FILE_FULL_NAME,
          TOOL_GET_TASK_FULL_NAME,
          TOOL_LIST_SKILLS_FULL_NAME,
          TOOL_LIST_TASKS_FULL_NAME,
          TOOL_LOAD_SKILL_FULL_NAME,
          TOOL_READ_FILE_FULL_NAME,
          TOOL_RUN_COMMAND_FULL_NAME,
          TOOL_RUN_TOOL_FULL_NAME,
          TOOL_SAVE_FILE_FULL_NAME,
          TOOL_SEARCH_FILES_FULL_NAME,
          TOOL_SEARCH_TOOLS_FULL_NAME,
          TOOL_STEER_TASK_FULL_NAME,
          TOOL_UPLOAD_FILE_FULL_NAME,
        ].sort(),
      );
    } finally {
      (config.skillsSandbox as { enabled: boolean }).enabled =
        originalSandboxEnabled;
    }
  });

  test("exposes implicit search_tools and run_tool without manual assignment when toolExposureMode is search_and_run_only", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });
    expect(initResponse.statusCode).toBe(200);

    const listResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 2,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(
      listResponse
        .json()
        .result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(
      expect.arrayContaining([
        TOOL_SEARCH_TOOLS_FULL_NAME,
        TOOL_RUN_TOOL_FULL_NAME,
      ]),
    );
  });

  test("GET endpoint resolves agent by slug", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Slug Test Gateway",
      organizationId: org.id,
      agentType: "mcp_gateway",
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${agent.slug}`,
      headers: makeMcpHeaders(token.value),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("name", `archestra-agent-${agent.id}`);
    expect(body).toHaveProperty("agentId", agent.id);
  });

  test("POST endpoint resolves agent by slug", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Slug POST Test",
      organizationId: org.id,
      agentType: "mcp_gateway",
    });

    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.slug}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });

    expect(initResponse.statusCode).toBe(200);
  });

  test("returns 401 for non-existent slug", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/mcp/non-existent-slug",
      headers: makeMcpHeaders("archestra_some_token"),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
