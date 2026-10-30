// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type ArchestraToolShortName,
  OAUTH_TOKEN_ID_PREFIX,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type {
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  archestraMcpBranding,
  executeArchestraTool,
} from "@/archestra-mcp-server";
import {
  AgentConnectorAssignmentModel,
  EnvironmentModel,
  KbChunkModel,
} from "@/models";
import { buildKnowledgeSourcesDescription } from "@/services/knowledge-sources-description";
import { describe, expect, test } from "@/test";
import {
  configureKnowledgeSearch,
  indexKnowledgeDocument,
  indexKnowledgeFile,
  knowledgeEmbeddingHandler,
  publishKnowledgeSource,
} from "@/test/knowledge-search";
import { useMswServer } from "@/test/msw";
import { createAgentServer, type TokenAuthResult } from "./utils";

const KNOWLEDGE_TOOL = archestraMcpBranding.getToolName(
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
);

describe("knowledge search without an acting user", () => {
  useMswServer(knowledgeEmbeddingHandler);

  for (const toolExposureMode of ["full", "search_and_run_only"] as const) {
    test(`discovers and searches only published sources and public chunks (${toolExposureMode})`, async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeAgent,
      seedAndAssignArchestraTools,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const owner = await makeUser();
      await makeMember(owner.id, org.id, { role: "member" });
      const published = await makeKnowledgeBase(org.id, {
        name: "Published base",
        access: "org",
      });
      const privateBase = await makeKnowledgeBase(org.id, {
        name: "Private base",
        access: "personal",
      });
      const publicConnector = await makeKnowledgeBaseConnector(
        published.id,
        org.id,
        {
          name: "Published handbook",
          access: "org",
          syncPermissionsFromSource: true,
        },
      );
      const privateConnector = await makeKnowledgeBaseConnector(
        published.id,
        org.id,
        {
          name: "Private connector",
          access: { users: [owner.id], preset: "use" },
          syncPermissionsFromSource: true,
        },
      );
      const hiddenBaseConnector = await makeKnowledgeBaseConnector(
        privateBase.id,
        org.id,
        {
          name: "Hidden base source",
          access: "org",
          syncPermissionsFromSource: true,
        },
      );
      for (const [resource, scope] of [
        ["knowledgeBase", published.id],
        ["knowledgeConnector", publicConnector.id],
        ["knowledgeConnector", hiddenBaseConnector.id],
      ] as const)
        await publishKnowledgeSource({
          organizationId: org.id,
          resource,
          scope,
        });
      const environment = await EnvironmentModel.create({
        organizationId: org.id,
        name: "Other environment",
      });
      const outsideEnvironment = await makeKnowledgeBaseConnector(
        published.id,
        org.id,
        {
          name: "Other environment source",
          environmentId: environment.id,
          syncPermissionsFromSource: true,
        },
      );
      const foreignOrg = await makeOrganization();
      const foreignBase = await makeKnowledgeBase(foreignOrg.id);
      const outsideOrganization = await makeKnowledgeBaseConnector(
        foreignBase.id,
        foreignOrg.id,
        { name: "Other organization source", syncPermissionsFromSource: true },
      );
      for (const connector of [outsideEnvironment, outsideOrganization])
        await publishKnowledgeSource({
          organizationId: connector.organizationId,
          resource: "knowledgeConnector",
          scope: connector.id,
        });
      const agent = await makeAgent({
        organizationId: org.id,
        knowledgeBaseIds: [published.id, privateBase.id],
        agentType: "mcp_gateway",
        accessAllTools: false,
        toolExposureMode,
      });
      await seedAndAssignArchestraTools(agent.id);
      // Direct assignment must not bypass the same publication boundary.
      await AgentConnectorAssignmentModel.assign(agent.id, privateConnector.id);
      await AgentConnectorAssignmentModel.assign(
        agent.id,
        outsideEnvironment.id,
      );
      await AgentConnectorAssignmentModel.assign(
        agent.id,
        outsideOrganization.id,
      );
      await configureKnowledgeSearch(org.id, makeLlmProviderApiKey);
      for (const [connector, content, acl] of [
        [publicConnector, "The public launch code is ORBIT.", ["org:*"]],
        [
          publicConnector,
          "Private launch code is SECRET.",
          [`user_email:${owner.email}`],
        ],
        [privateConnector, "Unpublished connector code is HIDDEN.", ["org:*"]],
        [hiddenBaseConnector, "Private base code is VAULT.", ["org:*"]],
        [outsideEnvironment, "Other environment code is SANDBOX.", ["org:*"]],
        [outsideOrganization, "Other organization code is FOREIGN.", ["org:*"]],
      ] as const) {
        await indexKnowledgeDocument({
          organizationId: connector.organizationId,
          connectorId: connector.id,
          content,
          acl: [...acl],
        });
      }
      const gateway = await connect(agent.id, {
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
        organizationId: org.id,
        oauthClientId: "synthetic-app",
        teamId: null,
        isOrganizationToken: false,
      });
      const listed = await gateway.list();
      const description = JSON.stringify(listed);
      expect(description).toContain(
        toolExposureMode === "full"
          ? "Published handbook"
          : "Internal knowledge search is available",
      );
      expect(description).not.toContain("Private connector");
      const sourceDescription = await buildKnowledgeSourcesDescription(
        agent.id,
        { organizationId: org.id },
      );
      expect(sourceDescription).toContain("Published handbook");
      expect(sourceDescription).not.toContain("Private connector");
      expect(sourceDescription).not.toContain("Hidden base source");
      expect(sourceDescription).not.toContain("Other environment source");
      expect(sourceDescription).not.toContain("Other organization source");
      if (toolExposureMode === "search_and_run_only") {
        const search = await gateway.callTool(TOOL_SEARCH_TOOLS_SHORT_NAME, {
          query: "knowledge",
        });
        expect(JSON.stringify(search)).toContain(KNOWLEDGE_TOOL);
        expect(JSON.stringify(search)).not.toContain("Private connector");
      }
      const result =
        toolExposureMode === "full"
          ? await gateway.query()
          : await gateway.callTool(TOOL_RUN_TOOL_SHORT_NAME, {
              tool_name: KNOWLEDGE_TOOL,
              tool_args: { query: "launch code" },
            });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      expect(JSON.stringify(result)).toContain("ORBIT");
      expect(JSON.stringify(result)).not.toMatch(
        /SECRET|HIDDEN|VAULT|SANDBOX|FOREIGN/,
      );
      const personal = await executeArchestraTool(
        KNOWLEDGE_TOOL,
        { query: "launch code" },
        { agent, organizationId: org.id, userId: owner.id },
      );
      expect(personal.isError, JSON.stringify(personal)).toBeFalsy();
      expect(JSON.stringify(personal)).toContain("SECRET");
      expect(JSON.stringify(personal)).toContain("HIDDEN");
      expect(JSON.stringify(personal)).not.toContain("VAULT");
    });
  }

  for (const { scope, connectorPublication } of [
    ...(
      [
        "published-base",
        "private-files",
        "private-base",
        "direct-only",
        "other-base",
      ] as const
    ).map((scope) => ({ scope, connectorPublication: "none" as const })),
    ...(["explicit", "wildcard"] as const).flatMap((connectorPublication) =>
      (["published-base", "direct-only"] as const).map((scope) => ({
        scope,
        connectorPublication,
      })),
    ),
  ]) {
    test(`uploaded files use their own grants through their published base (${scope}; connector grant ${connectorPublication})`, async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeKnowledgeBase,
      makeAgent,
      makeLlmProviderApiKey,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      const owner = await makeUser();
      await makeMember(owner.id, org.id, { role: "member" });
      const base = await makeKnowledgeBase(org.id, { access: "personal" });
      if (scope !== "private-base")
        await publishKnowledgeSource({
          organizationId: org.id,
          resource: "knowledgeBase",
          scope: base.id,
        });
      await configureKnowledgeSearch(org.id, makeLlmProviderApiKey);
      const publicUpload = await indexKnowledgeFile({
        organizationId: org.id,
        knowledgeBaseId: base.id,
        uploadedBy: owner.id,
        content: "The public file code is PUBLICFILE.",
        published: scope !== "private-files",
      });
      if (connectorPublication !== "none")
        await publishKnowledgeSource({
          organizationId: org.id,
          resource: "knowledgeConnector",
          scope:
            connectorPublication === "wildcard"
              ? "*"
              : publicUpload.connector.id,
        });
      const privateUpload = await indexKnowledgeFile({
        organizationId: org.id,
        knowledgeBaseId: base.id,
        uploadedBy: owner.id,
        content: "The private file code is PRIVATEFILE.",
        published: true,
      });
      await publishKnowledgeSource({
        organizationId: org.id,
        resource: "knowledgeFile",
        scope: privateUpload.file.id,
        readOnly: true,
      });
      const privateChunks = await KbChunkModel.findByDocument(
        privateUpload.document.id,
      );
      expect(privateChunks.length).toBeGreaterThan(0);
      expect(privateChunks.every((chunk) => chunk.acl.includes("org:*"))).toBe(
        true,
      );
      let knowledgeBaseIds = [base.id];
      if (scope === "direct-only") knowledgeBaseIds = [];
      if (scope === "other-base") {
        const other = await makeKnowledgeBase(org.id);
        await publishKnowledgeSource({
          organizationId: org.id,
          resource: "knowledgeBase",
          scope: other.id,
        });
        knowledgeBaseIds = [other.id];
      }
      const agent = await makeAgent({
        organizationId: org.id,
        knowledgeBaseIds,
        agentType: "mcp_gateway",
        accessAllTools: false,
        toolExposureMode: "full",
      });
      await seedAndAssignArchestraTools(agent.id);
      await AgentConnectorAssignmentModel.assign(
        agent.id,
        publicUpload.connector.id,
      );
      const gateway = await connect(agent.id, {
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
        organizationId: org.id,
        oauthClientId: "synthetic-app",
        teamId: null,
        isOrganizationToken: false,
      });
      const listed = await gateway.list();
      const direct = await executeArchestraTool(
        KNOWLEDGE_TOOL,
        { query: "file code" },
        { agent, organizationId: org.id },
      );
      if (scope === "published-base") {
        expect(JSON.stringify(listed)).toContain("Uploaded files");
        expect(direct.isError, JSON.stringify(direct)).toBeFalsy();
        expect(JSON.stringify(direct)).toContain("PUBLICFILE");
        expect(JSON.stringify(direct)).not.toContain("PRIVATEFILE");
        const result = await gateway.query();
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result)).toContain("PUBLICFILE");
        expect(JSON.stringify(result)).not.toContain("PRIVATEFILE");
        // The stored chunk ACL is still public: the live file grant must win.
        await publishKnowledgeSource({
          organizationId: org.id,
          resource: "knowledgeFile",
          scope: publicUpload.file.id,
          readOnly: true,
        });
        expect(
          (await gateway.list()).tools.map((tool) => tool.name),
        ).not.toContain(KNOWLEDGE_TOOL);
        expect((await gateway.query()).isError).toBe(true);
      } else {
        expect(listed.tools.map((tool) => tool.name)).not.toContain(
          KNOWLEDGE_TOOL,
        );
        expect(direct.isError).toBe(true);
        expect((await gateway.query()).isError).toBe(true);
      }
    });
  }

  for (const kind of ["permission-sync", "file-upload", "read-only"] as const) {
    test(`${kind} sources without Can use are hidden and direct calls cannot search them`, async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      const base = await makeKnowledgeBase(org.id, { access: "org" });
      await publishKnowledgeSource({
        organizationId: org.id,
        resource: "knowledgeBase",
        scope: base.id,
      });
      const connector = await makeKnowledgeBaseConnector(base.id, org.id, {
        access: "personal",
        syncPermissionsFromSource: kind !== "file-upload",
        ...(kind === "file-upload"
          ? {
              connectorType: "file_upload" as const,
              config: {} as never,
            }
          : {}),
      });
      if (kind === "read-only")
        await publishKnowledgeSource({
          organizationId: org.id,
          resource: "knowledgeConnector",
          scope: connector.id,
          readOnly: true,
        });
      const agent = await makeAgent({
        organizationId: org.id,
        knowledgeBaseIds: [base.id],
        agentType: "mcp_gateway",
        accessAllTools: false,
        toolExposureMode: "full",
      });
      await seedAndAssignArchestraTools(agent.id);
      await AgentConnectorAssignmentModel.assign(agent.id, connector.id);
      const gateway = await connect(agent.id, {
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
        organizationId: org.id,
        oauthClientId: "synthetic-app",
        teamId: null,
        isOrganizationToken: false,
      });
      expect(
        (await gateway.list()).tools.map((tool) => tool.name),
      ).not.toContain(KNOWLEDGE_TOOL);
      expect((await gateway.query()).isError).toBe(true);
      const direct = await executeArchestraTool(
        KNOWLEDGE_TOOL,
        { query: "launch code" },
        { agent, organizationId: org.id },
      );
      expect(direct.isError).toBe(true);
      expect(JSON.stringify(direct)).not.toContain("requires an acting user");
    });
  }
});

async function connect(agentId: string, tokenAuth: TokenAuthResult) {
  const { server } = await createAgentServer({ agentId, tokenAuth });
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const call = async (method: string, params: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`Missing ${method} handler`);
    return handler({ method, params });
  };
  return {
    callTool: async (
      shortName: ArchestraToolShortName,
      args: Record<string, unknown>,
    ) =>
      (await call("tools/call", {
        name: archestraMcpBranding.getToolName(shortName),
        arguments: args,
      })) as CallToolResult,
    list: async () => (await call("tools/list", {})) as ListToolsResult,
    query: async () =>
      (await call("tools/call", {
        name: KNOWLEDGE_TOOL,
        arguments: { query: "launch code" },
      })) as CallToolResult,
  };
}
