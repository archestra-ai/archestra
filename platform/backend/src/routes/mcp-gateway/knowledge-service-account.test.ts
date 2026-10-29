import {
  ARCHESTRA_MCP_CATALOG_ID,
  OAUTH_TOKEN_ID_PREFIX,
  type ResourcePermissionGrant,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type {
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { queryService } from "@/knowledge-base";
import {
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  ToolModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { createAgentServer } from "./utils";

/**
 * An OAuth client that signs in as itself with a service account acts as that
 * account: tools/call searches the knowledge sources shared with it. tools/list
 * must offer the same search, or an MCP client never learns it exists.
 */
describe("knowledge search for a service-account OAuth client", () => {
  for (const toolExposureMode of ["full", "search_and_run_only"] as const) {
    test(`lists and searches only the sources shared with the account (${toolExposureMode})`, async ({
      makeAgent,
      makeAgentTool,
      makeOrganization,
      makeServiceAccount,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const account = await makeServiceAccount(org.id);
      const otherUser = await makeUser();
      const shared = await makeSource({
        organizationId: org.id,
        name: "Support Runbooks",
        grants: [grantTo({ type: "serviceAccount", id: account.id })],
      });
      const unshared = await makeSource({
        organizationId: org.id,
        name: "Finance Ledger",
        grants: [grantTo({ type: "user", id: otherUser.id })],
      });
      const agent = await makeAgent({
        organizationId: org.id,
        agentType: "mcp_gateway",
        knowledgeBaseIds: [shared.knowledgeBaseId, unshared.knowledgeBaseId],
        accessAllTools: false,
        toolExposureMode,
      });
      await assignKnowledgeTool({ agentId: agent.id, makeAgentTool });

      const gateway = await connectAsServiceAccountClient({
        agentId: agent.id,
        organizationId: org.id,
        serviceAccountId: account.id,
      });

      const listed = await gateway.listTools();
      const advertised =
        toolExposureMode === "full"
          ? listed.tools.find((tool) => tool.name === KNOWLEDGE_TOOL)
          : listed.tools.find((tool) => tool.name === SEARCH_TOOL);
      expect(advertised?.description).toContain(
        toolExposureMode === "full"
          ? "Support Runbooks"
          : "Internal knowledge search is available.",
      );
      expect(advertised?.description).not.toContain("Finance Ledger");

      const { result, connectorIds } = await gateway.queryKnowledge();
      expect(result.isError).toBeFalsy();
      expect(connectorIds).toEqual([shared.connectorId]);
    });
  }

  test("an account with no shared source is offered no knowledge search", async ({
    makeAgent,
    makeAgentTool,
    makeOrganization,
    makeServiceAccount,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const account = await makeServiceAccount(org.id);
    const otherUser = await makeUser();
    const unshared = await makeSource({
      organizationId: org.id,
      name: "Finance Ledger",
      grants: [grantTo({ type: "user", id: otherUser.id })],
    });
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      knowledgeBaseIds: [unshared.knowledgeBaseId],
      accessAllTools: false,
      toolExposureMode: "full",
    });
    await assignKnowledgeTool({ agentId: agent.id, makeAgentTool });

    const gateway = await connectAsServiceAccountClient({
      agentId: agent.id,
      organizationId: org.id,
      serviceAccountId: account.id,
    });

    const listed = await gateway.listTools();
    expect(listed.tools.map((tool) => tool.name)).not.toContain(KNOWLEDGE_TOOL);
    const { result, connectorIds } = await gateway.queryKnowledge();
    expect(result.isError).toBe(true);
    expect(connectorIds).toBeUndefined();
  });
});

// === Internal helpers ===

const KNOWLEDGE_TOOL = archestraMcpBranding.getToolName(
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
);
const SEARCH_TOOL = archestraMcpBranding.getToolName(
  TOOL_SEARCH_TOOLS_SHORT_NAME,
);

function grantTo(
  subject: ResourcePermissionGrant["subject"],
): ResourcePermissionGrant {
  return { subject, actions: ["read", "use"] };
}

/** A knowledge base and its one connector, both shared with `grants`. */
async function makeSource(params: {
  organizationId: string;
  name: string;
  grants: ResourcePermissionGrant[];
}) {
  const options = { initialPermissionGrants: params.grants };
  const knowledgeBase = await KnowledgeBaseModel.create(
    { organizationId: params.organizationId, name: `${params.name} Base` },
    options,
  );
  const connector = await KnowledgeBaseConnectorModel.create(
    {
      organizationId: params.organizationId,
      name: params.name,
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: "https://example.atlassian.net",
        isCloud: true,
        projectKey: "DEMO",
      },
    },
    options,
  );
  await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
    connector.id,
    knowledgeBase.id,
  );
  return { knowledgeBaseId: knowledgeBase.id, connectorId: connector.id };
}

async function assignKnowledgeTool(params: {
  agentId: string;
  makeAgentTool: (agentId: string, toolId: string) => Promise<unknown>;
}) {
  await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
  const tool = await ToolModel.findByName(KNOWLEDGE_TOOL);
  if (!tool) throw new Error("Missing knowledge tool");
  await params.makeAgentTool(params.agentId, tool.id);
}

/**
 * The gateway as an OAuth client-credentials token bound to a service account
 * reaches it: no user id, only the account (see validateMcpClientAccessToken).
 */
async function connectAsServiceAccountClient(params: {
  agentId: string;
  organizationId: string;
  serviceAccountId: string;
}) {
  const { server } = await createAgentServer({
    agentId: params.agentId,
    tokenAuth: {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
      teamId: null,
      isOrganizationToken: false,
      organizationId: params.organizationId,
      oauthClientId: "service-client",
      serviceAccountId: params.serviceAccountId,
    },
  });
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const call = (method: string, requestParams: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`Missing ${method} handler`);
    return handler({ method, params: requestParams });
  };
  return {
    listTools: async () => (await call("tools/list", {})) as ListToolsResult,
    /** Calls the knowledge tool; the embedding search itself is stubbed. */
    queryKnowledge: async () => {
      const query = vi.spyOn(queryService, "query").mockResolvedValue([]);
      try {
        const result = (await call("tools/call", {
          name: KNOWLEDGE_TOOL,
          arguments: { query: "How do we escalate a ticket?" },
        })) as CallToolResult;
        return { result, connectorIds: query.mock.calls[0]?.[0].connectorIds };
      } finally {
        query.mockRestore();
      }
    },
  };
}
