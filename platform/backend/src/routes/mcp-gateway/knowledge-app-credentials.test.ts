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
  KnowledgeBaseConnectorModel,
  ManagedOauthClientModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { buildKnowledgeSourcesDescription } from "@/services/knowledge-sources-description";
import { ResourcePermissions } from "@/services/resource-permissions";
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
          access: "personal",
          syncPermissionsFromSource: true,
        },
      );
      const privateConnector = await makeKnowledgeBaseConnector(
        privateBase.id,
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
    test(`uploaded files follow the grants of the knowledge base they sit in (${scope}; connector grant ${connectorPublication})`, async ({
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
      const privateBase = await makeKnowledgeBase(org.id, {
        access: "personal",
      });
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
        knowledgeBaseId: privateBase.id,
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
      let knowledgeBaseIds = [base.id, privateBase.id];
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
      if (scope === "published-base" || scope === "private-files") {
        expect(JSON.stringify(listed)).toContain("Uploaded files");
        expect(direct.isError, JSON.stringify(direct)).toBeFalsy();
        expect(JSON.stringify(direct)).toContain("PUBLICFILE");
        expect(JSON.stringify(direct)).not.toContain("PRIVATEFILE");
        const result = await gateway.query();
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result)).toContain("PUBLICFILE");
        expect(JSON.stringify(result)).not.toContain("PRIVATEFILE");
        // Narrowing both the file and its knowledge base to read-only revokes search.
        await publishKnowledgeSource({
          organizationId: org.id,
          resource: "knowledgeFile",
          scope: publicUpload.file.id,
          readOnly: true,
        });
        await publishKnowledgeSource({
          organizationId: org.id,
          resource: "knowledgeBase",
          scope: base.id,
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

  test("an OAuth client granted Can use on a knowledge base searches its uploaded files and connectors (including owner-scoped upstream ACLs) without separate connector grants", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeAgent,
    makeLlmProviderApiKey,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    const outsider = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    await makeMember(outsider.id, org.id, { role: "member" });
    const { oauthClient: grantedApp } = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: admin.id,
      name: "Granted knowledge app",
      grantType: "client_credentials",
      scopes: ["mcp"],
      allowedGatewayIds: [],
    });
    const { oauthClient: otherApp } = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: admin.id,
      name: "Other knowledge app",
      grantType: "client_credentials",
      scopes: ["mcp"],
      allowedGatewayIds: [],
    });

    const base = await makeKnowledgeBase(org.id, {
      name: "App-shared base",
      access: "personal",
    });
    const connector = await makeKnowledgeBaseConnector(base.id, org.id, {
      name: "App-shared handbook",
      access: "personal",
      syncPermissionsFromSource: false,
    });
    const autoSyncConnector = await makeKnowledgeBaseConnector(
      base.id,
      org.id,
      {
        name: "App-shared upstream",
        access: "personal",
        syncPermissionsFromSource: true,
      },
    );
    await configureKnowledgeSearch(org.id, makeLlmProviderApiKey);

    const upload = await indexKnowledgeFile({
      organizationId: org.id,
      knowledgeBaseId: base.id,
      uploadedBy: admin.id,
      content: "The uploaded launch code is FILE_OAUTH.",
      published: false,
    });
    await indexKnowledgeDocument({
      organizationId: org.id,
      connectorId: connector.id,
      content: "The connector launch code is CONNECTOR_OAUTH.",
      acl: [],
    });
    await indexKnowledgeDocument({
      organizationId: org.id,
      connectorId: autoSyncConnector.id,
      content: "The owner upstream launch code is OWNER_UPSTREAM_OAUTH.",
      acl: [`user_email:${admin.email}`],
    });
    await indexKnowledgeDocument({
      organizationId: org.id,
      connectorId: autoSyncConnector.id,
      content: "The outsider upstream launch code is OUTSIDER_UPSTREAM_OAUTH.",
      acl: [`user_email:${outsider.email}`],
    });

    // Grant Can use ONLY on the knowledge base; attached connectors and uploaded
    // files inherit Can use from the knowledge base without separate sharing.
    const current = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "knowledgeBase",
      scope: base.id,
    });
    await ResourcePermissions.updatePolicy({
      organizationId: org.id,
      userId: admin.id,
      resource: "knowledgeBase",
      scope: base.id,
      revision: current?.revision ?? 0,
      grants: [
        {
          subject: { type: "oauthClient", id: grantedApp.id },
          actions: ["read", "use"],
        },
      ],
    });

    const uploadedChunks = await KbChunkModel.findByDocument(
      upload.document.id,
    );
    expect(uploadedChunks.length).toBeGreaterThan(0);
    expect(
      uploadedChunks.every((chunk) =>
        chunk.acl.includes(`oauth_client:${grantedApp.id}`),
      ),
    ).toBe(true);

    const agent = await makeAgent({
      organizationId: org.id,
      knowledgeBaseIds: [base.id],
      agentType: "mcp_gateway",
      accessAllTools: false,
      toolExposureMode: "full",
    });
    await seedAndAssignArchestraTools(agent.id);

    const grantedGateway = await connect(agent.id, {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
      organizationId: org.id,
      oauthClientId: grantedApp.clientId,
      teamId: null,
      isOrganizationToken: false,
    });
    const otherGateway = await connect(agent.id, {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
      organizationId: org.id,
      oauthClientId: otherApp.clientId,
      teamId: null,
      isOrganizationToken: false,
    });

    const grantedListed = await grantedGateway.list();
    expect(JSON.stringify(grantedListed)).toContain("App-shared handbook");
    expect(JSON.stringify(grantedListed)).toContain("App-shared upstream");
    expect(JSON.stringify(grantedListed)).toContain("Uploaded files");

    const grantedResult = await grantedGateway.query();
    expect(grantedResult.isError, JSON.stringify(grantedResult)).toBeFalsy();
    expect(JSON.stringify(grantedResult)).toContain("FILE_OAUTH");
    expect(JSON.stringify(grantedResult)).toContain("CONNECTOR_OAUTH");
    expect(JSON.stringify(grantedResult)).toContain("OWNER_UPSTREAM_OAUTH");
    expect(JSON.stringify(grantedResult)).not.toContain(
      "OUTSIDER_UPSTREAM_OAUTH",
    );

    expect(
      (await otherGateway.list()).tools.map((tool) => tool.name),
    ).not.toContain(KNOWLEDGE_TOOL);
    expect((await otherGateway.query()).isError).toBe(true);

    // Also verify "All tools" (accessAllTools=true, search_and_run_only) gateway mode
    // with no manually assigned knowledge bases — the default "My Gateway" configuration.
    const autoGatewayAgent = await makeAgent({
      organizationId: org.id,
      knowledgeBaseIds: [],
      agentType: "mcp_gateway",
      accessAllTools: true,
      toolExposureMode: "search_and_run_only",
    });
    const grantedAutoGateway = await connect(autoGatewayAgent.id, {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
      organizationId: org.id,
      oauthClientId: grantedApp.clientId,
      teamId: null,
      isOrganizationToken: false,
    });
    const otherAutoGateway = await connect(autoGatewayAgent.id, {
      tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
      organizationId: org.id,
      oauthClientId: otherApp.clientId,
      teamId: null,
      isOrganizationToken: false,
    });

    const grantedSearch = await grantedAutoGateway.callTool("search_tools", {
      query: "knowledge",
    });
    expect(grantedSearch.isError).toBeFalsy();
    expect(JSON.stringify(grantedSearch.structuredContent)).toContain(
      KNOWLEDGE_TOOL,
    );

    const grantedAutoRun = await grantedAutoGateway.callTool("run_tool", {
      tool_name: KNOWLEDGE_TOOL,
      tool_args: { query: "launch code" },
    });
    expect(grantedAutoRun.isError, JSON.stringify(grantedAutoRun)).toBeFalsy();
    expect(JSON.stringify(grantedAutoRun)).toContain("FILE_OAUTH");
    expect(JSON.stringify(grantedAutoRun)).toContain("CONNECTOR_OAUTH");
    expect(JSON.stringify(grantedAutoRun)).toContain("OWNER_UPSTREAM_OAUTH");
    expect(JSON.stringify(grantedAutoRun)).not.toContain(
      "OUTSIDER_UPSTREAM_OAUTH",
    );

    // Unassigning a connector from the knowledge base immediately revokes its inherited access.
    await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(
      connector.id,
      base.id,
    );
    const afterUnassignRun = await grantedAutoGateway.callTool("run_tool", {
      tool_name: KNOWLEDGE_TOOL,
      tool_args: { query: "launch code" },
    });
    expect(
      afterUnassignRun.isError,
      JSON.stringify(afterUnassignRun),
    ).toBeFalsy();
    expect(JSON.stringify(afterUnassignRun)).toContain("FILE_OAUTH");
    expect(JSON.stringify(afterUnassignRun)).toContain("OWNER_UPSTREAM_OAUTH");
    expect(JSON.stringify(afterUnassignRun)).not.toContain("CONNECTOR_OAUTH");

    // Removing the indexed file from the knowledge base (and moving it into a
    // separate private knowledge base) immediately revokes the OAuth client's
    // inherited grant from the original knowledge base.
    const privateMoveBase = await makeKnowledgeBase(org.id, {
      name: "Private move destination",
      access: "personal",
    });
    await indexKnowledgeFile({
      organizationId: org.id,
      knowledgeBaseId: privateMoveBase.id,
      uploadedBy: admin.id,
      content: "The uploaded launch code is FILE_OAUTH.",
      published: false,
    });
    const { KbDocumentModel } = await import("@/models");
    await KbDocumentModel.delete(upload.document.id);
    const afterFileMoveRun = await grantedAutoGateway.callTool("run_tool", {
      tool_name: KNOWLEDGE_TOOL,
      tool_args: { query: "launch code" },
    });
    expect(
      afterFileMoveRun.isError,
      JSON.stringify(afterFileMoveRun),
    ).toBeFalsy();
    expect(JSON.stringify(afterFileMoveRun)).toContain("OWNER_UPSTREAM_OAUTH");
    expect(JSON.stringify(afterFileMoveRun)).not.toContain("FILE_OAUTH");

    const otherSearch = await otherAutoGateway.callTool("search_tools", {
      query: "knowledge",
    });
    expect(JSON.stringify(otherSearch.structuredContent)).not.toContain(
      KNOWLEDGE_TOOL,
    );
    const otherAutoRun = await otherAutoGateway.callTool("run_tool", {
      tool_name: KNOWLEDGE_TOOL,
      tool_args: { query: "launch code" },
    });
    expect(otherAutoRun.isError).toBe(true);

    // An OAuth client also reaches organization-wide knowledge bases and connectors
    // from the upgrade cutover (legacyOrganizationAudience = true with role grants).
    const cutoverBase = await makeKnowledgeBase(org.id, {
      name: "Cutover org base",
      access: "org",
    });
    const cutoverConnector = await makeKnowledgeBaseConnector(
      cutoverBase.id,
      org.id,
      {
        name: "Cutover org connector",
        access: "org",
        syncPermissionsFromSource: false,
      },
    );
    await indexKnowledgeDocument({
      organizationId: org.id,
      connectorId: cutoverConnector.id,
      content: "The cutover launch code is CUTOVER_ORG_OAUTH.",
      acl: ["org:*"],
    });
    const cutoverRun = await otherAutoGateway.callTool("run_tool", {
      tool_name: KNOWLEDGE_TOOL,
      tool_args: { query: "launch code" },
    });
    expect(cutoverRun.isError, JSON.stringify(cutoverRun)).toBeFalsy();
    expect(JSON.stringify(cutoverRun)).toContain("CUTOVER_ORG_OAUTH");
    expect(JSON.stringify(cutoverRun)).not.toContain("OWNER_UPSTREAM_OAUTH");

    await ManagedOauthClientModel.delete({
      id: grantedApp.id,
      organizationId: org.id,
    });
    expect(
      (await grantedGateway.list()).tools.map((tool) => tool.name),
    ).not.toContain(KNOWLEDGE_TOOL);
    expect((await grantedGateway.query()).isError).toBe(true);
  });

  for (const kind of ["permission-sync", "file-upload", "read-only"] as const) {
    test(`${kind} sources without Can use are hidden and direct calls cannot search them`, async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      const org = await makeOrganization();
      const base = await makeKnowledgeBase(org.id, { access: "personal" });
      await publishKnowledgeSource({
        organizationId: org.id,
        resource: "knowledgeBase",
        scope: base.id,
        readOnly: true,
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
