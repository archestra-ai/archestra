import assert from "node:assert/strict";
import { ARCHESTRA_MCP_CATALOG_ID, PLAYWRIGHT_MCP_CATALOG_ID, SKILL_ARCHESTRA_TOOL_SHORT_NAMES, buildCustomAgentRuntime } from "@archestra/shared";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rmdir, stat } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import "../src/server/composition.ts";
import { executeArchestraTool } from "../src/archestra-mcp-server/index.ts";
import { CacheKey, cacheManager } from "../src/cache-manager.ts";
import config from "../src/config.ts";
import db, { initializeDatabase, schema } from "../src/database/index.ts";
import { createFastifyInstance } from "../src/fastify-instance.ts";
import { constructFrozenMcpDeploymentName } from "../src/k8s/deployment-names.ts";
import McpServerRuntimeManager from "../src/k8s/mcp-server-runtime/manager.ts";
import { AgentConnectorAssignmentModel, AgentKnowledgeBaseModel, AgentModel, AgentToolModel, AppLabelModel, AppModel, ConversationModel, EnvironmentModel, InternalMcpCatalogModel, KnowledgeBaseConnectorModel, KnowledgeBaseModel, LlmProviderApiKeyModel, McpServerModel, McpToolCallModel, MessageModel, SecretModel, TeamModel, ToolModel, UserTokenModel } from "../src/models/index.ts";
import { agentKnowledgeSourcesCache } from "../src/models/agent-knowledge-sources-cache.ts";
import AgentActivationSkillRuleModel from "../src/models/agent-activation-skill-rule.ts";
import { onAgentToolSurfaceChange } from "../src/models/agent-tool-surface.ts";
import AgentVersionModel from "../src/models/agent-version.ts";
import CacheEntryModel from "../src/models/cache-entry.ts";
import InteractionSessionHeadModel from "../src/models/interaction-session-head.ts";
import ResourcePermissionPolicyModel from "../src/models/resource-permission-policy.ts";
import AppVersionModel from "../src/models/app-version.ts";
import mcpGatewayRoutes from "../src/routes/mcp-gateway/index.ts";
import { secretManager } from "../src/secrets-manager/index.ts";
import { mintCatalogToolNames } from "../src/services/mcp-tool-names.ts";
import { projectService } from "../src/services/project.ts";
import { fileStore } from "../src/skills-sandbox/file-store.ts";
import { drainBackgroundWork } from "../src/utils/background-work.ts";
import { callRustApi } from "../src/utils/rust-api.ts";
import { readBucket } from "../src/utils/throughput-bucket.ts";
import { deleteAppBacking } from "../src/services/apps/app-mcp-backing.ts";

test("Rust MCP dispatch, execution and subscriptions preserve authorization and audit", { timeout: 1_500_000 }, async (t) => {
  assert.equal(new URL(config.database.url).pathname, "/archestra_riir_test");
  await initializeDatabase();
  const org = randomUUID();
  const owner = randomUUID();
  const member = randomUUID();
  await db.insert(schema.organizationsTable).values({ id: org, name: org, slug: org, createdAt: new Date() });
  await db.insert(schema.usersTable).values(
    [owner, member].map((id) => ({ id, email: `${id}@example.invalid`, name: "MCP fixture user" })),
  );
  await db.insert(schema.membersTable).values(
    [owner, member].map((userId) => ({ id: randomUUID(), organizationId: org, userId, role: "member", createdAt: new Date() })),
  );
  const gateway = await AgentModel.create({
    name: "Private MCP discovery fixture",
    description: "  Read-only notes 📝\n",
    organizationId: org,
    agentType: "mcp_gateway",
    toolExposureMode: "full",
  }, owner);
  const unassignedGateway = await AgentModel.create({
    name: "Unassigned MCP fixture",
    organizationId: org,
    agentType: "mcp_gateway",
    toolExposureMode: "full",
  }, owner, { skipCreationDefaultTools: true });
  await db.insert(schema.internalMcpCatalogTable).values({
    id: ARCHESTRA_MCP_CATALOG_ID, name: "Archestra", serverType: "builtin",
  });
  const hooksWereEnabled = config.hooks.enabled;
  config.hooks.enabled = true;
  try {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
  } finally {
    config.hooks.enabled = hooksWereEnabled;
  }
  await ToolModel.assignArchestraToolsToAgent(gateway.id, ARCHESTRA_MCP_CATALOG_ID);
  const allowed = (await UserTokenModel.create(owner, org)).value;
  const denied = (await UserTokenModel.create(member, org)).value;
  const scratch = await mkdtemp("/tmp/riir-mcp-");
  const socket = join(scratch, "api.sock");
  const app = createFastifyInstance();
  let child;
  let childExit;
  let relay;
  let remote;
  let nativeRemoteCalls = 0;
  let toolRequests = 0;
  let usageRequests = 0;
  let teamRequests = 0;
  let teamCreateRequests = 0;
  let teamEditRequests = 0;
  let teamDeleteRequests = 0;
  let teamMemberAddRequests = 0;
  let teamMemberRoleRequests = 0;
  let teamMemberRemoveRequests = 0;
  let externalGroupAddRequests = 0;
  let externalGroupRemoveRequests = 0;
  let memberRequests = 0;
  let externalGroupRequests = 0;
  let limitRequests = 0;
  let limitCreateRequests = 0;
  let limitUpdateRequests = 0;
  let limitDeleteRequests = 0;
  let runRequests = 0;
  let runPageRequests = 0;
  let transcriptRequests = 0;
  let condensationRequests = 0;
  let scheduleRequests = 0;
  let scheduleCreateRequests = 0;
  let scheduleUpdateRequests = 0;
  let scheduleDeleteRequests = 0;
  let manualRunRequests = 0;
  let schedulePageRequests = 0;
  let projectRequests = 0;
  let projectLinkRequests = 0;
  let projectUnlinkRequests = 0;
  let projectListRequests = 0;
  let knowledgeRequests = 0;
  let knowledgeDeleteRequests = 0;
  let knowledgeUpdateRequests = 0;
  let knowledgeCreateRequests = 0;
  let knowledgeListRequests = 0;
  let connectorRequests = 0;
  let connectorDeleteRequests = 0;
  let connectorUpdateRequests = 0;
  let connectorCreateRequests = 0;
  let connectorAssignRequests = 0;
  let connectorUnassignRequests = 0;
  let agentKnowledgeAssignRequests = 0;
  let agentKnowledgeUnassignRequests = 0;
  let agentConnectorAssignRequests = 0;
  let agentConnectorUnassignRequests = 0;
  let appLockRequests = 0;
  let appToolRequests = 0;
  let appLabelRequests = 0;
  let appDeleteRequests = 0;
  let appScaffoldRequests = 0;
  let appEditRequests = 0;
  let appRefineRequests = 0;
  let appPublishRequests = 0;
  let skillPolicyPatchRequests = 0;
  let removeAgentToolRequests = 0;
  let assignAgentToolRequests = 0;
  let editCatalogDescriptionRequests = 0;
  let editCatalogConfigRequests = 0;
  let createCatalogRequests = 0;
  let deployCatalogRequests = 0;
  let reloadCatalogRequests = 0;
  let connectorListRequests = 0;
  let hookListRequests = 0;
  let hookCreateRequests = 0;
  let hookUpdateRequests = 0;
  let hookDeleteRequests = 0;
  let agentDetailRequests = 0;
  let agentNameRequests = 0;
  let gatewayWriteRequests = 0;
  let agentCreateRequests = 0;
  let agentEditRequests = 0;
  let holdGatewayWrite;
  let gatewayVersionRequests = 0;
  let gatewayAllToolsRequests = 0;
  let gatewayEditRequests = 0;
  let gatewayAssignmentEditRequests = 0;
  let gatewayDelegationRequests = 0;
  let holdGatewayVersion;
  let modelListRequests = 0;
  let interactionRequests = 0;
  let interactionPageRequests = 0;
  let sessionRequests = 0;
  let sessionLogRequests = 0;
  let holdToolReply;
  let subscriptionClosed;
  try {
    cacheManager.start();
    // The PostgreSQL adapter creates its table on first use; the rate limiter
    // uses mapped SQL reads directly and expects that table to exist.
    await cacheManager.set(`${CacheKey.McpGatewayRateLimit}-fixture-${org}`, true);
    await app.register(mcpGatewayRoutes);
    const post = async ({ credential = allowed, method, status, audit, checkAudit = true, headers = {}, params = {}, id = "riir-request", target = gateway }) => {
      const before = await McpToolCallModel.getAllMcpToolCallsForAgent(target.id);
      const response = await app.inject({
        method: "POST",
        url: `/v1/mcp/${target.slug}`,
        headers: {
          ...(credential && { authorization: `Bearer ${credential}` }),
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...headers,
        },
        payload: { jsonrpc: "2.0", method, id, params },
      });
      assert.equal(response.statusCode, status, response.body);
      await drainBackgroundWork();
      const logs = await McpToolCallModel.getAllMcpToolCallsForAgent(target.id);
      const existingIds = new Set(before.map(({ id }) => id));
      if (checkAudit) {
        assert.deepEqual(logs.filter(({ id }) => !existingIds.has(id)).map(({ method, userId }) => ({ method, userId })),
          audit ? [{ method: audit, userId: owner }] : []);
      }
      return {
        body: response.body ? response.json() : null,
        version: response.headers["mcp-protocol-version"],
        contentType: response.headers["content-type"],
        challenge: response.headers["www-authenticate"],
      };
    };
    const discover = (credential, status) => post({
      credential, status, method: "server/discover", id: "riir-discover",
      audit: status === 200 ? "server/discover" : undefined,
    });
    const toolName = "archestra__whoami";
    const taskId = randomUUID();
    const matrix = [
      { method: "tools/list", status: 200, audit: "tools/list" },
      { method: "tools/call", status: 200, audit: "tools/call", headers: { "mcp-name": toolName }, params: { name: toolName, arguments: {} } },
      { method: "tools/call", status: 400, headers: { "mcp-name": "wrong" }, params: { name: toolName } },
      { method: "tools/call", status: 400, params: { name: toolName } },
      { method: "tools/list", status: 400, headers: { "mcp-method": "ping" } },
      { method: "tools/list", status: 400, headers: { "mcp-protocol-version": "unknown" } },
      { method: "tools/list", status: 403, credential: denied },
      { method: "ping", status: 200 },
      { method: "ping", status: 200, headers: { "mcp-protocol-version": "2024-11-05" } },
      { method: "tasks/get", status: 200, headers: { "mcp-name": taskId }, params: { taskId } },
      { method: "subscriptions/listen", status: 400, id: null },
      { method: "tools/call", status: 200, audit: "tools/call", target: unassignedGateway,
        headers: { "mcp-name": toolName }, params: { name: toolName, arguments: {} } },
    ];
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacy = await discover(allowed, 200);
    assert.equal(legacy.version, "2026-07-28");
    assert.equal(legacy.body.id, "riir-discover");
    assert.equal(legacy.body.result.instructions, "Read-only notes 📝");
    const unauthorized = await discover(null, 401);
    const forbidden = await discover(denied, 403);
    assert.ok(unauthorized.challenge);
    assert.equal(forbidden.challenge, undefined);
    const expected = [];
    for (const request of matrix) expected.push(await post(request));
    assert.ok(expected[0].body.result.tools.some(({ name }) => name === toolName));
    assert.notEqual(expected[1].body.result.isError, true);
    assert.equal(expected[2].body.error.code, -32020);
    assert.equal(expected[5].body.error.code, -32022);
    assert.equal(expected[7].body.error.code, -32601);
    assert.equal(expected[9].body.error.code, -32602);
    assert.equal(expected.at(-1).body.result.isError, true);

    config.mcpGateway.rustDiscoverEnabled = true;
    config.database.rustAuditLogSocket = socket;
    // With no listener, denied callers never reach Rust and allowed callers
    // cannot get a TypeScript fallback or leave behind a successful log.
    assert.deepEqual(await discover(null, 401), unauthorized);
    assert.deepEqual(await discover(denied, 403), forbidden);
    await post({ method: "tools/list", status: 502 });
    child = spawn("../archestra-rs/target/debug/archestra-api", [socket], { stdio: "inherit" });
    childExit = once(child, "exit");
    for (let retry = 0; retry < 40 && !(await stat(socket).catch(() => null)); retry++) {
      assert.equal(child.exitCode, null);
      await delay(50);
    }
    assert.ok((await stat(socket)).isSocket());
    const relayPath = join(scratch, "relay.sock");
    relay = createServer((incoming, outgoing) => {
      if (incoming.url === "/internal/v1/mcp/remote-call") nativeRemoteCalls++;
      const isTool = incoming.url === "/internal/v1/mcp/tools/whoami";
      const isUsage = incoming.url === "/internal/v1/mcp/tools/agent-token-usage";
      const isTeams = incoming.url === "/internal/v1/mcp/tools/list-teams";
      const isMembers = incoming.url === "/internal/v1/mcp/tools/list-team-members";
      const isExternalGroups = incoming.url === "/internal/v1/mcp/tools/list-team-external-groups";
      const isLimits = incoming.url === "/internal/v1/mcp/tools/get-limits";
      const isRun = incoming.url === "/internal/v1/mcp/tools/get-schedule-trigger-run";
      const isRunPage = incoming.url === "/internal/v1/mcp/tools/list-schedule-trigger-runs";
      const isTranscript = incoming.url === "/internal/v1/mcp/tools/get-schedule-trigger-run-transcript";
      const isSchedule = incoming.url === "/internal/v1/mcp/tools/get-schedule-trigger";
      const isSchedulePage = incoming.url === "/internal/v1/mcp/tools/list-schedule-triggers";
      const isProject = incoming.url === "/internal/v1/mcp/tools/get-project";
      const isProjectList = incoming.url === "/internal/v1/mcp/tools/list-projects";
      const isKnowledge = incoming.url === "/internal/v1/mcp/tools/get-knowledge-base";
      const isKnowledgeList = incoming.url === "/internal/v1/mcp/tools/get-knowledge-bases";
      const isConnector = incoming.url === "/internal/v1/mcp/tools/get-knowledge-connector";
      const isConnectorList = incoming.url === "/internal/v1/mcp/tools/get-knowledge-connectors";
      const isHookList = incoming.url === "/internal/v1/mcp/tools/list-hooks";
      const isAgentDetail = incoming.url === "/internal/v1/mcp/tools/get-agent";
      const isAgentName = incoming.url === "/internal/v1/mcp/tools/get-agent-by-name";
      const gatewayWrite = incoming.url === "/internal/v1/mcp/tools/create-gateway";
      if (incoming.url === "/internal/v1/mcp/tools/create-agent") agentCreateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/edit-agent") agentEditRequests++;
      const gatewayVersion = incoming.url === "/internal/v1/mcp/tools/gateway-version";
      const writeHold = gatewayWrite ? holdGatewayWrite : gatewayVersion ? holdGatewayVersion : undefined;
      if (gatewayWrite) gatewayWriteRequests++;
      if (gatewayVersion) gatewayVersionRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/enable-gateway-all-tools") gatewayAllToolsRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/edit-gateway") gatewayEditRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/edit-gateway-assignments") gatewayAssignmentEditRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/assign-gateway-delegation") gatewayDelegationRequests++;
      const isModelList = incoming.url === "/internal/v1/mcp/tools/list-llm-models";
      const isInteraction = incoming.url === "/internal/v1/mcp/tools/get-llm-interaction";
      const isInteractionPage = incoming.url === "/internal/v1/mcp/tools/list-llm-interactions";
      const isSessionPage = incoming.url === "/internal/v1/mcp/tools/list-llm-sessions";
      const isSessionLogPage = incoming.url === "/internal/v1/mcp/tools/get-llm-session-logs";
      const subscription = incoming.url === "/internal/v1/mcp/subscription"
        ? subscriptionClosed : undefined;
      if (isTool) toolRequests++;
      if (isUsage) usageRequests++;
      if (isTeams) teamRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/create-team") teamCreateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/edit-team") teamEditRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/delete-team") teamDeleteRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/add-team-member") teamMemberAddRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/update-team-member-role") teamMemberRoleRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/remove-team-member") teamMemberRemoveRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/add-team-external-group") externalGroupAddRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/remove-team-external-group") externalGroupRemoveRequests++;
      if (isMembers) memberRequests++;
      if (isExternalGroups) externalGroupRequests++;
      if (isLimits) limitRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/create-limit") limitCreateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/update-limit") limitUpdateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/delete-limit") limitDeleteRequests++;
      if (isRun) runRequests++;
      if (isRunPage) runPageRequests++;
      if (isTranscript) transcriptRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/condense-schedule-transcript") condensationRequests++;
      if (isSchedule) scheduleRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/create-schedule-trigger") scheduleCreateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/update-schedule-trigger") scheduleUpdateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/delete-schedule-trigger") scheduleDeleteRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/create-manual-schedule-run") manualRunRequests++;
      if (isSchedulePage) schedulePageRequests++;
      if (isProject) projectRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/link-project-app") projectLinkRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/unlink-project-app") projectUnlinkRequests++;
      if (isProjectList) projectListRequests++;
      if (isKnowledge) knowledgeRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/delete-knowledge-base") knowledgeDeleteRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/update-knowledge-base") knowledgeUpdateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/create-knowledge-base") knowledgeCreateRequests++;
      if (isKnowledgeList) knowledgeListRequests++;
      if (isConnector) connectorRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/delete-knowledge-connector") connectorDeleteRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/update-knowledge-connector") connectorUpdateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/create-knowledge-connector") connectorCreateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/assign-connector-to-knowledge-base") connectorAssignRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/unassign-connector-from-knowledge-base") connectorUnassignRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/assign-knowledge-base-to-agent") agentKnowledgeAssignRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/unassign-knowledge-base-from-agent") agentKnowledgeUnassignRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/assign-connector-to-agent") agentConnectorAssignRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/unassign-connector-from-agent") agentConnectorUnassignRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/set-app-lock") appLockRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/set-app-tools") appToolRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/set-app-labels") appLabelRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/delete-app") appDeleteRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/scaffold-app") appScaffoldRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/edit-app") appEditRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/refine-app") appRefineRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/publish-app") appPublishRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/patch-agent-skill-policy") skillPolicyPatchRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/remove-agent-tool") removeAgentToolRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/assign-agent-tool") assignAgentToolRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/edit-mcp-description") editCatalogDescriptionRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/edit-mcp-config") editCatalogConfigRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/create-mcp-server") createCatalogRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/deploy-mcp-server") deployCatalogRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/reload-mcp-server-tools") reloadCatalogRequests++;
      if (isConnectorList) connectorListRequests++;
      if (isHookList) hookListRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/create-hook") hookCreateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/update-hook") hookUpdateRequests++;
      if (incoming.url === "/internal/v1/mcp/tools/delete-hook") hookDeleteRequests++;
      if (isAgentDetail) agentDetailRequests++;
      if (isAgentName) agentNameRequests++;
      if (isModelList) modelListRequests++;
      if (isInteraction) interactionRequests++;
      if (isInteractionPage) interactionPageRequests++;
      if (isSessionPage) sessionRequests++;
      if (isSessionLogPage) sessionLogRequests++;
      const hold = isTool || isUsage || isTeams || isMembers || isExternalGroups || isLimits || isRun || isRunPage || isTranscript || isSchedule || isSchedulePage || isProject || isProjectList || isKnowledge || isKnowledgeList || isConnector || isConnectorList || isHookList || isAgentDetail || isAgentName || isModelList || isInteraction || isInteractionPage || isSessionPage || isSessionLogPage ? holdToolReply : undefined;
      const upstream = requestHttp({
        socketPath: socket, path: incoming.url, method: incoming.method, headers: incoming.headers,
      }, (response) => {
        if (hold) {
          response.resume();
          hold.received.resolve();
          return;
        }
        const forward = () => {
          if (outgoing.destroyed) return;
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        };
        if (writeHold) {
          writeHold.received.resolve(response.statusCode);
          void writeHold.release.promise.then(forward);
        } else forward();
      });
      outgoing.once("close", () => {
        upstream.destroy();
        hold?.closed.resolve();
        writeHold?.closed.resolve();
        subscription?.resolve();
      });
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    });
    relay.listen(relayPath);
    await once(relay, "listening");
    config.database.rustAuditLogSocket = relayPath;
    assert.deepEqual(await discover(allowed, 200), legacy);
    assert.deepEqual(await discover(denied, 403), forbidden);
    for (const [index, request] of matrix.entries()) {
      assert.deepEqual(await post(request), expected[index], request.method);
    }
    assert.equal(toolRequests, 1, "only the admitted tool call crossed the native boundary");

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const call = (controller, id, name = toolName, args = {}) => fetch(`${address}/v1/mcp/${gateway.slug}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${allowed}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
        params: { name, arguments: args } }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    });
    async function singleAuditSince(before, method = "tools/call") {
      const prior = new Set(before.map(({ id }) => id));
      for (let i = 0; i < 30; i++) {
        const added = (await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id)).filter(({ id }) => !prior.has(id));
        if (added.length) {
          assert.equal(added.length, 1);
          assert.equal(added[0].method, method);
          return added[0];
        }
        await delay(50);
      }
      assert.fail("tool did not write an audit record");
    }
    for (const native of [false, true]) {
      config.mcpGateway.rustDiscoverEnabled = native;
      const before = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
      // Disconnect at the same point on both paths: execution finished, but
      // the audit INSERT is blocked by this transaction's table lock.
      await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE mcp_tool_calls IN SHARE MODE`);
        const controller = new AbortController();
        const rejected = assert.rejects(call(controller, "riir-cancel-after-tool"), { name: "AbortError" });
        try {
          let blocked = false;
          for (let i = 0; i < 30; i++) {
            const { rows: [row] } = await tx.execute(sql`
              SELECT EXISTS (
                SELECT FROM pg_locks
                WHERE relation = 'mcp_tool_calls'::regclass AND NOT granted
                  AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
              ) AS blocked`);
            if (row.blocked) { blocked = true; break; }
            await delay(50);
          }
          assert.equal(blocked, true);
        } finally {
          controller.abort();
          await rejected;
        }
      });
      assert.equal((await singleAuditSince(before)).toolResult.isError, false);
    }
    const before = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const controller = new AbortController();
    const response = call(controller, "riir-cancel");
    const rejected = assert.rejects(response, { name: "AbortError" });
    await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native tool did not respond"))]);
    controller.abort();
    await rejected;
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("relay was not cancelled"))]);
    assert.equal((await singleAuditSince(before)).toolResult.isError, true);
    assert.equal(toolRequests, 3, "cancellation did not redispatch the tool");
    holdToolReply = undefined;

    const assigned = await ToolModel.findByName(toolName);
    assert.ok(assigned);
    const observed = [];
    for (const native of [false, true]) {
      config.mcpGateway.rustDiscoverEnabled = native;
      config.mcpGateway.subscriptionMaxDurationMs = 0;
      const priorLogs = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
      subscriptionClosed = Promise.withResolvers();
      const stop = new AbortController();
      try {
        const stream = await listen(stop);
        const ack = await stream.next();
        assert.equal(ack.method, "notifications/subscriptions/acknowledged");
        assert.deepEqual(ack.params.notifications, { toolsListChanged: true });
        // Leave time for the initial caller-scoped fingerprint before changing the tool set.
        await delay(600);
        assert.equal(await AgentToolModel.delete({ agentId: gateway.id, toolId: assigned.id }), true);
        const changed = await stream.next();
        assert.equal(changed.method, "notifications/tools/list_changed");
        assert.deepEqual(changed.params._meta, ack.params._meta);
        observed.push([ack, changed]);
        stop.abort();
        await assert.rejects(stream.next(), { name: "AbortError" });
        if (native) {
          await Promise.race([subscriptionClosed.promise, delay(2_000).then(() => assert.fail("subscription relay leaked"))]);
        }
        await AgentToolModel.createIfNotExists(gateway.id, assigned.id);
        const log = await singleAuditSince(priorLogs, "subscriptions/listen");
        assert.equal(log.userId, owner);
        assert.deepEqual(log.toolResult.notifications, { toolsListChanged: true });
      } finally {
        stop.abort();
      }
    }
    assert.deepEqual(observed[1], observed[0]);
    const endings = [];
    for (const native of [false, true]) {
      config.mcpGateway.rustDiscoverEnabled = native;
      config.mcpGateway.subscriptionMaxDurationMs = 100;
      const priorLogs = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
      const stream = await listen(new AbortController());
      await stream.next();
      endings.push(await stream.next());
      assert.equal(await stream.next(), null);
      await singleAuditSince(priorLogs, "subscriptions/listen");
    }
    assert.deepEqual(endings[1], endings[0]);
    assert.equal(endings[0].id, "riir-listen");

    const remoteName = "riir-remote__echo";
    let upstreamCalls = 0;
    let slowStarted;
    let slowClosed;
    let finishSlow;
    let completeSlow;
    let sessionId;
    let initializations = 0;
    let tokenExchanges = 0;
    let roleAssumptions = 0;
    let reloadTools;
    let deploymentTools;
    let deploymentLists = 0;
    const oauthToolTokens = [];
    const toolSessions = [];
    remote = createServer(async (req, res) => {
      if (req.method !== "POST") return res.writeHead(405).end();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      if (req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") &&
          new URLSearchParams(body).get("Action") === "AssumeRoleWithWebIdentity") {
        const form = new URLSearchParams(body);
        assert.equal(form.get("Action"), "AssumeRoleWithWebIdentity");
        assert.equal(form.get("RoleSessionName"), `agent-${gateway.id}`);
        roleAssumptions++;
        const expiry = new Date(Date.now() + 3_600_000).toISOString();
        return res.writeHead(200, { "content-type": "text/xml" }).end(
          `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIAFIXTURE</AccessKeyId><SecretAccessKey>fixture-secret</SecretAccessKey><SessionToken>fixture-session</SessionToken><Expiration>${expiry}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
        );
      }
      if (req.url.startsWith("/signed/")) verifySignature(req, body);
      if (req.url === "/token") {
        const form = new URLSearchParams(body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), "fixture-refresh");
        tokenExchanges++;
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          access_token: "fixture-fresh", refresh_token: "fixture-rotated", token_type: "Bearer", expires_in: 3600,
        }));
      }
      const { method, id, params } = JSON.parse(body);
      if (method !== "initialize" && req.headers["mcp-session-id"] !== sessionId) {
        return res.writeHead(404).end("Session not found");
      }
      if (method === "notifications/cancelled" && !config.mcpGateway.rustDiscoverEnabled) {
        finishSlow?.(params.requestId);
      }
      if (id === undefined) return res.writeHead(202).end();
      let result;
      if (method === "initialize") {
        initializations++;
        sessionId = randomUUID();
        res.setHeader("mcp-session-id", sessionId);
        result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: "riir-remote", version: "1" } };
      } else if (method === "tools/list") {
        if (req.url === "/deploy-discovery") deploymentLists++;
        result = { tools: req.url === "/reload" ? reloadTools : req.url === "/deploy-discovery" ? deploymentTools : [{ name: "echo", inputSchema: { type: "object" } }] };
      } else if (method === "tools/call") {
        upstreamCalls++;
        assert.equal(params.name, "echo");
        toolSessions.push(req.headers["mcp-session-id"]);
        if (req.url.startsWith("/oauth/")) {
          oauthToolTokens.push(req.headers.authorization);
          if (req.headers.authorization !== "Bearer fixture-fresh") {
            return res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end();
          }
        }
        if (params.arguments.mode === "slow") {
          finishSlow = (requestId) => {
            if (requestId === id) res.writeHead(204).end();
          };
          completeSlow = () => res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", id, result: {
              content: [{ type: "text", text: "finished" }], structuredContent: { finished: true },
            } }),
          );
          res.once("close", slowClosed.resolve);
          slowStarted.resolve();
          return;
        }
        result = { content: [{ type: "text", text: params.arguments.mode }], structuredContent: params.arguments };
      } else {
        result = {};
      }
      const wire = JSON.stringify({ jsonrpc: "2.0", id, result });
      if (params?.arguments?.mode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${wire}\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(wire);
      }
    });
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    const catalog = await InternalMcpCatalogModel.create({
      name: "riir-remote", serverType: "remote", organizationId: org,
      serverUrl: `http://127.0.0.1:${remote.address().port}/mcp`,
    }, { organizationId: org, authorId: owner });
    const installation = await McpServerModel.create({ name: catalog.name,
      catalogId: catalog.id, serverType: "remote", ownerId: owner });
    const echo = await ToolModel.createToolIfNotExists({ name: remoteName, rawName: "echo",
      description: "Echo fixture", parameters: { type: "object" }, catalogId: catalog.id });
    await AgentToolModel.create(gateway.id, echo.id, { mcpServerId: installation.id });
    const echoRequest = (mode) => ({ method: "tools/call", status: 200, audit: "tools/call",
      headers: { "mcp-name": remoteName }, params: { name: remoteName, arguments: { mode } } });
    const remoteParity = [];
    for (const native of [false, true]) {
      config.mcpGateway.rustDiscoverEnabled = native;
      const results = [];
      for (const mode of ["json", "sse"]) {
        const result = await post(echoRequest(mode));
        assert.deepEqual(result.body.result.structuredContent, { mode });
        results.push(result);
      }
      await post({ ...echoRequest("denied"), credential: denied, status: 403, audit: undefined });
      await cancelRemote();
      assert.deepEqual((await post(echoRequest("after-cancel"))).body.result.structuredContent, { mode: "after-cancel" });
      remoteParity.push(results);
    }
    assert.deepEqual(remoteParity[1], remoteParity[0]);
    assert.equal(initializations, 1);
    assert.equal(upstreamCalls, 8);
    assert.equal(nativeRemoteCalls, 4);
    assert.deepEqual(toolSessions, Array(8).fill(sessionId));

    async function cancelRemote(slow = echoRequest("slow")) {
      slowStarted = Promise.withResolvers();
      slowClosed = Promise.withResolvers();
      const stopRemote = new AbortController();
      const priorRemote = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
      const disconnected = assert.rejects(fetch(`${address}/v1/mcp/${gateway.slug}`, {
        method: "POST",
        headers: { ...slow.headers, authorization: `Bearer ${allowed}`, "content-type": "application/json",
          accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": slow.method },
        body: JSON.stringify({ jsonrpc: "2.0", id: "slow-remote", method: slow.method, params: slow.params }),
        signal: AbortSignal.any([stopRemote.signal, AbortSignal.timeout(5_000)]),
      }), { name: "AbortError" });
      try {
        await Promise.race([slowStarted.promise, delay(4_000).then(() => assert.fail("remote call did not start"))]);
      } finally {
        stopRemote.abort();
        await disconnected;
      }
      await Promise.race([slowClosed.promise, delay(4_000).then(() => assert.fail("upstream call leaked"))]);
      assert.equal((await singleAuditSince(priorRemote)).toolResult._meta.archestraError.type, "cancelled");
    }

    const taskMeta = {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { "io.modelcontextprotocol/tasks": {} },
      },
    };
    const taskMethod = async (method, taskId) => (await post({
      method, status: 200, checkAudit: false, headers: { "mcp-name": taskId }, params: { taskId },
    })).body.result;
    const originalToolTimeout = config.mcpGateway.toolCallTimeoutMs;
    config.mcpGateway.toolCallTimeoutMs = 1_000;
    const completedTasks = [];
    for (const native of [false, true]) {
      config.mcpGateway.rustDiscoverEnabled = native;
      for (const action of ["complete", "cancel"]) {
        slowStarted = Promise.withResolvers();
        slowClosed = Promise.withResolvers();
        const before = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
        const upstreamBefore = upstreamCalls;
        const nativeBefore = nativeRemoteCalls;
        const slow = echoRequest("slow");
        const { body: { result: task } } = await post({
          ...slow, audit: undefined, params: { ...slow.params, _meta: taskMeta },
        });
        assert.equal(task.resultType, "task");
        assert.equal((await taskMethod("tasks/get", task.taskId)).status, "working");
        await Promise.race([slowStarted.promise, delay(4_000).then(() => assert.fail("task did not reach upstream"))]);
        if (action === "complete") {
          // Keep the call alive past the synchronous timeout as well as the detach threshold.
          await delay(1_100);
          completeSlow();
        } else {
          await taskMethod("tasks/cancel", task.taskId);
        }
        await Promise.race([slowClosed.promise, delay(4_000).then(() => assert.fail("task upstream request leaked"))]);
        const audit = await singleAuditSince(before);
        let state;
        for (let i = 0; i < 15; i++) {
          state = await taskMethod("tasks/get", task.taskId);
          if (state.status !== "working") break;
          await delay(50);
        }
        if (action === "complete") {
          assert.equal(state.status, "completed");
          assert.deepEqual(state.result.structuredContent, { finished: true });
          assert.equal(audit.toolResult.isError, false);
          completedTasks.push(state.result);
        } else {
          assert.equal(state.status, "cancelled");
          assert.equal(audit.toolResult._meta.archestraError.type, "cancelled");
        }
        assert.equal(upstreamCalls - upstreamBefore, 1);
        assert.equal(nativeRemoteCalls - nativeBefore, native ? 1 : 0);
      }
    }
    config.mcpGateway.toolCallTimeoutMs = originalToolTimeout;
    assert.deepEqual(completedTasks[1], completedTasks[0]);

    const oauthResults = [];
    const remoteOrigin = `http://127.0.0.1:${remote.address().port}`;
    for (const native of [false, true]) {
      config.mcpGateway.rustDiscoverEnabled = native;
      const name = `riir-oauth-${Number(native)}`;
      const serverUrl = `${remoteOrigin}/oauth/${name}`;
      const oauth = await InternalMcpCatalogModel.create({
        name, serverType: "remote", serverUrl,
        oauthConfig: { name, server_url: serverUrl, token_endpoint: `${remoteOrigin}/token`,
          client_id: "fixture-client", redirect_uris: ["http://localhost:3000/callback"],
          scopes: [], default_scopes: [], supports_resource_metadata: false },
      }, { organizationId: org, authorId: owner });
      const secret = await secretManager().createSecret({
        access_token: "fixture-stale", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000,
      }, name);
      const installed = await McpServerModel.create({
        name, catalogId: oauth.id, secretId: secret.id, serverType: "remote", ownerId: owner,
      });
      const tool = await ToolModel.createToolIfNotExists({
        name: `${name}__echo`, rawName: "echo", description: "OAuth echo fixture",
        parameters: { type: "object" }, catalogId: oauth.id,
      });
      await AgentToolModel.create(gateway.id, tool.id, { mcpServerId: installed.id });
      const nativeBefore = nativeRemoteCalls;
      const upstreamBefore = upstreamCalls;
      const exchangesBefore = tokenExchanges;
      const response = await post({
        method: "tools/call", status: 200, audit: "tools/call", headers: { "mcp-name": tool.name },
        params: { name: tool.name, arguments: { mode: "oauth" } },
      });
      assert.deepEqual(response.body.result.structuredContent, { mode: "oauth" });
      assert.equal(tokenExchanges - exchangesBefore, 1);
      assert.deepEqual(oauthToolTokens.slice(-2), ["Bearer fixture-stale", "Bearer fixture-fresh"]);
      assert.equal(upstreamCalls - upstreamBefore, 2);
      assert.equal(nativeRemoteCalls - nativeBefore, native ? 2 : 0);
      assert.equal((await secretManager().getSecret(secret.id)).secret.refresh_token, "fixture-rotated");
      oauthResults.push(response);
    }
    assert.deepEqual(oauthResults[1], oauthResults[0]);

    process.env.AWS_ENDPOINT_URL_STS = `${remoteOrigin}/sts`;
    const awsName = "riir-signed";
    const signedCatalog = await InternalMcpCatalogModel.create({
      name: awsName, serverType: "remote", serverUrl: `${remoteOrigin}/signed/mcp`,
      awsIamConfig: { roleArn: "arn:aws:iam::123456789012:role/riir-fixture", region: "us-east-1", service: "execute-api" },
    }, { organizationId: org, authorId: owner });
    const signedInstall = await McpServerModel.create({
      name: awsName, catalogId: signedCatalog.id, serverType: "remote", ownerId: owner,
    });
    const signedTool = await ToolModel.createToolIfNotExists({
      name: `${awsName}__echo`, rawName: "echo", description: "Signed echo fixture",
      parameters: { type: "object" }, catalogId: signedCatalog.id,
    });
    await AgentToolModel.create(gateway.id, signedTool.id, { mcpServerId: signedInstall.id });
    const signedRequest = (mode) => ({
      ...echoRequest(mode), headers: { "mcp-name": signedTool.name },
      params: { name: signedTool.name, arguments: { mode } },
    });
    const signedResults = [];
    for (const native of [false, true]) {
      config.mcpGateway.rustDiscoverEnabled = native;
      const beforeUpstream = upstreamCalls;
      const beforeNative = nativeRemoteCalls;
      const beforeSts = roleAssumptions;
      await post({ ...signedRequest("denied"), credential: denied, status: 403, audit: undefined });
      assert.equal(upstreamCalls, beforeUpstream);
      assert.equal(nativeRemoteCalls, beforeNative);
      assert.equal(roleAssumptions, beforeSts);
      const result = await post(signedRequest("sse"));
      assert.deepEqual(result.body.result.structuredContent, { mode: "sse" });
      signedResults.push(result);
      await cancelRemote(signedRequest("slow"));
      assert.equal(upstreamCalls - beforeUpstream, 2);
      assert.equal(nativeRemoteCalls - beforeNative, native ? 2 : 0);
    }
    assert.deepEqual(signedResults[1], signedResults[0]);
    assert.equal(roleAssumptions, 1);

    function verifySignature(req, body) {
      const parts = /^AWS4-HMAC-SHA256 Credential=ASIAFIXTURE\/(\d{8}\/us-east-1\/execute-api\/aws4_request), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(req.headers.authorization);
      assert.ok(parts, "missing SigV4 authorization");
      const [, scope, signedHeaders, signature] = parts;
      assert.equal(req.headers["x-amz-security-token"], "fixture-session");
      const sha256 = (value) => createHash("sha256").update(value).digest("hex");
      const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
      const headers = signedHeaders.split(";").map((name) =>
        `${name}:${req.headers[name].trim().replace(/\s+/g, " ")}\n`).join("");
      const canonical = [req.method, req.url, "", headers, signedHeaders, sha256(body)].join("\n");
      const stringToSign = ["AWS4-HMAC-SHA256", req.headers["x-amz-date"], scope, sha256(canonical)].join("\n");
      const key = scope.split("/").reduce((key, part) => hmac(key, part), "AWS4fixture-secret");
      assert.equal(signature, hmac(key, stringToSign).toString("hex"));
    }

    await db.update(schema.organizationsTable).set({
      defaultNetworkPolicy: { egressMode: "off", domainPreset: "none", allowedDomains: [], allowedCidrs: [] },
    }).where(eq(schema.organizationsTable.id, org));
    const nativeDenial = await post(echoRequest("egress-denied"));
    config.mcpGateway.rustDiscoverEnabled = false;
    assert.deepEqual(await post(echoRequest("egress-denied")), nativeDenial);
    assert.equal(nativeDenial.body.result.isError, true);
    assert.equal(nativeRemoteCalls, 10);
    assert.equal(upstreamCalls, 20);

    const usageCall = (name) => ({
      method: "tools/call", status: 200, audit: "tools/call",
      headers: { "mcp-name": name }, params: { name, arguments: {} },
    });
    const listTeams = "archestra__list_teams";
    const [ownTeam, hiddenTeam] = await Promise.all([
      TeamModel.create({ name: "Fixture visible", organizationId: org, createdBy: owner }),
      TeamModel.create({ name: "Fixture hidden", organizationId: org, createdBy: member }),
    ]);
    const teamCall = (name) => ({
      ...usageCall(listTeams), params: { name: listTeams, arguments: name ? { name } : {} },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyTeams = await post(teamCall());
    assert.deepEqual(legacyTeams.body.result.structuredContent.teams.map(({ id, memberCount }) =>
      ({ id, memberCount })), [{ id: ownTeam.id, memberCount: 1 }]);
    config.mcpGateway.rustDiscoverEnabled = true;
    await post({ ...teamCall(), credential: denied, status: 403, audit: undefined });
    assert.equal(teamRequests, 0);
    assert.deepEqual(await post(teamCall()), legacyTeams);
    assert.equal(teamRequests, 1);

    const getTeam = "archestra__get_team";
    const teamDetail = (args) => ({ ...usageCall(getTeam), params: { name: getTeam, arguments: args } });
    const beforeDetail = teamRequests;
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyDetail = await post(teamDetail({ id: ownTeam.id }));
    const legacyHidden = await post(teamDetail({ id: hiddenTeam.id }));
    assert.equal(legacyHidden.body.result.isError, true);
    assert.equal(legacyDetail.body.result.structuredContent.team.id, ownTeam.id);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(teamDetail({ id: hiddenTeam.id })), legacyHidden);
    assert.equal(teamRequests, beforeDetail);
    assert.deepEqual(await post(teamDetail({ id: ownTeam.id })), legacyDetail);
    assert.deepEqual(await post(teamDetail({ name: ownTeam.name })), legacyDetail);
    assert.equal(teamRequests, beforeDetail + 2);

    const beforeTeamCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopTeams = new AbortController();
    const teamsCancelled = assert.rejects(call(stopTeams, "riir-team-cancel", listTeams), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native team lookup did not respond"))]);
    } finally {
      stopTeams.abort();
      await teamsCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("team relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeTeamCancel)).toolResult.isError, true);
    assert.equal(teamRequests, 4);
    holdToolReply = undefined;

    const beforeDetailCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopDetail = new AbortController();
    const detailCancelled = assert.rejects(call(stopDetail, "riir-team-detail-cancel", getTeam, { id: ownTeam.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native team detail did not respond"))]);
    } finally {
      stopDetail.abort();
      await detailCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("team detail relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeDetailCancel)).toolResult.isError, true);
    assert.equal(teamRequests, 5);
    holdToolReply = undefined;

    const listMembers = "archestra__list_team_members";
    const membersCall = (id) => ({
      ...usageCall(listMembers), params: { name: listMembers, arguments: { team_id: id } },
    });
    await db.update(schema.usersTable).set({ name: "A fixture member" }).where(eq(schema.usersTable.id, member));
    await TeamModel.addMember(ownTeam.id, member, "member", true);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyMembers = await post(membersCall(ownTeam.id));
    const hiddenMembers = await post(membersCall(hiddenTeam.id));
    assert.equal(hiddenMembers.body.result.isError, true);
    assert.deepEqual(legacyMembers.body.result.structuredContent.members.map(
      ({ userId, syncedFromSso }) => ({ userId, syncedFromSso }),
    ), [{ userId: member, syncedFromSso: true }, { userId: owner, syncedFromSso: false }]);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(membersCall(hiddenTeam.id)), hiddenMembers);
    assert.equal(memberRequests, 0);
    assert.deepEqual(await post(membersCall(ownTeam.id)), legacyMembers);
    assert.equal(memberRequests, 1);

    const beforeMemberCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopMembers = new AbortController();
    const membersCancelled = assert.rejects(call(stopMembers, "riir-members-cancel", listMembers,
      { team_id: ownTeam.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native member lookup did not respond"))]);
    } finally {
      stopMembers.abort();
      await membersCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("member relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeMemberCancel)).toolResult.isError, true);
    assert.equal(memberRequests, 2);
    holdToolReply = undefined;

    const listGroups = "archestra__list_team_external_groups";
    const groupsCall = (id) => ({
      ...usageCall(listGroups), params: { name: listGroups, arguments: { team_id: id } },
    });
    const group = await TeamModel.addExternalGroup({ teamId: ownTeam.id, groupIdentifier: "fixture-group", role: "admin" });
    await TeamModel.addExternalGroup({ teamId: hiddenTeam.id, groupIdentifier: "fixture-hidden" });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyGroups = await post(groupsCall(ownTeam.id));
    const hiddenGroups = await post(groupsCall(hiddenTeam.id));
    assert.equal(hiddenGroups.body.result.isError, true);
    assert.deepEqual(legacyGroups.body.result.structuredContent.externalGroups, [{
      id: group.id, teamId: ownTeam.id, groupIdentifier: "fixture-group",
      identityProviderId: null, role: "admin", createdAt: group.createdAt.toISOString(),
    }]);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(groupsCall(hiddenTeam.id)), hiddenGroups);
    assert.equal(externalGroupRequests, 0);
    assert.deepEqual(await post(groupsCall(ownTeam.id)), legacyGroups);
    assert.equal(externalGroupRequests, 1);

    const beforeGroupCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopGroups = new AbortController();
    const groupsCancelled = assert.rejects(call(stopGroups, "riir-groups-cancel", listGroups,
      { team_id: ownTeam.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native group lookup did not respond"))]);
    } finally {
      stopGroups.abort();
      await groupsCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("group relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeGroupCancel)).toolResult.isError, true);
    assert.equal(externalGroupRequests, 2);
    holdToolReply = undefined;

    const getRun = "archestra__get_schedule_trigger_run";
    const [ownTrigger, hiddenTrigger] = await db.insert(schema.scheduleTriggersTable).values(
      [owner, member].map((actorUserId) => ({
        organizationId: org, name: "Schedule fixture", agentId: gateway.id,
        messageTemplate: "Fixture", cronExpression: "0 * * * *", timezone: "UTC",
        enabled: false, actorUserId,
      })),
    ).returning();
    const started = new Date("2026-01-01T12:34:56.123Z");
    const getSchedule = "archestra__get_schedule_trigger";
    const scheduleCall = (id) => ({
      ...usageCall(getSchedule), params: { name: getSchedule, arguments: { schedule_trigger_id: id } },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacySchedule = await post(scheduleCall(ownTrigger.id));
    assert.deepEqual(legacySchedule.body.result.structuredContent, {
      id: ownTrigger.id, name: ownTrigger.name, agent_id: gateway.id, agent_name: gateway.name,
      project_id: null, cron_expression: ownTrigger.cronExpression, timezone: "UTC", enabled: false,
      last_executed_at: null, actor_user_id: owner, actor_name: "MCP fixture user",
      created_at: ownTrigger.createdAt.toISOString(), message_template: ownTrigger.messageTemplate,
    });
    const legacyHiddenSchedule = await post(scheduleCall(hiddenTrigger.id));
    assert.equal(legacyHiddenSchedule.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(scheduleCall(hiddenTrigger.id)), legacyHiddenSchedule);
    assert.equal(scheduleRequests, 0);
    assert.deepEqual(await post(scheduleCall(ownTrigger.id)), legacySchedule);
    assert.equal(scheduleRequests, 1);

    const beforeScheduleCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopSchedule = new AbortController();
    const scheduleCancelled = assert.rejects(call(stopSchedule, "riir-schedule-cancel", getSchedule,
      { schedule_trigger_id: ownTrigger.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native schedule did not respond"))]);
    } finally {
      stopSchedule.abort();
      await scheduleCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("schedule relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeScheduleCancel)).toolResult.isError, true);
    assert.equal(scheduleRequests, 2);
    holdToolReply = undefined;

    const listSchedules = "archestra__list_schedule_triggers";
    const [ownProject, privateProject] = await Promise.all(
      [owner, member].map((userId, index) => projectService.create({
        organizationId: org, name: `Schedule project fixture ${index}`, userId, description: null,
      })),
    );
    await db.update(schema.scheduleTriggersTable)
      .set({ createdAt: sql`'2026-01-03T00:00:00.123001Z'::timestamptz` })
      .where(eq(schema.scheduleTriggersTable.id, ownTrigger.id));
    const [projectTrigger] = await db.insert(schema.scheduleTriggersTable).values({
      organizationId: org, name: "Project schedule", agentId: gateway.id, projectId: ownProject.id,
      actorUserId: owner, messageTemplate: "Never returned in a list",
      cronExpression: "0 * * * *", timezone: "UTC", enabled: false,
      createdAt: sql`'2026-01-03T00:00:00.123002Z'::timestamptz`,
    }).returning();
    const schedulesCall = (args) => ({ ...usageCall(listSchedules), params: { name: listSchedules, arguments: args } });
    const scheduleArgs = { enabled: false, agent_id: gateway.id, include_all_users: true, limit: 1 };
    config.mcpGateway.rustDiscoverEnabled = false;
    const hiddenProjectSchedules = await post(schedulesCall({ project_id: privateProject.id }));
    assert.equal(hiddenProjectSchedules.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(schedulesCall({ project_id: privateProject.id })), hiddenProjectSchedules);
    assert.equal(schedulePageRequests, 0);

    let scheduleCursor = "malformed-cursor";
    for (const [id, extra] of [[projectTrigger.id, {}], [ownTrigger.id, {}], [projectTrigger.id, { project_id: ownProject.id }]]) {
      const args = { ...scheduleArgs, cursor: extra.project_id ? undefined : scheduleCursor, ...extra };
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(schedulesCall(args));
      config.mcpGateway.rustDiscoverEnabled = true;
      const native = await post(schedulesCall(args));
      assert.deepEqual(native, legacy);
      const { schedule_triggers: rows, pagination } = native.body.result.structuredContent;
      assert.deepEqual(rows.map((row) => row.id), [id]);
      assert.equal(Object.hasOwn(rows[0], "message_template"), false);
      assert.equal(pagination.hasNext, id === projectTrigger.id && !extra.project_id);
      scheduleCursor = pagination.nextCursor;
    }
    assert.equal(schedulePageRequests, 3);
    const beforeSchedulePageCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopSchedulePage = new AbortController();
    const schedulePageCancelled = assert.rejects(call(stopSchedulePage, "riir-schedule-page-cancel",
      listSchedules, scheduleArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native schedule page did not respond"))]);
    } finally {
      stopSchedulePage.abort();
      await schedulePageCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("schedule page relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeSchedulePageCancel)).toolResult.isError, true);
    assert.equal(schedulePageRequests, 4);
    holdToolReply = undefined;

    const getProject = "archestra__get_project";
    const projectCall = (id) => ({
      ...usageCall(getProject), params: { name: getProject, arguments: { project_id: id } },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedProject = await post(projectCall(privateProject.id));
    assert.equal(deniedProject.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(projectCall(privateProject.id)), deniedProject);
    assert.equal(projectRequests, 0);
    const projectAccess = { id: ownProject.id, organizationId: org, userId: owner };
    const content = "# Project fixture\nCite local files.";
    await projectService.setInstructions({ ...projectAccess, content });
    await fileStore.put({
      organizationId: org, userId: owner, projectId: ownProject.id, conversationId: null,
      filename: "spec.md", mimeType: "text/plain", sizeBytes: 4, data: Buffer.from("spec"),
    });
    await ConversationModel.create({
      organizationId: org, userId: owner, projectId: ownProject.id, agentId: gateway.id,
      title: "Project fixture conversation",
    });
    const [visibleApp, hiddenApp] = await Promise.all([owner, member].map((authorId) => AppModel.create({
      app: { organizationId: org, authorId, mcpServerId: installation.id, name: "Fixture project app" },
      payload: { html: "<title>Fixture</title>", uiPermissions: null },
    })));
    await db.insert(schema.projectAppsTable).values([visibleApp, hiddenApp].map((app) => ({
      projectId: ownProject.id, appId: app.id, linkedBy: owner,
    })));
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyProject = await post(projectCall(ownProject.id));
    assert.equal(legacyProject.body.result.isError, false, JSON.stringify(legacyProject.body.result));
    const projectDetail = legacyProject.body.result.structuredContent;
    assert.equal(projectDetail?.conversation_count, 1);
    assert.equal(projectDetail.instructions, content);
    assert.ok(projectDetail.files.some(({ filename }) => filename === "spec.md"));
    assert.deepEqual(projectDetail.apps.map(({ id }) => id), [visibleApp.id]);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(projectCall(ownProject.id)), legacyProject);
    assert.equal(projectRequests, 1);
    const beforeProjectCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopProject = new AbortController();
    const projectCancelled = assert.rejects(call(stopProject, "riir-project-cancel", getProject,
      { project_id: ownProject.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native project did not respond"))]);
    } finally {
      stopProject.abort();
      await projectCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("project relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeProjectCancel)).toolResult.isError, true);
    assert.equal(projectRequests, 2);
    holdToolReply = undefined;

    const linkAppTool = "archestra__link_app_to_project";
    const linkAppCall = (projectId, appId) => ({
      ...usageCall(linkAppTool),
      params: { name: linkAppTool, arguments: { project_id: projectId, app_id: appId } },
    });
    const projectApp = async () => (await db.select().from(schema.projectAppsTable)
      .where(eq(schema.projectAppsTable.projectId, ownProject.id)))
      .filter(({ appId }) => appId === visibleApp.id);
    const unlinkFixture = () => projectService.unlinkApp({ ...projectAccess, appId: visibleApp.id });
    config.mcpGateway.rustDiscoverEnabled = false;
    await unlinkFixture();
    const linkRequest = linkAppCall(ownProject.id, visibleApp.id);
    const legacyLink = await post(linkRequest);
    assert.deepEqual(legacyLink.body.result.structuredContent, {
      project_id: ownProject.id, app_id: visibleApp.id, linked: true,
    });
    const [legacyLinkRow] = await projectApp();
    await unlinkFixture();
    for (const deniedLink of [
      linkAppCall(privateProject.id, visibleApp.id), linkAppCall(ownProject.id, hiddenApp.id),
    ]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacyDenied = await post(deniedLink);
      assert.equal(legacyDenied.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deniedLink), legacyDenied);
    }
    assert.equal(projectLinkRequests, 0);
    assert.deepEqual(await projectApp(), []);
    assert.deepEqual(await post(linkRequest), legacyLink);
    const nativeLinkRows = await projectApp();
    assert.equal(nativeLinkRows.length, 1);
    assert.deepEqual({ ...nativeLinkRows[0], linkedAt: legacyLinkRow.linkedAt }, legacyLinkRow);
    assert.equal(nativeLinkRows[0].linkedBy, owner);
    assert.deepEqual(await post(linkRequest), legacyLink);
    assert.deepEqual(await projectApp(), nativeLinkRows);
    assert.equal(projectLinkRequests, 2);

    const unlinkAppTool = "archestra__unlink_app_from_project";
    const unlinkAppCall = (projectId, appId) => ({
      ...usageCall(unlinkAppTool),
      params: { name: unlinkAppTool, arguments: { project_id: projectId, app_id: appId } },
    });
    const hiddenLinks = () => db.select().from(schema.projectAppsTable)
      .where(eq(schema.projectAppsTable.appId, hiddenApp.id));
    await projectService.linkApp({
      id: privateProject.id, appId: hiddenApp.id, organizationId: org, userId: member,
    });
    const linksBeforeUnlink = await hiddenLinks();
    const ownHiddenLink = linksBeforeUnlink.find(({ projectId }) => projectId === ownProject.id);
    const privateHiddenLink = linksBeforeUnlink.find(({ projectId }) => projectId === privateProject.id);
    const deniedUnlink = unlinkAppCall(privateProject.id, hiddenApp.id);
    const unlinkRequest = unlinkAppCall(ownProject.id, hiddenApp.id);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyUnlinkDenial = await post(deniedUnlink);
    assert.equal(legacyUnlinkDenial.body.result.isError, true);
    const legacyUnlink = await post(unlinkRequest);
    assert.deepEqual(legacyUnlink.body.result.structuredContent, {
      project_id: ownProject.id, app_id: hiddenApp.id, linked: false,
    });
    const legacyMissingLink = await post(unlinkRequest);
    assert.equal(legacyMissingLink.body.result.isError, true);
    assert.deepEqual(await hiddenLinks(), [privateHiddenLink]);
    await db.insert(schema.projectAppsTable).values(ownHiddenLink);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedUnlink), legacyUnlinkDenial);
    assert.equal(projectUnlinkRequests, 0);
    assert.deepEqual(await post(unlinkRequest), legacyUnlink);
    assert.deepEqual(await post(unlinkRequest), legacyMissingLink);
    assert.equal(projectUnlinkRequests, 2);
    assert.deepEqual(await hiddenLinks(), [privateHiddenLink]);
    assert.deepEqual(await projectApp(), nativeLinkRows);
    assert.ok(await AppModel.findByIdInOrg(hiddenApp.id, org));

    const listProjects = "archestra__list_projects";
    const sharedProject = await projectService.create({
      organizationId: org, userId: member, name: "Shared newer project", description: "Fixture 100% coverage",
      initialPermissionGrants: [{ subject: { type: "user", id: owner }, actions: ["read"] }],
    });
    const projectsCall = (args) => ({
      ...usageCall(listProjects), params: { name: listProjects, arguments: args },
    });
    for (const [args, expected] of [
      [{}, [[ownProject.id, "owner", 1], [sharedProject.id, "shared", 0]]],
      [{ query: "  FiXTURE 100%  " }, [[sharedProject.id, "shared", 0]]],
      [{ owner_ids: [member] }, [[sharedProject.id, "shared", 0]]],
      [{ owner_ids: [member], access: ["mine"] }, []],
    ]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(projectsCall(args));
      assert.deepEqual(legacy.body.result.structuredContent?.projects.map(({ id, viewer_role, conversation_count }) =>
        [id, viewer_role, conversation_count]), expected, JSON.stringify(legacy.body));
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(projectsCall(args)), legacy);
    }
    assert.equal(projectListRequests, 3);
    const beforeProjectListCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopProjectList = new AbortController();
    const projectListCancelled = assert.rejects(call(stopProjectList, "riir-project-list-cancel", listProjects), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native project list did not respond"))]);
    } finally {
      stopProjectList.abort();
      await projectListCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("project list relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeProjectListCancel)).toolResult.isError, true);
    assert.equal(projectListRequests, 4);
    holdToolReply = undefined;

    const [ownRun, hiddenRun] = await db.insert(schema.scheduleTriggerRunsTable).values(
      [ownTrigger, hiddenTrigger].map((trigger) => ({
        organizationId: org, triggerId: trigger.id, runKind: "manual", status: "failed",
        startedAt: started, error: "Fixture failure",
      })),
    ).returning();
    const runArgs = { schedule_trigger_id: ownTrigger.id, run_id: ownRun.id };
    const runCall = (args) => ({ ...usageCall(getRun), params: { name: getRun, arguments: args } });
    const deniedRun = runCall({ schedule_trigger_id: hiddenTrigger.id, run_id: hiddenRun.id });
    const wrongTrigger = runCall({ ...runArgs, run_id: hiddenRun.id });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyRun = await post(runCall(runArgs));
    assert.equal(legacyRun.body.result.structuredContent.started_at, started.toISOString());
    assert.equal(legacyRun.body.result.structuredContent.error, ownRun.error);
    const legacyDeniedRun = await post(deniedRun);
    const legacyWrongTrigger = await post(wrongTrigger);
    assert.equal(legacyDeniedRun.body.result.isError, true);
    assert.equal(legacyWrongTrigger.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedRun), legacyDeniedRun);
    assert.equal(runRequests, 0);
    assert.deepEqual(await post(runCall(runArgs)), legacyRun);
    assert.deepEqual(await post(wrongTrigger), legacyWrongTrigger);
    assert.equal(runRequests, 2);

    const beforeRunCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopRun = new AbortController();
    const runCancelled = assert.rejects(call(stopRun, "riir-run-cancel", getRun, runArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native run lookup did not respond"))]);
    } finally {
      stopRun.abort();
      await runCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("run relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeRunCancel)).toolResult.isError, true);
    assert.equal(runRequests, 3);
    holdToolReply = undefined;

    const getTranscript = "archestra__get_schedule_trigger_run_transcript";
    const transcriptCall = (args) => ({
      ...usageCall(getTranscript), params: { name: getTranscript, arguments: args },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedTranscript = transcriptCall({ schedule_trigger_id: hiddenTrigger.id, run_id: hiddenRun.id });
    const wrongRunTranscript = transcriptCall({ ...runArgs, run_id: hiddenRun.id });
    const legacyDeniedTranscript = await post(deniedTranscript);
    const legacyWrongRunTranscript = await post(wrongRunTranscript);
    assert.equal(legacyDeniedTranscript.body.result.isError, true);
    assert.equal(legacyWrongRunTranscript.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedTranscript), legacyDeniedTranscript);
    assert.deepEqual(await post(wrongRunTranscript), legacyWrongRunTranscript);
    assert.equal(transcriptRequests, 0);

    const transcriptPrompt = "Schedule transcript fixture";
    const transcriptAnswer = "Scheduled turn completed.";
    const [ownInteraction] = await db.insert(schema.interactionsTable).values(
      [["schedule-trigger", transcriptAnswer, 1], ["guardrail:annotator", "Internal turn", 2]].map(([source, content, second]) => ({
        profileId: gateway.id, userId: owner, sessionId: `scheduled-${ownRun.id}`,
        type: "openai:chatCompletions", source, model: "gpt-4", cost: "0.0000200000",
        request: { model: "gpt-4", messages: [{ role: "user", content: transcriptPrompt }] },
        response: { id: `fixture-${second}`, object: "chat.completion", created: 1,
          model: "gpt-4", choices: [{ index: 0, message: { role: "assistant", content, refusal: null }, finish_reason: "stop", logprobs: null }] },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
      })),
    ).returning();
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyTranscript = await post(transcriptCall(runArgs));
    const transcriptResult = legacyTranscript.body.result.structuredContent;
    assert.equal(transcriptResult?.source, "interactions");
    assert.deepEqual(transcriptResult.messages, [
      { role: "user", parts: [{ type: "text", text: transcriptPrompt }] },
      { role: "assistant", parts: [{ type: "text", text: transcriptAnswer }] },
    ]);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(transcriptCall(runArgs)), legacyTranscript);
    assert.equal(transcriptRequests, 1);
    assert.equal(condensationRequests, 1);

    const beforeTranscriptCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopTranscript = new AbortController();
    const transcriptCancelled = assert.rejects(call(stopTranscript, "riir-transcript-cancel", getTranscript, runArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native transcript did not respond"))]);
    } finally {
      stopTranscript.abort();
      await transcriptCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("transcript relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeTranscriptCancel)).toolResult.isError, true);
    assert.equal(transcriptRequests, 2);
    holdToolReply = undefined;

    const runConversation = await ConversationModel.create({
      organizationId: org, userId: owner, agentId: gateway.id,
      title: "Transcript redaction fixture", origin: "schedule_trigger",
    });
    await db.update(schema.scheduleTriggerRunsTable).set({ chatConversationId: runConversation.id })
      .where(eq(schema.scheduleTriggerRunsTable.id, ownRun.id));
    const dataSecret = "fixture-oauth-secret";
    const credentials = {
      tool_args: {
        environment: [{ name: "TOKEN", type: "secret", value: "fixture-environment-secret" }],
        imagePullSecrets: [{ registry: "fixture.invalid", password: "fixture-registry-secret" }],
      },
    };
    const longText = `${"x".repeat(3998)}💡after`;
    const addTranscriptMessage = (role, parts) => MessageModel.create({
      conversationId: runConversation.id, role, content: { id: randomUUID(), role, parts },
    });
    await addTranscriptMessage("user", [
      { type: "text", text: "discarded by budget" },
      ...Array.from({ length: 200 }, (_, i) => ({ type: "text", text: `prompt part ${i}` })),
    ]);
    await addTranscriptMessage("assistant", [
      { type: "reasoning", text: "fixture-hidden-reasoning" },
      { type: "step-start" },
      { type: "tool-call", toolName: "run_tool", toolCallId: "fixture-tool", args: JSON.stringify(credentials) },
      { type: "blocked-tool", toolName: "inspect", toolArguments: JSON.stringify({ oauthConfig: { client_secret: dataSecret } }), reason: "denied" },
      { type: "data-probe", data: { oauthConfig: { client_secret: dataSecret } } },
      { type: "data-subagent-tool-call", data: { toolName: "inspect", toolCallId: "child", parentToolCallId: "parent", input: credentials } },
      { type: "text", text: longText },
    ]);
    await addTranscriptMessage("user", [{ type: "text", text: "fixture-post-run-followup" }]);
    const beforeRedactedTranscript = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyRedacted = await post(transcriptCall(runArgs));
    const condensed = legacyRedacted.body.result.structuredContent;
    assert.equal(condensed.source, "conversation");
    assert.equal(condensed.truncated, true);
    assert.equal(condensed.messages.flatMap(({ parts }) => parts).length, 200);
    const assistantParts = condensed.messages[1].parts;
    assert.equal(assistantParts.length, 5);
    assert.equal(JSON.parse(assistantParts[0].input).tool_args.environment[0].value, "[redacted]");
    assert.equal(JSON.parse(assistantParts[0].input).tool_args.imagePullSecrets[0].password, "[redacted]");
    assert.equal(JSON.parse(assistantParts[1].input).oauthConfig.client_secret, "[redacted]");
    assert.equal(JSON.parse(assistantParts[2].output).oauthConfig.client_secret, "[redacted]");
    assert.equal(assistantParts[3].parent_tool_call_id, "parent");
    assert.equal(JSON.parse(assistantParts[3].input).tool_args.environment[0].value, "[redacted]");
    assert.equal(assistantParts[4].text, `${longText.slice(0, 4000)}…`);
    config.mcpGateway.rustDiscoverEnabled = true;
    const nativeRedacted = await post(transcriptCall(runArgs));
    assert.deepEqual(nativeRedacted, legacyRedacted);
    assert.equal(condensationRequests, 2);
    const priorTranscriptAuditIds = new Set(beforeRedactedTranscript.map(({ id }) => id));
    const newTranscriptAudit = (await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id))
      .filter(({ id }) => !priorTranscriptAuditIds.has(id));
    assert.equal(newTranscriptAudit.length, 2);
    for (const secret of [dataSecret, "fixture-environment-secret", "fixture-registry-secret", "fixture-hidden-reasoning", "fixture-post-run-followup"]) {
      assert.equal(JSON.stringify([nativeRedacted, newTranscriptAudit]).includes(secret), false);
    }

    const listRuns = "archestra__list_schedule_trigger_runs";
    await db.update(schema.scheduleTriggerRunsTable)
      .set({ createdAt: sql`'2026-01-02T00:00:00.123001Z'::timestamptz` })
      .where(eq(schema.scheduleTriggerRunsTable.id, ownRun.id));
    const [tieA, tieB] = await db.insert(schema.scheduleTriggerRunsTable).values(
      ["failed", "failed", "running"].map((status) => ({
        organizationId: org, triggerId: ownTrigger.id, runKind: "due", status,
        createdAt: sql`'2026-01-02T00:00:00.123002Z'::timestamptz`,
      })),
    ).returning();
    const pageArgs = { schedule_trigger_id: ownTrigger.id, status: "failed", limit: 1 };
    const pageCall = (args) => ({ ...usageCall(listRuns), params: { name: listRuns, arguments: args } });
    const deniedPage = pageCall({ ...pageArgs, schedule_trigger_id: hiddenTrigger.id });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyDeniedPage = await post(deniedPage);
    assert.equal(legacyDeniedPage.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedPage), legacyDeniedPage);
    assert.equal(runPageRequests, 0);

    let cursor = "not-a-cursor";
    for (const expectedId of [...[tieA.id, tieB.id].sort().reverse(), ownRun.id]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacyPage = await post(pageCall({ ...pageArgs, cursor }));
      config.mcpGateway.rustDiscoverEnabled = true;
      const nativePage = await post(pageCall({ ...pageArgs, cursor }));
      assert.deepEqual(nativePage, legacyPage);
      const { runs, pagination } = nativePage.body.result.structuredContent;
      assert.deepEqual(runs.map(({ id }) => id), [expectedId]);
      assert.equal(pagination.hasNext, expectedId !== ownRun.id);
      cursor = pagination.nextCursor;
    }
    assert.equal(cursor, null);
    assert.equal(runPageRequests, 3);

    const beforePageCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopPage = new AbortController();
    const pageCancelled = assert.rejects(call(stopPage, "riir-run-page-cancel", listRuns, pageArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native run page did not respond"))]);
    } finally {
      stopPage.abort();
      await pageCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("run page relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforePageCancel)).toolResult.isError, true);
    assert.equal(runPageRequests, 4);
    holdToolReply = undefined;

    const getKnowledge = "archestra__get_knowledge_base";
    const [ownKb, hiddenKb] = await Promise.all([owner, member].map((createdBy) =>
      KnowledgeBaseModel.create({ organizationId: org, name: "Fixture knowledge base", createdBy, visibility: "private" }),
    ));
    const knowledgeCall = (id) => ({ ...usageCall(getKnowledge), params: { name: getKnowledge, arguments: { id } } });
    config.mcpGateway.rustDiscoverEnabled = false;
    const hiddenKnowledge = await post(knowledgeCall(hiddenKb.id));
    assert.equal(hiddenKnowledge.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(knowledgeCall(hiddenKb.id)), hiddenKnowledge);
    assert.equal(knowledgeRequests, 0);

    for (const hasUpload of [false, true]) {
      if (hasUpload) {
        const [connector] = await db.insert(schema.knowledgeBaseConnectorsTable).values({
          organizationId: org, name: "Fixture uploads", connectorType: "file_upload", config: {},
        }).returning();
        await db.insert(schema.kbUploadConnectorsTable).values({ knowledgeBaseId: ownKb.id, connectorId: connector.id });
      }
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(knowledgeCall(ownKb.id));
      const base = legacy.body.result.structuredContent.knowledgeBase;
      assert.equal(base.id, ownKb.id);
      const details = JSON.parse(legacy.body.result.content[0].text);
      assert.equal(Object.hasOwn(details, "uploadedFilesEnvironmentId"), hasUpload);
      if (hasUpload) assert.equal(details.uploadedFilesEnvironmentId, null);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(knowledgeCall(ownKb.id)), legacy);
    }
    assert.equal(knowledgeRequests, 2);
    const beforeKnowledgeCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopKnowledge = new AbortController();
    const knowledgeCancelled = assert.rejects(call(stopKnowledge, "riir-kb-cancel", getKnowledge,
      { id: ownKb.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native knowledge lookup did not respond"))]);
    } finally {
      stopKnowledge.abort();
      await knowledgeCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("knowledge relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeKnowledgeCancel)).toolResult.isError, true);
    assert.equal(knowledgeRequests, 3);
    holdToolReply = undefined;

    const listKnowledge = "archestra__get_knowledge_bases";
    const publishedKb = await KnowledgeBaseModel.create({
      organizationId: org, name: "Published fixture knowledge base", createdBy: member,
    }, { publishToOrganization: true });
    await db.update(schema.knowledgeBasesTable).set({ createdAt: new Date("2026-01-01T00:00:00.123Z") })
      .where(eq(schema.knowledgeBasesTable.id, ownKb.id));
    const knowledgeList = (args) => ({
      ...usageCall(listKnowledge), params: { name: listKnowledge, arguments: args },
    });
    for (const [args, expected] of [
      [{}, [publishedKb.id, ownKb.id]],
      [{ access: ["mine"] }, [ownKb.id]],
      [{ owner_ids: [member], access: ["mine"] }, []],
    ]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(knowledgeList(args));
      assert.deepEqual(legacy.body.result.structuredContent.knowledgeBases.map(({ id }) => id), expected);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(knowledgeList(args)), legacy);
    }
    assert.equal(knowledgeListRequests, 2, "an empty authorized set should not dispatch");
    const beforeKnowledgeListCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopKnowledgeList = new AbortController();
    const knowledgeListCancelled = assert.rejects(call(stopKnowledgeList, "riir-kb-list-cancel", listKnowledge), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native knowledge list did not respond"))]);
    } finally {
      stopKnowledgeList.abort();
      await knowledgeListCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("knowledge list relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeKnowledgeListCancel)).toolResult.isError, true);
    assert.equal(knowledgeListRequests, 3);
    holdToolReply = undefined;

    const getConnector = "archestra__get_knowledge_connector";
    const [otherEnvironment] = await db.insert(schema.environmentsTable).values({
      organizationId: org, name: "Separate connector environment",
    }).returning();
    const createConnector = (createdBy, environmentId = null) => KnowledgeBaseConnectorModel.create({
      organizationId: org, name: "Fixture Jira connector", createdBy, environmentId,
      connectorType: "jira",
      config: { type: "jira", jiraBaseUrl: "https://fixture.example.invalid", isCloud: true, projectKey: "FIXTURE" },
      lastSyncAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const [ownConnector, hiddenConnector, otherConnector] = await Promise.all([
      createConnector(owner), createConnector(member), createConnector(owner, otherEnvironment.id),
    ]);
    const connectorCall = (id) => ({
      ...usageCall(getConnector), params: { name: getConnector, arguments: { id } },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const uppercaseConnectorId = ownConnector.id.toUpperCase();
    const legacyConnector = await post(connectorCall(uppercaseConnectorId));
    const connectorDetails = JSON.parse(legacyConnector.body.result.content[0].text);
    assert.deepEqual(connectorDetails.config, ownConnector.config);
    assert.equal(connectorDetails.lastSyncAt, ownConnector.lastSyncAt.toISOString());
    const unauthorizedConnector = await post(connectorCall(hiddenConnector.id));
    const isolatedConnector = await post(connectorCall(otherConnector.id));
    assert.equal(unauthorizedConnector.body.result.isError, true);
    assert.equal(isolatedConnector.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(connectorCall(hiddenConnector.id)), unauthorizedConnector);
    assert.equal(connectorRequests, 0);
    assert.deepEqual(await post(connectorCall(otherConnector.id)), isolatedConnector);
    assert.deepEqual(await post(connectorCall(uppercaseConnectorId)), legacyConnector);
    assert.equal(connectorRequests, 2);

    const beforeConnectorCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopConnector = new AbortController();
    const connectorCancelled = assert.rejects(call(stopConnector, "riir-connector-cancel", getConnector,
      { id: ownConnector.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native connector did not respond"))]);
    } finally {
      stopConnector.abort();
      await connectorCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("connector relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeConnectorCancel)).toolResult.isError, true);
    assert.equal(connectorRequests, 3);
    holdToolReply = undefined;

    const listConnectors = "archestra__get_knowledge_connectors";
    const secondConnector = await createConnector(owner);
    await db.update(schema.knowledgeBaseConnectorsTable)
      .set({ createdAt: sql`'2026-01-01T00:00:00.123456'::timestamp` })
      .where(sql`${schema.knowledgeBaseConnectorsTable.id} in (${ownConnector.id}, ${secondConnector.id})`);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyConnectorList = await post(usageCall(listConnectors));
    const listedIds = legacyConnectorList.body.result.structuredContent.knowledgeConnectors.map(({ id }) => id);
    assert.deepEqual(listedIds, [ownConnector.id, secondConnector.id].sort().reverse());
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(usageCall(listConnectors)), legacyConnectorList);
    assert.equal(connectorListRequests, 1);

    const beforeConnectorListCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopConnectorList = new AbortController();
    const connectorListCancelled = assert.rejects(
      call(stopConnectorList, "riir-connector-list-cancel", listConnectors),
      { name: "AbortError" },
    );
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native connector list did not respond"))]);
    } finally {
      stopConnectorList.abort();
      await connectorListCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("connector list relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeConnectorListCancel)).toolResult.isError, true);
    assert.equal(connectorListRequests, 2);
    holdToolReply = undefined;

    const listHooks = "archestra__list_hooks";
    config.hooks.enabled = true;
    const [ownAgent, privateAgent] = await Promise.all([owner, member].map((creator) =>
      AgentModel.create({ organizationId: org, agentType: "agent", name: creator === owner ? "Hook fixture" : "Private hook fixture",
        systemPrompt: "Scoped agent detail fixture",
      }, creator, { skipCreationDefaultTools: true }),
    ));
    await AgentToolModel.create(ownAgent.id, echo.id, { mcpServerId: installation.id });
    const getAgent = "archestra__get_agent";
    const agentCall = (args) => ({ ...usageCall(getAgent), params: { name: getAgent, arguments: args } });
    for (const args of [{ id: privateAgent.id }, { id: gateway.id }]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const rejected = await post(agentCall(args));
      assert.equal(rejected.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(agentCall(args)), rejected);
    }
    assert.equal(agentDetailRequests, 0);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyAgent = await post(agentCall({ id: ownAgent.id }));
    assert.equal(legacyAgent.body.result.structuredContent?.id, ownAgent.id, JSON.stringify(legacyAgent.body));
    assert.equal(legacyAgent.body.result.structuredContent.systemPrompt, ownAgent.systemPrompt);
    assert.ok(legacyAgent.body.result.structuredContent.tools.some(({ id }) => id === echo.id));
    const legacyAgentByName = await post(agentCall({name: ownAgent.name}));
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(agentCall({ id: ownAgent.id })), legacyAgent);
    assert.deepEqual(await post(agentCall({ name: ownAgent.name })), legacyAgentByName);
    assert.equal(agentDetailRequests, 1);
    assert.equal(agentNameRequests, 1);
    const beforeAgentDetailCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopAgentDetail = new AbortController();
    const agentDetailCancelled = assert.rejects(call(stopAgentDetail, "riir-agent-detail-cancel", getAgent, { id: ownAgent.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native agent detail did not respond"))]);
    } finally {
      stopAgentDetail.abort();
      await agentDetailCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("agent detail relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeAgentDetailCancel)).toolResult.isError, true);
    assert.equal(agentDetailRequests, 2);
    holdToolReply = undefined;

    const getGateway = "archestra__get_mcp_gateway";
    const [ownGateway, hiddenGateway] = await Promise.all([owner, member].map((creator) =>
      AgentModel.create({
        organizationId: org, agentType: "mcp_gateway",
        name: creator === owner ? "Scoped gateway detail fixture" : "Hidden gateway detail fixture",
        description: "Gateway with an assigned fixture tool",
      }, creator, { skipCreationDefaultTools: true }),
    ));
    await AgentToolModel.create(ownGateway.id, echo.id, { mcpServerId: installation.id });
    const gatewayCall = (id) => ({
      ...usageCall(getGateway), params: { name: getGateway, arguments: { id } },
    });
    const beforeGatewayDispatch = agentDetailRequests;
    for (const id of [hiddenGateway.id, ownAgent.id]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacyDenial = await post(gatewayCall(id));
      assert.equal(legacyDenial.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(gatewayCall(id)), legacyDenial);
    }
    assert.equal(agentDetailRequests, beforeGatewayDispatch);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyGateway = await post(gatewayCall(ownGateway.id));
    const gatewayDetail = legacyGateway.body.result.structuredContent;
    assert.equal(gatewayDetail?.id, ownGateway.id, JSON.stringify(legacyGateway.body));
    assert.equal(gatewayDetail.agentType, "mcp_gateway");
    assert.deepEqual(gatewayDetail.tools.map(({ id }) => id), [echo.id]);
    config.mcpGateway.rustDiscoverEnabled = true;
    const beforeGatewaySuccess = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    assert.deepEqual(await post(gatewayCall(ownGateway.id)), legacyGateway);
    assert.equal((await singleAuditSince(beforeGatewaySuccess)).toolResult.isError, false);
    assert.equal(agentDetailRequests, beforeGatewayDispatch + 1);

    const beforeGatewayCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopGateway = new AbortController();
    const gatewayCancelled = assert.rejects(call(stopGateway, "riir-gateway-detail-cancel", getGateway,
      { id: ownGateway.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native gateway detail did not respond"))]);
    } finally {
      stopGateway.abort();
      await gatewayCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("gateway detail relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeGatewayCancel)).toolResult.isError, true);
    assert.equal(agentDetailRequests, beforeGatewayDispatch + 2);
    holdToolReply = undefined;

    const rankedNames = ["Ranking 100% alpha", "Ranking 100% beta", "Ranking 100% shared", "Ranking 1000 impostor"];
    const [oldA, oldB] = await Promise.all(rankedNames.map((name, index) =>
      AgentModel.create({
        organizationId: org, agentType: "agent", name,
        createdAt: new Date(index < 2 ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z"),
      }, index === 2 ? member : owner, {
        publishToOrganization: index === 2, skipCreationDefaultTools: true,
      }),
    ));
    const rankArgs = { name: "rAnKiNg 100%" };
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyRankedAgent = await post(agentCall(rankArgs));
    assert.equal(legacyRankedAgent.body.result.structuredContent?.id, [oldA.id, oldB.id].sort().at(-1));
    const deniedAgentName = await post(agentCall({ name: privateAgent.name }));
    assert.equal(deniedAgentName.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(agentCall({ name: privateAgent.name })), deniedAgentName);
    assert.equal(agentNameRequests, 1);
    assert.deepEqual(await post(agentCall(rankArgs)), legacyRankedAgent);
    assert.equal(agentNameRequests, 2);

    const beforeAgentNameCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopAgentName = new AbortController();
    const agentNameCancelled = assert.rejects(call(stopAgentName, "riir-agent-name-cancel", getAgent, rankArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native agent name lookup did not respond"))]);
    } finally {
      stopAgentName.abort();
      await agentNameCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("agent name relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeAgentNameCancel)).toolResult.isError, true);
    assert.equal(agentNameRequests, 3);
    holdToolReply = undefined;

    const [, newerGateway, sharedGateway] = await Promise.all(
      ["Gateway 100% older", "Gateway 100% newer", "Gateway 100% shared", "Gateway 1000 impostor"].map((name, index) => AgentModel.create({
        organizationId: org, agentType: "mcp_gateway", name,
        createdAt: new Date(`2026-01-0${index + 1}T00:00:00Z`),
      }, index === 2 ? member : owner, {
        publishToOrganization: index === 2, skipCreationDefaultTools: true,
      })),
    );
    await AgentToolModel.create(newerGateway.id, echo.id, { mcpServerId: installation.id });
    const gatewayNameCall = (name) => ({
      ...usageCall(getGateway), params: { name: getGateway, arguments: { name } },
    });
    const gatewayPattern = "gAtEwAy 100%";
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyGatewayByName = await post(gatewayNameCall(gatewayPattern));
    const namedGateway = legacyGatewayByName.body.result.structuredContent;
    assert.equal(namedGateway?.id, newerGateway.id, JSON.stringify(legacyGatewayByName.body));
    assert.deepEqual(namedGateway.tools.map(({ id }) => id), [echo.id]);
    // Verify the newer shared gateway is a readable candidate, not a hidden row.
    assert.equal((await post(gatewayNameCall(sharedGateway.name))).body.result.structuredContent?.id, sharedGateway.id);
    const deniedGatewayName = await post(gatewayNameCall(hiddenGateway.name));
    assert.equal(deniedGatewayName.body.result.isError, true);
    const wrongTypeName = await post(gatewayNameCall(ownAgent.name));
    assert.equal(wrongTypeName.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    const beforeGatewayNameDispatch = agentNameRequests;
    assert.deepEqual(await post(gatewayNameCall(hiddenGateway.name)), deniedGatewayName);
    assert.deepEqual(await post(gatewayNameCall(ownAgent.name)), wrongTypeName);
    assert.equal(agentNameRequests, beforeGatewayNameDispatch);
    assert.deepEqual(await post(gatewayNameCall(gatewayPattern)), legacyGatewayByName);
    assert.equal(agentNameRequests, beforeGatewayNameDispatch + 1);

    const beforeGatewayNameCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopGatewayName = new AbortController();
    const gatewayNameCancelled = assert.rejects(call(stopGatewayName, "riir-gateway-name-cancel", getGateway,
      { name: gatewayPattern }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native gateway name lookup did not respond"))]);
    } finally {
      stopGatewayName.abort();
      await gatewayNameCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("gateway name relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeGatewayNameCancel)).toolResult.isError, true);
    assert.equal(agentNameRequests, beforeGatewayNameDispatch + 2);
    holdToolReply = undefined;

    const createGateway = "archestra__create_mcp_gateway";
    const createArgs = {
      name: "Native gateway write fixture",
      labels: [{ key: "fixture", value: "first" }, { key: "fixture", value: "gateway" }],
      knowledgeBaseIds: [ownKb.id, ownKb.id],
      connectorIds: [ownConnector.id, ownConnector.id],
      initialGrants: [{ subject: { type: "user", id: member }, actions: ["read"] }],
      toolExposureMode: "full",
      accessAllTools: true,
      accessAllSubagents: true,
      subagentLoadBalancing: { enabled: true, algorithm: "round_robin", retries: 2 },
    };
    const gatewayCreateCall = (args) => ({
      ...usageCall(createGateway), params: { name: createGateway, arguments: args },
    });
    const gatewayRows = (name) => db.select().from(schema.agentsTable).where(eq(schema.agentsTable.name, name));
    const gatewayPolicy = (id) => ResourcePermissionPolicyModel.find({ organizationId: org, resource: "mcpGateway", scope: id });
    const gatewayExclusions = async (id) => (await db.select({ toolId: schema.agentExcludedToolsTable.toolId })
      .from(schema.agentExcludedToolsTable).where(eq(schema.agentExcludedToolsTable.agentId, id))
      .orderBy(schema.agentExcludedToolsTable.toolId)).map(({ toolId }) => toolId);
    const gatewayVersions = (id) => db.select({
      version: schema.agentVersionsTable.version,
      snapshot: schema.agentVersionsTable.snapshot,
      contentHash: schema.agentVersionsTable.contentHash,
    }).from(schema.agentVersionsTable).where(eq(schema.agentVersionsTable.agentId, id))
      .orderBy(schema.agentVersionsTable.version);
    const builtinCatalog = await db.select({ id: schema.toolsTable.id, name: schema.toolsTable.name })
      .from(schema.toolsTable).where(eq(schema.toolsTable.catalogId, ARCHESTRA_MCP_CATALOG_ID));
    const builtinIds = new Map(builtinCatalog.map(({ id, name }) => [name, id]));
    const skillToolIds = new Set(SKILL_ARCHESTRA_TOOL_SHORT_NAMES.map((name) => builtinIds.get(`archestra__${name}`)));
    assert.ok(!skillToolIds.has(undefined));
    const setGatewayFixtureSkillTools = (skillToolsEnabled) => db.update(schema.organizationsTable)
      .set({ skillToolsEnabled }).where(eq(schema.organizationsTable.id, org));
    const persistedGateway = async (row) => {
      const [detail, policy, assignments, exclusions] = await Promise.all([
        AgentModel.findById(row.id), gatewayPolicy(row.id),
        db.select({
          toolId: schema.agentToolsTable.toolId,
          credentialResolutionMode: schema.agentToolsTable.credentialResolutionMode,
          mcpServerId: schema.agentToolsTable.mcpServerId,
        }).from(schema.agentToolsTable).where(eq(schema.agentToolsTable.agentId, row.id)).orderBy(schema.agentToolsTable.toolId),
        gatewayExclusions(row.id),
      ]);
      return {
        organizationId: row.organizationId, authorId: row.authorId, type: row.agentType,
        environmentId: row.environmentId, exposure: row.toolExposureMode,
        allTools: row.accessAllTools, allSubagents: row.accessAllSubagents, loadBalancing: row.subagentLoadBalancing,
        version: row.latestVersion, grants: policy.grants, migrated: policy.legacySharingMigrated,
        labels: detail.labels.map(({ key, value }) => ({ key, value })),
        knowledgeBaseIds: detail.knowledgeBaseIds.sort(), connectorIds: detail.connectorIds.sort(),
        assignments, exclusions,
      };
    };
    const deniedCreateArgs = {
      ...createArgs, name: "Denied native gateway fixture",
      initialGrants: [{ subject: { type: "user", id: randomUUID() }, actions: ["read"] }],
    };
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyCreateDenial = await post(gatewayCreateCall(deniedCreateArgs));
    assert.equal(legacyCreateDenial.body.result.isError, true);
    const deniedKnowledgeArgs = { ...createArgs, name: "Hidden gateway knowledge fixture", knowledgeBaseIds: [hiddenKb.id] };
    const deniedKnowledge = await post(gatewayCreateCall(deniedKnowledgeArgs));
    assert.equal(deniedKnowledge.body.result.isError, true);
    const [{ skillToolsEnabled: previousSkillToolsEnabled }] = await db.select({ skillToolsEnabled: schema.organizationsTable.skillToolsEnabled })
      .from(schema.organizationsTable).where(eq(schema.organizationsTable.id, org));
    await setGatewayFixtureSkillTools(true);
    const legacyCreate = await post(gatewayCreateCall(createArgs));
    assert.notEqual(legacyCreate.body.result.isError, true, JSON.stringify(legacyCreate.body));
    const [legacyCreated] = await gatewayRows(createArgs.name);
    const expectedGateway = await persistedGateway(legacyCreated);
    const expectedVersions = await gatewayVersions(legacyCreated.id);
    assert.equal(expectedGateway.version, 1);
    assert.equal(expectedGateway.allTools, true);
    assert.equal(expectedGateway.exposure, "search_and_run_only");
    assert.ok(expectedGateway.exclusions.includes(builtinIds.get("archestra__whoami")));
    assert.ok(!expectedGateway.exclusions.includes(builtinIds.get("archestra__search_tools")));
    assert.ok(expectedGateway.assignments.every(({ toolId }) => !expectedGateway.exclusions.includes(toolId)));
    assert.deepEqual(expectedVersions.map(({ version }) => version), [1]);
    assert.equal(expectedGateway.authorId, owner);
    assert.equal(expectedGateway.migrated, true);
    assert.ok(expectedGateway.grants.some(({ subject }) => subject.id === owner));
    assert.ok(expectedGateway.grants.some(({ subject }) => subject.id === member));
    assert.deepEqual(expectedGateway.labels, [{ key: "fixture", value: "gateway" }]);
    assert.deepEqual(expectedGateway.knowledgeBaseIds, [ownKb.id]);
    assert.deepEqual(expectedGateway.connectorIds, [ownConnector.id]);
    for (const tool of ["todo_write", "query_knowledge_sources", "list_apps", "search_files", "list_skills"]) {
      const id = builtinIds.get(`archestra__${tool}`);
      assert.ok(id);
      assert.ok(expectedGateway.assignments.some(({ toolId }) => toolId === id), tool);
    }
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(gatewayCreateCall(deniedCreateArgs)), legacyCreateDenial);
    assert.deepEqual(await post(gatewayCreateCall(deniedKnowledgeArgs)), deniedKnowledge);
    assert.equal(gatewayWriteRequests, 0);
    assert.deepEqual(await gatewayRows(deniedCreateArgs.name), []);
    assert.deepEqual(await gatewayRows(deniedKnowledgeArgs.name), []);
    const nativeCreate = await post(gatewayCreateCall(createArgs));
    const createdRows = await gatewayRows(createArgs.name);
    assert.equal(createdRows.length, 2, JSON.stringify(nativeCreate.body));
    const nativeCreated = createdRows.find(({ id }) => id !== legacyCreated.id);
    assert.deepEqual(await persistedGateway(nativeCreated), expectedGateway);
    assert.deepEqual(await gatewayVersions(nativeCreated.id), expectedVersions);
    assert.notEqual(nativeCreated.slug, legacyCreated.slug);
    assert.equal(JSON.stringify(nativeCreate).replaceAll(nativeCreated.id, legacyCreated.id), JSON.stringify(legacyCreate));
    assert.equal(gatewayWriteRequests, 1);
    assert.equal(gatewayVersionRequests, 1);
    assert.equal(gatewayAllToolsRequests, 1);

    const nativeOnlyLabel = { key: "rust-create-fixture", value: "rust-create-value" };
    const cancelCreate = { ...createArgs, name: "Cancelled native gateway fixture", labels: [nativeOnlyLabel] };
    await setGatewayFixtureSkillTools(false);
    const expectedCancelledAssignments = expectedGateway.assignments.filter(({ toolId }) => !skillToolIds.has(toolId));
    assert.ok(expectedCancelledAssignments.length < expectedGateway.assignments.length);
    const beforeCreateCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    const writeHold = { received: Promise.withResolvers(), release: Promise.withResolvers(), closed: Promise.withResolvers() };
    const versionHold = { received: Promise.withResolvers(), release: Promise.withResolvers(), closed: Promise.withResolvers() };
    holdGatewayWrite = writeHold;
    holdGatewayVersion = versionHold;
    const stopGatewayWrite = new AbortController();
    const rejectedWrite = assert.rejects(call(stopGatewayWrite, "riir-gateway-create-cancel", createGateway, cancelCreate), { name: "AbortError" });
    try {
      assert.equal(await Promise.race([writeHold.received.promise, delay(4_000).then(() => assert.fail("native gateway write did not respond"))]), 200);
      const [committed] = await gatewayRows(cancelCreate.name);
      const committedGateway = await persistedGateway(committed);
      assert.deepEqual(committedGateway.grants, expectedGateway.grants);
      assert.deepEqual(committedGateway.labels, [nativeOnlyLabel]);
      assert.deepEqual(committedGateway.knowledgeBaseIds, expectedGateway.knowledgeBaseIds);
      assert.deepEqual(committedGateway.connectorIds, expectedGateway.connectorIds);
      assert.deepEqual(committedGateway.assignments, expectedCancelledAssignments);
      assert.equal(committedGateway.allTools, false);
      assert.deepEqual(committedGateway.exclusions, []);
      writeHold.release.resolve();
      assert.equal(await Promise.race([versionHold.received.promise, delay(4_000).then(() => assert.fail("native gateway version did not respond"))]), 200);
      const [version] = await gatewayVersions(committed.id);
      assert.equal(version?.version, 1);
      assert.deepEqual(version.snapshot, {
        ...expectedVersions[0].snapshot,
        name: cancelCreate.name,
        tools: expectedVersions[0].snapshot.tools.filter(({ toolId }) => !skillToolIds.has(toolId)),
      });
      stopGatewayWrite.abort();
      await rejectedWrite;
    } finally {
      stopGatewayWrite.abort();
      writeHold.release.resolve();
      versionHold.release.resolve();
      holdGatewayWrite = undefined;
      holdGatewayVersion = undefined;
    }
    await writeHold.closed.promise;
    await versionHold.closed.promise;
    assert.notEqual((await singleAuditSince(beforeCreateCancel)).toolResult.isError, true);
    const cancelledRows = await gatewayRows(cancelCreate.name);
    assert.equal(cancelledRows.length, 1);
    assert.deepEqual(await persistedGateway(cancelledRows[0]), {
      ...expectedGateway, labels: [nativeOnlyLabel], assignments: expectedCancelledAssignments,
    });
    assert.equal(gatewayWriteRequests, 2);
    assert.equal(gatewayVersionRequests, 2);
    assert.equal(gatewayAllToolsRequests, 2);
    assert.equal((await gatewayVersions(cancelledRows[0].id)).length, 1);
    await setGatewayFixtureSkillTools(previousSkillToolsEnabled);

    const rejectedVersionArgs = { ...createArgs, name: "Reject native gateway version fixture" };
    await db.execute(sql`ALTER TABLE agent_versions ADD CONSTRAINT riir_reject_gateway_version
      CHECK (snapshot ->> 'name' IS DISTINCT FROM 'Reject native gateway version fixture') NOT VALID`);
    try {
      const result = await post(gatewayCreateCall(rejectedVersionArgs));
      assert.notEqual(result.body.result.isError, true, JSON.stringify(result.body));
      const [createdWithoutVersion] = await gatewayRows(rejectedVersionArgs.name);
      assert.equal(createdWithoutVersion.latestVersion, 0);
      assert.deepEqual(await gatewayVersions(createdWithoutVersion.id), []);
      assert.deepEqual((await gatewayPolicy(createdWithoutVersion.id)).grants, expectedGateway.grants);
      assert.equal(gatewayWriteRequests, 3);
      assert.equal(gatewayVersionRequests, 3);
      assert.equal(gatewayAllToolsRequests, 3);
    } finally {
      await db.execute(sql`ALTER TABLE agent_versions DROP CONSTRAINT riir_reject_gateway_version`);
    }

    const rejectPrefillArgs = { ...createArgs, name: "Reject gateway All-tools prefill fixture" };
    await db.execute(sql`ALTER TABLE agent_excluded_tools ADD CONSTRAINT riir_reject_gateway_prefill CHECK (false) NOT VALID`);
    try {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacyFailure = await post(gatewayCreateCall(rejectPrefillArgs));
      assert.equal(legacyFailure.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(gatewayCreateCall(rejectPrefillArgs)), legacyFailure);
      const failedRows = await gatewayRows(rejectPrefillArgs.name);
      assert.equal(failedRows.length, 2);
      for (const row of failedRows) {
        assert.equal(row.accessAllTools, false);
        assert.equal(row.latestVersion, 0);
        assert.deepEqual(await gatewayExclusions(row.id), []);
        assert.deepEqual((await gatewayPolicy(row.id)).grants, expectedGateway.grants);
      }
      assert.equal(gatewayWriteRequests, 4);
      assert.equal(gatewayAllToolsRequests, 4);
      assert.equal(gatewayVersionRequests, 3);
    } finally {
      await db.execute(sql`ALTER TABLE agent_excluded_tools DROP CONSTRAINT riir_reject_gateway_prefill`);
    }

    const editGateway = "archestra__edit_mcp_gateway";
    const editGatewayCall = (id) => ({
      ...usageCall(editGateway),
      params: { name: editGateway, arguments: {
        id, name: "Edited gateway parity fixture", description: null, icon: null,
        accessAllTools: true, toolExposureMode: "full", subagentLoadBalancing: null,
        labels: [{ key: "fixture", value: "edited" }], knowledgeBaseIds: [ownKb.id], connectorIds: [ownConnector.id],
      } },
    });
    const [legacyEditTarget, nativeEditTarget] = await Promise.all(["legacy", "native"].map((variant) =>
      AgentModel.create({
        organizationId: org, agentType: "mcp_gateway", name: `Gateway edit ${variant} fixture`,
        description: "Clear on edit", icon: "📝", accessAllSubagents: true,
        subagentLoadBalancing: { enabled: true, algorithm: "round_robin", retries: 2 },
      }, owner, { skipCreationDefaultTools: true }),
    ));
    const storedGateway = async (id) => {
      const [row] = await db.select().from(schema.agentsTable).where(eq(schema.agentsTable.id, id));
      return row;
    };
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyEditDenial = await post(editGatewayCall(hiddenGateway.id));
    assert.equal(legacyEditDenial.body.result.isError, true);
    const legacyEdit = await post(editGatewayCall(legacyEditTarget.id));
    assert.notEqual(legacyEdit.body.result.isError, true, JSON.stringify(legacyEdit.body));
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(editGatewayCall(hiddenGateway.id)), legacyEditDenial);
    assert.equal(gatewayEditRequests, 0);
    assert.equal(gatewayAssignmentEditRequests, 0);
    assert.equal((await storedGateway(hiddenGateway.id)).name, hiddenGateway.name);
    const nativeEdit = await post(editGatewayCall(nativeEditTarget.id));
    assert.equal(JSON.stringify(nativeEdit).replaceAll(nativeEditTarget.id, legacyEditTarget.id), JSON.stringify(legacyEdit));
    const edited = await storedGateway(nativeEditTarget.id);
    assert.equal(edited.slug, nativeEditTarget.slug);
    assert.equal(edited.description, null);
    assert.equal(edited.icon, null);
    assert.equal(edited.subagentLoadBalancing, null);
    assert.equal(edited.accessAllSubagents, true);
    assert.equal(edited.accessAllTools, true);
    assert.equal(edited.toolExposureMode, "search_and_run_only");
    assert.deepEqual(await persistedGateway(edited), await persistedGateway(await storedGateway(legacyEditTarget.id)));
    const editedVersions = await gatewayVersions(edited.id);
    assert.equal(editedVersions.length, 2);
    assert.deepEqual(editedVersions.find(({ version }) => version === 2),
      (await gatewayVersions(legacyEditTarget.id)).find(({ version }) => version === 2));
    assert.equal(gatewayEditRequests, 1);
    assert.equal(gatewayAssignmentEditRequests, 1);

    const gatewayRelationshipCall = (id, fields) => ({
      ...usageCall(editGateway), params: { name: editGateway, arguments: { id, ...fields } },
    });
    const bothGatewayEdits = async (fields) => {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(gatewayRelationshipCall(legacyEditTarget.id, fields));
      assert.notEqual(legacy.body.result.isError, true, JSON.stringify(legacy.body));
      config.mcpGateway.rustDiscoverEnabled = true;
      const native = await post(gatewayRelationshipCall(nativeEditTarget.id, fields));
      assert.equal(JSON.stringify(native).replaceAll(nativeEditTarget.id, legacyEditTarget.id), JSON.stringify(legacy));
      const stored = await persistedGateway(await storedGateway(nativeEditTarget.id));
      assert.deepEqual(stored, await persistedGateway(await storedGateway(legacyEditTarget.id)));
      return stored;
    };
    const untouched = await bothGatewayEdits({ description: "Only change gateway settings" });
    assert.deepEqual(untouched.labels, [{ key: "fixture", value: "edited" }]);
    assert.deepEqual(untouched.knowledgeBaseIds, [ownKb.id]);
    assert.deepEqual(untouched.connectorIds, [ownConnector.id]);
    assert.equal(gatewayAssignmentEditRequests, 1);
    const clearedLabel = await bothGatewayEdits({ labels: [] });
    assert.deepEqual(clearedLabel.labels, []);
    assert.deepEqual(clearedLabel.knowledgeBaseIds, [ownKb.id]);
    assert.deepEqual(clearedLabel.connectorIds, [ownConnector.id]);
    const replaced = await bothGatewayEdits({
      labels: [{ key: "replacement", value: "first" }, { key: "replacement", value: "last" }],
      knowledgeBaseIds: [publishedKb.id, publishedKb.id],
      connectorIds: [otherConnector.id, otherConnector.id],
    });
    assert.deepEqual(replaced.labels, [{ key: "replacement", value: "last" }]);
    assert.deepEqual(replaced.knowledgeBaseIds, [publishedKb.id]);
    assert.deepEqual(replaced.connectorIds, [otherConnector.id]);
    const clearedSources = await bothGatewayEdits({ knowledgeBaseIds: [], connectorIds: [] });
    assert.deepEqual(clearedSources.labels, replaced.labels);
    assert.deepEqual(clearedSources.knowledgeBaseIds, []);
    assert.deepEqual(clearedSources.connectorIds, []);
    assert.equal(gatewayEditRequests, 2);
    assert.equal(gatewayAssignmentEditRequests, 4);
    const versionHistory = await gatewayVersions(nativeEditTarget.id);
    assert.deepEqual(versionHistory.slice(1), (await gatewayVersions(legacyEditTarget.id)).slice(1));
    assert.deepEqual(versionHistory.map(({ version }) => version), [1, 2, 3, 4, 5]);
    assert.equal(gatewayVersionRequests, 8);

    await bothGatewayEdits({ knowledgeBaseIds: [], connectorIds: [] });
    assert.deepEqual(await gatewayVersions(nativeEditTarget.id), versionHistory);
    assert.equal(gatewayVersionRequests, 9);

    const failedVersionEdit = { description: "Reject gateway edit version fixture" };
    await db.execute(sql`ALTER TABLE agent_versions ADD CONSTRAINT riir_reject_gateway_edit_version
      CHECK (snapshot ->> 'description' IS DISTINCT FROM 'Reject gateway edit version fixture') NOT VALID`);
    try {
      const editWithoutVersion = await bothGatewayEdits(failedVersionEdit);
      assert.equal((await storedGateway(nativeEditTarget.id)).description, failedVersionEdit.description);
      assert.equal(editWithoutVersion.version, versionHistory.at(-1).version);
      assert.deepEqual(await gatewayVersions(nativeEditTarget.id), versionHistory);
      assert.equal(gatewayVersionRequests, 10);
    } finally {
      await db.execute(sql`ALTER TABLE agent_versions DROP CONSTRAINT riir_reject_gateway_edit_version`);
    }
    await bothGatewayEdits(failedVersionEdit);
    const recoveredHistory = await gatewayVersions(nativeEditTarget.id);
    assert.equal(recoveredHistory.length, versionHistory.length + 1);
    assert.deepEqual(recoveredHistory.at(-1), (await gatewayVersions(legacyEditTarget.id)).at(-1));
    assert.equal(gatewayVersionRequests, 11);

    const conflictingDelegate = await AgentModel.create({
      organizationId: org, agentType: "agent", name: ownAgent.name,
    }, owner, { skipCreationDefaultTools: true });
    const linkedTargets = async (id) =>
      (await AgentToolModel.getDelegationTargets(id)).map(({ id }) => id);
    const delegatedEdit = await bothGatewayEdits({
      subAgentIds: [randomUUID(), hiddenGateway.id, ownAgent.id, ownAgent.id, conflictingDelegate.id],
    });
    assert.deepEqual(await linkedTargets(nativeEditTarget.id), [ownAgent.id]);
    assert.deepEqual(await linkedTargets(legacyEditTarget.id), [ownAgent.id]);
    assert.equal(delegatedEdit.version, recoveredHistory.at(-1).version + 1);
    assert.deepEqual((await gatewayVersions(nativeEditTarget.id)).at(-1),
      (await gatewayVersions(legacyEditTarget.id)).at(-1));
    assert.equal(gatewayDelegationRequests, 3);
    assert.equal(gatewayVersionRequests, 13);

    const delegationCreateArgs = { name: "Gateway creation with delegation fixture", subAgentIds: [ownAgent.id] };
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyDelegationCreate = await post(gatewayCreateCall(delegationCreateArgs));
    assert.notEqual(legacyDelegationCreate.body.result.isError, true, JSON.stringify(legacyDelegationCreate.body));
    const [legacyDelegationGateway] = await gatewayRows(delegationCreateArgs.name);
    config.mcpGateway.rustDiscoverEnabled = true;
    const nativeDelegationCreate = await post(gatewayCreateCall(delegationCreateArgs));
    const delegationGateways = await gatewayRows(delegationCreateArgs.name);
    assert.equal(delegationGateways.length, 2);
    const nativeDelegationGateway = delegationGateways.find(({ id }) => id !== legacyDelegationGateway.id);
    assert.equal(JSON.stringify(nativeDelegationCreate).replaceAll(nativeDelegationGateway.id, legacyDelegationGateway.id),
      JSON.stringify(legacyDelegationCreate));
    assert.deepEqual(await linkedTargets(nativeDelegationGateway.id), [ownAgent.id]);
    assert.deepEqual(await persistedGateway(nativeDelegationGateway), await persistedGateway(legacyDelegationGateway));
    assert.deepEqual(await gatewayVersions(nativeDelegationGateway.id), await gatewayVersions(legacyDelegationGateway.id));
    assert.equal(gatewayDelegationRequests, 4);
    assert.equal(gatewayVersionRequests, 15);

    // Old agents can predate delegation-tool creation. Seed the bare rows so
    // neither implementation has a tool to reuse on its first assignment.
    const [legacyBare, nativeBare, concurrentBare] = await db.insert(schema.agentsTable).values(
      ["  Knowledge / Résumé?!  ", "  Knowledge / Résumé?!  ", "Concurrent delegation fixture"].map((name) =>
        ({ organizationId: org, authorId: owner, agentType: "agent", name })),
    ).returning();
    const delegateTools = (id) => db.select().from(schema.toolsTable)
      .where(eq(schema.toolsTable.delegateToAgentId, id));
    const delegateCall = (gatewayId, targetId) => gatewayRelationshipCall(gatewayId, { subAgentIds: [targetId] });
    assert.deepEqual(await delegateTools(nativeBare.id), []);
    config.mcpGateway.rustDiscoverEnabled = false;
    const firstLegacy = await post(delegateCall(legacyEditTarget.id, legacyBare.id));
    config.mcpGateway.rustDiscoverEnabled = true;
    const firstNative = await post(delegateCall(nativeEditTarget.id, nativeBare.id));
    assert.equal(JSON.stringify(firstNative).replaceAll(nativeEditTarget.id, legacyEditTarget.id)
      .replaceAll(nativeBare.id, legacyBare.id), JSON.stringify(firstLegacy));
    const [legacyTool] = await delegateTools(legacyBare.id);
    const [nativeTool] = await delegateTools(nativeBare.id);
    const toolDefinition = ({ name, description, parameters, agentId, catalogId }) =>
      ({ name, description, parameters, agentId, catalogId });
    assert.deepEqual(toolDefinition(nativeTool), toolDefinition(legacyTool));
    assert.ok((await linkedTargets(nativeEditTarget.id)).includes(nativeBare.id));
    const beforeDelegateReuse = await gatewayVersions(nativeEditTarget.id);
    assert.deepEqual(await post(delegateCall(nativeEditTarget.id, nativeBare.id)), firstNative);
    assert.deepEqual(await delegateTools(nativeBare.id), [nativeTool]);
    assert.deepEqual(await gatewayVersions(nativeEditTarget.id), beforeDelegateReuse);

    // Each API process has a one-connection pool. Use two processes to test
    // cross-process deduplication rather than pool serialization.
    const secondSocket = join(scratch, "delegation-peer.sock");
    const secondApi = spawn("../archestra-rs/target/debug/archestra-api", [secondSocket], { stdio: "inherit" });
    const secondApiExit = once(secondApi, "exit");
    let concurrentCalls;
    try {
      for (let retry = 0; retry < 40 && !(await stat(secondSocket).catch(() => null)); retry++) {
        assert.equal(secondApi.exitCode, null);
        await delay(50);
      }
      assert.ok((await stat(secondSocket)).isSocket());
      await db.transaction(async (tx) => {
        await tx.select({ id: schema.agentsTable.id }).from(schema.agentsTable)
          .where(eq(schema.agentsTable.id, concurrentBare.id)).for("update");
        concurrentCalls = Promise.allSettled([legacyEditTarget, nativeEditTarget].map(({ id }, index) => callRustApi({
          socketPath: index === 0 ? socket : secondSocket,
          path: "/internal/v1/mcp/tools/assign-gateway-delegation",
          json: JSON.stringify({ agentId: id, targetAgentId: concurrentBare.id, organizationId: org }),
        })));
        for (let attempt = 0; attempt < 75; attempt++) {
          const { rows: [row] } = await tx.execute(sql`WITH RECURSIVE waiting(pid) AS (
            SELECT pg_backend_pid()
            UNION
            SELECT l.pid FROM pg_locks l JOIN waiting w ON w.pid = ANY(pg_blocking_pids(l.pid))
            WHERE NOT l.granted
          ) SELECT (count(*) - 1)::int AS blocked FROM waiting`);
          if (row.blocked === 2) return;
          await delay(50);
        }
        assert.fail("both Rust delegation writers did not contend on the target lock");
      });
      assert.deepEqual(await concurrentCalls, [
        { status: "fulfilled", value: true }, { status: "fulfilled", value: true },
      ]);
    } finally {
      secondApi.kill();
      await secondApiExit;
    }
    const concurrentTools = await delegateTools(concurrentBare.id);
    assert.equal(concurrentTools.length, 1);
    for (const { id } of [legacyEditTarget, nativeEditTarget]) {
      assert.ok((await AgentToolModel.findToolIdsByAgent(id)).includes(concurrentTools[0].id));
    }
    assert.equal(gatewayDelegationRequests, 6);

    const [lateHook, earlyHook, privateHook] = await db.insert(schema.hookFilesTable).values(
      [[ownAgent.id, "z.py"], [ownAgent.id, "a.py"], [privateAgent.id, "private.py"]].map(([agentId, fileName]) => ({
        organizationId: org, agentId, event: "pre_tool_use", fileName,
        content: "# Read-only fixture 📝\n", requirements: ["example==1.0"], enabled: false,
        createdAt: sql`'2026-01-01T01:02:03.123456+03:00'::timestamptz`,
      })),
    ).returning();
    const hooksCall = (agentId) => ({
      ...usageCall(listHooks), params: { name: listHooks, arguments: { agent_id: agentId } },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyHooks = await post(hooksCall(ownAgent.id));
    assert.ok(Array.isArray(legacyHooks.body.result.structuredContent?.hooks), JSON.stringify(legacyHooks.body));
    assert.deepEqual(legacyHooks.body.result.structuredContent.hooks.map(({ id }) => id), [earlyHook.id, lateHook.id]);
    const deniedHooks = await post(hooksCall(privateAgent.id));
    assert.equal(deniedHooks.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(hooksCall(privateAgent.id)), deniedHooks);
    assert.equal(hookListRequests, 0);
    assert.deepEqual(await post(hooksCall(ownAgent.id)), legacyHooks);
    assert.equal(hookListRequests, 1);

    const beforeHookCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopHooks = new AbortController();
    const hooksCancelled = assert.rejects(
      call(stopHooks, "riir-hook-list-cancel", listHooks, { agent_id: ownAgent.id }),
      { name: "AbortError" },
    );
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native hook list did not respond"))]);
    } finally {
      stopHooks.abort();
      await hooksCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("hook list relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeHookCancel)).toolResult.isError, true);
    assert.equal(hookListRequests, 2);
    holdToolReply = undefined;

    const deleteHook = "archestra__delete_hook";
    const hookDeleteCall = (id) => ({
      ...usageCall(deleteHook), params: { name: deleteHook, arguments: { id } },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedHookDelete = await post(hookDeleteCall(privateHook.id));
    assert.equal(deniedHookDelete.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(hookDeleteCall(privateHook.id)), deniedHookDelete);
    assert.equal(hookDeleteRequests, 0);
    assert.equal(await callRustApi({
      socketPath: socket, path: "/internal/v1/mcp/tools/delete-hook",
      json: JSON.stringify({ id: privateHook.id, agentId: ownAgent.id, organizationId: org }),
    }), false);
    const readHook = async (id) => (await db.select().from(schema.hookFilesTable)
      .where(eq(schema.hookFilesTable.id, id)))[0];
    assert.deepEqual(await readHook(privateHook.id), privateHook);

    await AgentVersionModel.forkIfChanged(ownAgent.id);
    const head = async () => (await gatewayVersions(ownAgent.id)).at(-1);
    assert.deepEqual((await head()).snapshot.hooks.map(({ fileName }) => fileName), ["a.py", "z.py"]);
    const hookDeleteResults = [];
    for (const [native, hook, remaining] of [[true, lateHook, [earlyHook]], [false, earlyHook, []]]) {
      config.mcpGateway.rustDiscoverEnabled = native;
      const before = (await head()).version;
      const response = await post(hookDeleteCall(hook.id));
      assert.deepEqual(response.body.result.structuredContent, { success: true, id: hook.id });
      assert.equal(await readHook(hook.id), undefined);
      for (const sibling of remaining) assert.deepEqual(await readHook(sibling.id), sibling);
      const missing = await post(hookDeleteCall(hook.id));
      assert.equal(missing.body.result.isError, true);
      assert.equal((await head()).version, before + 1);
      assert.deepEqual((await head()).snapshot.hooks.map(({ fileName }) => fileName), remaining.map(({ fileName }) => fileName));
      hookDeleteResults.push([response, missing].map((result) =>
        JSON.parse(JSON.stringify(result).replaceAll(hook.id, "hook-id"))));
    }
    assert.deepEqual(hookDeleteResults[1], hookDeleteResults[0]);
    assert.equal(hookDeleteRequests, 1);

    const createHook = "archestra__create_hook";
    const hookCreateCall = (args) => ({ ...usageCall(createHook), params: { name: createHook, arguments: args } });
    const hookInput = { event: "session_start", content: "# Fixture only 📝\n" };
    const privateHookCreate = hookCreateCall({ ...hookInput, agent_id: privateAgent.id, file_name: "denied.py" });
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedHookCreate = await post(privateHookCreate);
    assert.equal(deniedHookCreate.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(privateHookCreate), deniedHookCreate);
    assert.equal(hookCreateRequests, 0);

    const hooksToUpdate = [];
    let conflictingHook;
    for (const options of [{}, { enabled: false, requirements: ["  example==1.0  "] }]) {
      const outcomes = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const fileName = `${options.enabled ?? true}-${native}.py`;
        const args = { ...hookInput, ...options, agent_id: ownAgent.id, file_name: fileName };
        const before = (await head()).version;
        const response = await post(hookCreateCall(args));
        const hook = response.body.result.structuredContent?.hook;
        assert.ok(hook, JSON.stringify(response.body));
        const { id, createdAt, updatedAt, agentId, ...settings } = hook;
        assert.deepEqual(settings, {
          event: args.event, fileName, content: args.content, enabled: options.enabled ?? true,
          requirements: options.requirements?.map((requirement) => requirement.trim()) ?? [],
        });
        assert.equal(agentId, ownAgent.id);
        const stored = await readHook(id);
        assert.deepEqual(stored, { ...hook, organizationId: org, createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) });
        if (options.enabled === false) hooksToUpdate.push(stored);
        else if (!native) conflictingHook = stored;
        assert.deepEqual((await head()).snapshot.hooks.find((item) => item.fileName === fileName), settings);
        const duplicate = await post(hookCreateCall({ ...args, content: "# Must not replace this hook\n" }));
        assert.equal(duplicate.body.result.isError, true);
        assert.deepEqual(await readHook(id), stored);
        assert.equal((await head()).version, before + 1);
        outcomes.push([JSON.parse(JSON.stringify(response)
          .replaceAll(id, "hook-id").replaceAll(fileName, "file.py")
          .replaceAll(createdAt, "timestamp").replaceAll(updatedAt, "timestamp")), duplicate]);
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
    }
    assert.equal(hookCreateRequests, 4);

    await t.test("update_hook preserves response, scope, snapshots and single-write audit", async () => {
      const updateHook = "archestra__update_hook";
      const hookUpdateCall = (id, fields) => ({
        ...usageCall(updateHook), params: { name: updateHook, arguments: { id, ...fields } },
      });
      const privateHookUpdate = hookUpdateCall(privateHook.id, { enabled: true });
      config.mcpGateway.rustDiscoverEnabled = false;
      const deniedUpdate = await post(privateHookUpdate);
      assert.equal(deniedUpdate.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(privateHookUpdate), deniedUpdate);
      assert.deepEqual(await readHook(privateHook.id), privateHook);
      assert.equal(hookUpdateRequests, 0);

      const outcomes = [];
      for (const [index, original] of hooksToUpdate.entries()) {
        config.mcpGateway.rustDiscoverEnabled = index === 1;
        const { id, createdAt } = original;
        const readUpdated = async (response, changes) => {
          const hook = response.body.result.structuredContent?.hook;
          assert.ok(hook, JSON.stringify(response.body));
          const stored = await readHook(id);
          assert.ok(stored.updatedAt >= original.updatedAt);
          assert.deepEqual(stored, { ...original, ...changes, updatedAt: stored.updatedAt });
          assert.deepEqual(hook, {
            id, agentId: stored.agentId, event: stored.event, fileName: stored.fileName,
            content: stored.content, requirements: stored.requirements, enabled: stored.enabled,
            createdAt: createdAt.toISOString(), updatedAt: stored.updatedAt.toISOString(),
          });
          return [stored, JSON.parse(JSON.stringify(response)
            .replaceAll(id, "hook-id").replaceAll(stored.fileName, "file.py")
            .replaceAll(createdAt.toISOString(), "created").replaceAll(stored.updatedAt.toISOString(), "updated"))];
        };

        const startVersion = (await head()).version;
        const [partial, partialResponse] = await readUpdated(
          await post(hookUpdateCall(id, { enabled: true })), { enabled: true },
        );
        assert.equal((await head()).version, startVersion + 1);
        const conflict = await post(hookUpdateCall(id, { file_name: conflictingHook.fileName, content: "# Not applied\n" }));
        assert.equal(conflict.body.result.isError, true);
        assert.deepEqual(await readHook(id), partial);
        assert.deepEqual(await readHook(conflictingHook.id), conflictingHook);
        assert.equal((await head()).version, startVersion + 1);

        const changes = { event: "post_tool_use", fileName: `moved-${index}.py`, requirements: [], enabled: false };
        const [, fullResponse] = await readUpdated(await post(hookUpdateCall(id, {
          event: changes.event, file_name: changes.fileName, requirements: changes.requirements, enabled: changes.enabled,
        })), changes);
        const version = await head();
        assert.equal(version.version, startVersion + 2);
        assert.deepEqual(version.snapshot.hooks.find(({ fileName }) => fileName === changes.fileName), {
          ...changes, content: original.content,
        });
        outcomes.push([partialResponse, conflict, fullResponse]);
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(hookUpdateRequests, 3);
    });
    config.hooks.enabled = hooksWereEnabled;

    const scheduleEditIds = [];
    const scheduleToggleIds = [];
    await t.test("create_schedule_trigger preserves scope, storage, retries and single-write audit", async () => {
      const createSchedule = "archestra__create_schedule_trigger";
      const args = {
        name: "Schedule write fixture", agent_id: ownAgent.id, cron_expression: " 0   9 * * 1-5 ",
        timezone: " America/Toronto ", message_template: "Fixture scheduled prompt 📝",
      };
      const createCall = (fields) => ({
        ...usageCall(createSchedule), params: { name: createSchedule, arguments: { ...args, ...fields } },
      });
      for (const deniedCall of [
        createCall({ project_id: privateProject.id }),
        createCall({ project_id: ownProject.id, cron_expression: "invalid cron" }),
      ]) {
        config.mcpGateway.rustDiscoverEnabled = false;
        const legacy = await post(deniedCall);
        assert.equal(legacy.body.result.isError, true);
        config.mcpGateway.rustDiscoverEnabled = true;
        assert.deepEqual(await post(deniedCall), legacy);
      }
      assert.equal(scheduleCreateRequests, 0);

      const assertCreated = async (response, expected) => {
        const summary = response.body.result.structuredContent;
        assert.ok(summary?.created, JSON.stringify(response.body));
        assert.deepEqual(summary, {
          id: summary.id, name: expected.name, agent_id: ownAgent.id, agent_name: ownAgent.name,
          project_id: expected.projectId ?? summary.project_id, cron_expression: "0 9 * * 1-5",
          timezone: "America/Toronto", enabled: expected.enabled, last_executed_at: null,
          actor_user_id: owner, actor_name: "MCP fixture user", created_at: summary.created_at,
          message_template: args.message_template, created: true,
        });
        const [row] = await db.select().from(schema.scheduleTriggersTable).where(eq(schema.scheduleTriggersTable.id, summary.id));
        assert.deepEqual(row, {
          id: summary.id, organizationId: org, name: expected.name, agentId: ownAgent.id,
          projectId: summary.project_id, messageTemplate: args.message_template,
          cronExpression: "0 9 * * 1-5", timezone: "America/Toronto", enabled: expected.enabled,
          actorUserId: owner, lastExecutedAt: null, createdAt: new Date(summary.created_at),
        });
        return summary;
      };
      const existingProjectResponses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const response = await post(createCall({ project_id: ownProject.id, enabled: false }));
        const summary = await assertCreated(response, { name: args.name, projectId: ownProject.id, enabled: false });
        scheduleEditIds.push(summary.id);
        existingProjectResponses.push(JSON.parse(JSON.stringify(response)
          .replaceAll(summary.id, "new-schedule").replaceAll(summary.created_at, "new-timestamp")));

        const name = `${args.name} ${native ? "native" : "legacy"} private project`;
        const request = createCall({ name });
        const created = await post(request);
        const shortcut = await assertCreated(created, { name, enabled: true });
        scheduleToggleIds.push(shortcut.id);
        const scope = { id: shortcut.project_id, organizationId: org, userId: owner };
        const project = await projectService.get(scope);
        assert.equal(project.name, name);
        assert.equal(project.viewerRole, "owner");
        assert.equal(project.visibility, null);
        assert.equal((await projectService.getInstructions(scope)).content, args.message_template);
        assert.deepEqual((await post(request)).body.result.structuredContent, { ...shortcut, created: false });
        assert.equal((await db.select({ id: schema.scheduleTriggersTable.id }).from(schema.scheduleTriggersTable)
          .where(eq(schema.scheduleTriggersTable.projectId, project.id))).length, 1);
      }
      assert.deepEqual(existingProjectResponses[1], existingProjectResponses[0]);
      assert.equal(scheduleCreateRequests, 2);
    });

    await t.test("update_schedule_trigger preserves scope, storage and single-write audit", async () => {
      assert.equal(scheduleEditIds.length, 2);
      const updateSchedule = "archestra__update_schedule_trigger";
      const updateCall = (id, fields) => ({
        ...usageCall(updateSchedule),
        params: { name: updateSchedule, arguments: { schedule_trigger_id: id, ...fields } },
      });
      const readSchedule = async (id) => (await db.select().from(schema.scheduleTriggersTable)
        .where(eq(schema.scheduleTriggersTable.id, id)))[0];
      const target = scheduleEditIds[1];
      const originalTarget = await readSchedule(target);
      for (const request of [
        updateCall(hiddenTrigger.id, { enabled: true }),
        updateCall(target, { project_id: privateProject.id }),
        updateCall(target, { cron_expression: "invalid cron" }),
      ]) {
        config.mcpGateway.rustDiscoverEnabled = false;
        const legacy = await post(request);
        assert.equal(legacy.body.result.isError, true);
        config.mcpGateway.rustDiscoverEnabled = true;
        assert.deepEqual(await post(request), legacy);
      }
      assert.deepEqual(await readSchedule(target), originalTarget);
      assert.equal(scheduleUpdateRequests, 0);
      const { projectId, agentId, actorUserId, cronExpression, messageTemplate } = originalTarget;
      assert.equal(await callRustApi({
        socketPath: socket, path: "/internal/v1/mcp/tools/update-schedule-trigger",
        json: JSON.stringify({ id: target, organizationId: org,
          expected: { projectId, agentId, actorUserId, cronExpression, messageTemplate, timezone: "UTC" },
          patch: { name: "must not overwrite a stale snapshot" },
        }),
      }), null);
      assert.deepEqual(await readSchedule(target), originalTarget);

      const replacement = await AgentModel.create({ organizationId: org, agentType: "agent",
        name: "Schedule replacement agent" }, owner, { skipCreationDefaultTools: true });
      const outcomes = [];
      for (const [index, id] of scheduleEditIds.entries()) {
        const [original] = await db.update(schema.scheduleTriggersTable).set({ lastExecutedAt: started })
          .where(eq(schema.scheduleTriggersTable.id, id)).returning();
        config.mcpGateway.rustDiscoverEnabled = index === 1;
        const responses = [];
        let expected = original;
        for (const [fields, changes] of [
          [{ name: "Renamed schedule" }, { name: "Renamed schedule" }],
          [{ project_id: sharedProject.id, agent_id: replacement.id, enabled: true,
            cron_expression: " 30  8 * * * ", timezone: " UTC ", message_template: "Updated schedule prompt" },
          { projectId: sharedProject.id, agentId: replacement.id, enabled: true,
            cronExpression: "30 8 * * *", timezone: "UTC", messageTemplate: "Updated schedule prompt" }],
        ]) {
          const response = await post(updateCall(id, fields));
          expected = { ...expected, ...changes };
          assert.deepEqual(await readSchedule(id), expected);
          assert.deepEqual(response.body.result.structuredContent, {
            id, name: expected.name, agent_id: expected.agentId,
            agent_name: expected.agentId === replacement.id ? replacement.name : ownAgent.name,
            project_id: expected.projectId, cron_expression: expected.cronExpression, timezone: expected.timezone,
            enabled: expected.enabled, last_executed_at: started.toISOString(), actor_user_id: owner,
            actor_name: "MCP fixture user", created_at: expected.createdAt.toISOString(), message_template: expected.messageTemplate,
          });
          responses.push(JSON.parse(JSON.stringify(response).replaceAll(id, "schedule-id")
            .replaceAll(expected.createdAt.toISOString(), "created")));
        }
        outcomes.push(responses);
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(scheduleUpdateRequests, 2);
    });

    await t.test("schedule enable and disable preserve storage, run history and single-write audit", async () => {
      assert.equal(scheduleToggleIds.length, 2);
      const triggers = schema.scheduleTriggersTable;
      const runs = schema.scheduleTriggerRunsTable;
      const audit = schema.auditLogsTable;
      const toggleName = (enabled) => enabled ? "archestra__enable_schedule_trigger" : "archestra__disable_schedule_trigger";
      const toggleCall = (id, enabled) => {
        const name = toggleName(enabled);
        return { ...usageCall(name), params: { name, arguments: { schedule_trigger_id: id } } };
      };
      const readTrigger = async (id) => (await db.select().from(triggers).where(eq(triggers.id, id)))[0];
      const readAudit = (id, enabled) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${toggleName(enabled)}`),
      )).orderBy(audit.eventSequence);
      const beforeNative = scheduleUpdateRequests;
      for (const enabled of [false, true]) {
        const request = toggleCall(hiddenTrigger.id, enabled);
        config.mcpGateway.rustDiscoverEnabled = false;
        const denied = await post(request);
        assert.equal(denied.body.result.isError, true);
        assert.deepEqual((await readAudit(hiddenTrigger.id, enabled)).map(({ outcome }) => outcome), ["failure"]);
        config.mcpGateway.rustDiscoverEnabled = true;
        assert.deepEqual(await post(request), denied);
        assert.deepEqual((await readAudit(hiddenTrigger.id, enabled)).map(({ outcome }) => outcome), ["failure", "failure"]);
      }
      assert.deepEqual(await readTrigger(hiddenTrigger.id), hiddenTrigger);
      assert.equal(scheduleUpdateRequests, beforeNative);

      const outcomes = [];
      for (const [index, id] of scheduleToggleIds.entries()) {
        config.mcpGateway.rustDiscoverEnabled = index === 1;
        const [history] = await db.insert(runs).values({
          organizationId: org, triggerId: id, runKind: "due", status: "success", startedAt: started,
        }).returning();
        const initial = await readTrigger(id);
        assert.equal(initial.enabled, true);
        const results = [];
        for (const enabled of [false, true]) {
          const result = await post(toggleCall(id, enabled));
          assert.equal(result.body.result.structuredContent?.enabled, enabled, JSON.stringify(result.body));
          assert.deepEqual(await readTrigger(id), { ...initial, enabled });
          assert.deepEqual(await db.select().from(runs).where(eq(runs.triggerId, id)), [history]);
          const records = await readAudit(id, enabled);
          assert.equal(records.length, 1);
          const [record] = records;
          assert.equal(record.action, "scheduleTrigger.updated");
          assert.equal(record.actorId, owner);
          assert.equal(record.outcome, "success");
          assert.equal(record.before?.enabled, !enabled);
          assert.equal(record.after?.enabled, enabled);
          results.push(JSON.parse(JSON.stringify(result).replaceAll(id, "schedule-id")
            .replaceAll(initial.projectId, "project-id").replaceAll(initial.name, "schedule-name")
            .replaceAll(initial.createdAt.toISOString(), "created")));
        }
        outcomes.push(results);
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(scheduleUpdateRequests, beforeNative + 2);
    });

    await t.test("run_schedule_trigger_now queues one manual run and writes one audit row", async () => {
      const name = "archestra__run_schedule_trigger_now";
      const runNow = (id) => ({
        ...usageCall(name), params: { name, arguments: { schedule_trigger_id: id } },
      });
      const runs = schema.scheduleTriggerRunsTable;
      const tasks = schema.tasksTable;
      const audit = schema.auditLogsTable;
      const readRuns = (id) => db.select().from(runs).where(and(eq(runs.triggerId, id), eq(runs.runKind, "manual")));
      const readTasks = (id) => db.select().from(tasks).where(and(
        eq(tasks.taskType, "schedule_trigger_run_execute"), sql`${tasks.payload}->>'triggerId' = ${id}`,
      ));
      const readAudit = (id) => db.select().from(audit)
        .where(and(eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`)))
        .orderBy(audit.eventSequence);

      const deniedId = hiddenTrigger.id;
      const beforeDenied = await readRuns(deniedId);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(runNow(deniedId));
      assert.equal(denied.body.result.isError, true);
      assert.deepEqual((await readAudit(deniedId)).map(({ outcome }) => outcome), ["failure"]);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(runNow(deniedId)), denied);
      assert.deepEqual((await readAudit(deniedId)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.deepEqual(await readRuns(deniedId), beforeDenied);
      assert.deepEqual(await readTasks(deniedId), []);
      assert.equal(manualRunRequests, 0);

      assert.equal(scheduleToggleIds.length, 2);
      const responses = [];
      for (const [index, id] of scheduleToggleIds.entries()) {
        const triggers = schema.scheduleTriggersTable;
        const [before] = await db.update(triggers).set({ enabled: false }).where(eq(triggers.id, id)).returning();
        config.mcpGateway.rustDiscoverEnabled = index === 1;
        const response = await post(runNow(id));
        const summary = response.body.result.structuredContent;
        assert.ok(summary, JSON.stringify(response.body));
        const rows = await readRuns(id);
        assert.equal(rows.length, 1);
        const [run] = rows;
        assert.deepEqual(run, {
          id: summary.id, organizationId: org, triggerId: id, runKind: "manual", status: "running",
          initiatedByUserId: owner, startedAt: new Date(summary.started_at), createdAt: new Date(summary.created_at),
          completedAt: null, error: null, blockedBy: null, chatConversationId: null, runtimeTaskId: null, artifact: null,
        });
        assert.deepEqual(summary, {
          id: run.id, trigger_id: id, run_kind: "manual", status: "running", started_at: run.startedAt.toISOString(),
          created_at: run.createdAt.toISOString(), completed_at: null, blocked_by: null, error: null,
          chat_conversation_id: null, runtime_task_id: null,
        });
        const queued = await readTasks(id);
        assert.deepEqual(queued.map(({ payload, status, attempt, maxAttempts, periodic }) =>
          ({ payload, status, attempt, maxAttempts, periodic })), [{
          payload: { runId: run.id, triggerId: id }, status: "pending", attempt: 0, maxAttempts: 5, periodic: false,
        }]);
        assert.deepEqual((await db.select().from(triggers).where(eq(triggers.id, id)))[0], before);
        const records = await readAudit(id);
        assert.equal(records.length, 1);
        const [record] = records;
        assert.equal(record.action, "scheduleTrigger.triggered");
        assert.equal(record.outcome, "success");
        assert.equal(record.actorId, owner);
        assert.deepEqual(record.after, { runId: run.id, triggerId: id, status: "running", runKind: "manual" });
        const normalized = JSON.parse(JSON.stringify(response).replaceAll(run.id, "run-id")
          .replaceAll(id, "trigger-id").replaceAll(before.name, "schedule-name"));
        Object.assign(normalized.body.result.structuredContent, { started_at: "started", created_at: "created" });
        responses.push(normalized);
      }
      assert.deepEqual(responses[1], responses[0]);
      assert.equal(manualRunRequests, 1);
    });

    await t.test("delete_schedule_trigger preserves scope, cascades and single-write audit", async () => {
      const name = "archestra__delete_schedule_trigger";
      const deleteCall = (id) => ({
        ...usageCall(name), params: { name, arguments: { schedule_trigger_id: id } },
      });
      const triggers = schema.scheduleTriggersTable;
      const runs = schema.scheduleTriggerRunsTable;
      const audit = schema.auditLogsTable;
      const readTrigger = async (id) => (await db.select().from(triggers).where(eq(triggers.id, id)))[0];
      const readRuns = (id) => db.select().from(runs).where(eq(runs.triggerId, id)).orderBy(runs.id);
      const readAudit = (id) => db.select().from(audit)
        .where(and(eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`)))
        .orderBy(audit.eventSequence);

      const otherRuns = await readRuns(hiddenTrigger.id);
      assert.ok(otherRuns.length > 0);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deleteCall(hiddenTrigger.id));
      assert.equal(denied.body.result.isError, true);
      assert.equal((await readAudit(hiddenTrigger.id)).length, 1);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deleteCall(hiddenTrigger.id)), denied);
      assert.deepEqual((await readAudit(hiddenTrigger.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.deepEqual(await readTrigger(hiddenTrigger.id), hiddenTrigger);
      assert.deepEqual(await readRuns(hiddenTrigger.id), otherRuns);
      assert.equal(scheduleDeleteRequests, 0);

      const responses = [];
      for (const [index, id] of scheduleEditIds.entries()) {
        const before = await readTrigger(id);
        const createdRuns = await db.insert(runs).values(["due", "manual"].map((runKind) => ({
          organizationId: org, triggerId: id, runKind, status: "success",
        }))).returning();
        assert.deepEqual((await readRuns(id)).map((row) => row.id), createdRuns.map((row) => row.id).sort());
        config.mcpGateway.rustDiscoverEnabled = index === 1;
        if (index === 1) {
          assert.equal(await callRustApi({
            socketPath: socket, path: "/internal/v1/mcp/tools/delete-schedule-trigger",
            json: JSON.stringify({ id, organizationId: org, projectId: null, agentId: before.agentId, actorUserId: owner }),
          }), false);
          assert.equal((await readRuns(id)).length, 2);
        }
        const deleted = await post(deleteCall(id));
        assert.deepEqual(deleted.body.result.structuredContent, { success: true });
        assert.equal(await readTrigger(id), undefined);
        assert.deepEqual(await readRuns(id), []);
        assert.deepEqual(await readRuns(hiddenTrigger.id), otherRuns);
        const records = await readAudit(id);
        assert.equal(records.length, 1);
        const [success] = records;
        assert.equal(success.action, "scheduleTrigger.deleted");
        assert.equal(success.outcome, "success");
        assert.equal(success.actorId, owner);
        assert.equal(success.before?.projectId, before.projectId);
        assert.equal(success.before?.name, before.name);
        assert.equal(success.after, null);
        const missing = await post(deleteCall(id));
        assert.equal(missing.body.result.isError, true);
        assert.deepEqual((await readAudit(id)).map(({ outcome }) => outcome), ["success", "failure"]);
        responses.push([deleted, missing]);
      }
      assert.deepEqual(responses[1], responses[0]);
      assert.equal(scheduleDeleteRequests, 1);
    });

    const listModels = "archestra__list_llm_models";
    const [ownKey, privateKey] = await Promise.all([owner, member].map(async (userId) => {
      const apiKey = "fixture-only-not-a-provider-credential";
      const { id: secretId } = await SecretModel.create({ secret: { apiKey } });
      return LlmProviderApiKeyModel.create({
        organizationId: org, userId, name: "Fixture model key", provider: "openai", secretId,
      }, { apiKeyValue: apiKey });
    }));
    const [lateModel, earlyModel, privateModel] = await db.insert(schema.modelsTable).values(
      ["fixture-Z", "fixture-a", "fixture-private"].map((modelId) => ({
        externalId: `openai/${modelId}`, provider: "openai", modelId,
      })),
    ).returning();
    await db.insert(schema.llmProviderApiKeyModelsTable).values([
      { apiKeyId: ownKey.id, modelId: lateModel.id },
      { apiKeyId: ownKey.id, modelId: earlyModel.id },
      { apiKeyId: privateKey.id, modelId: privateModel.id },
    ]);
    const modelCall = (args) => ({
      ...usageCall(listModels), params: { name: listModels, arguments: args },
    });
    for (const [args, ids] of [[{provider: "openai"}, [earlyModel.id, lateModel.id]], [{provider: "openai", query: "FIXTURE-A"}, [earlyModel.id]]]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(modelCall(args));
      assert.deepEqual(legacy.body.result.structuredContent?.apiKeys.map(({id, models}) => [id, models.map((model) => model.id)]), [[ownKey.id, ids]]);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(modelCall(args)), legacy);
    }
    const noAuthorizedKeys = await post(modelCall({provider: "anthropic"}));
    assert.deepEqual(noAuthorizedKeys.body.result.structuredContent.apiKeys, []);
    assert.equal(modelListRequests, 2);

    const beforeModelCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopModels = new AbortController();
    const modelsCancelled = assert.rejects(call(stopModels, "riir-model-list-cancel", listModels, { provider: "openai" }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native model list did not respond"))]);
    } finally {
      stopModels.abort();
      await modelsCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("model list relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeModelCancel)).toolResult.isError, true);
    assert.equal(modelListRequests, 3);
    holdToolReply = undefined;

    const agentUsage = "archestra__get_agent_token_usage";
    const proxyUsage = "archestra__get_llm_proxy_token_usage";
    const getLimits = "archestra__get_limits";
    config.mcpGateway.rustDiscoverEnabled = true;
    for (const name of [agentUsage, proxyUsage]) {
      assert.equal((await post(usageCall(name))).body.result.isError, true);
    }
    assert.equal(usageRequests, 0, "missing llmLimit:read must deny before native execution");
    assert.equal((await post(usageCall(getLimits))).body.result.isError, true);
    assert.equal(limitRequests, 0);
    const getInteraction = "archestra__get_llm_interaction";
    const listInteractions = "archestra__list_llm_interactions";
    const listSessions = "archestra__list_llm_sessions";
    const getSessionLogs = "archestra__get_llm_session_logs";
    const sessionLogsCall = (args) => ({
      ...usageCall(getSessionLogs), params: { name: getSessionLogs, arguments: args },
    });
    const sessionCall = (args) => ({
      ...usageCall(listSessions), params: { name: listSessions, arguments: args },
    });
    const interactionPage = (args) => ({
      ...usageCall(listInteractions), params: { name: listInteractions, arguments: args },
    });
    const interactionCall = (id) => ({
      ...usageCall(getInteraction), params: { name: getInteraction, arguments: { interaction_id: id } },
    });
    const noLogPermission = await post(interactionCall(ownInteraction.id));
    assert.equal(noLogPermission.body.result.isError, true);
    assert.equal(interactionRequests, 0);
    assert.equal((await post(interactionPage({}))).body.result.isError, true);
    assert.equal(interactionPageRequests, 0);
    assert.equal((await post(sessionCall({}))).body.result.isError, true);
    assert.equal(sessionRequests, 0);
    assert.equal((await post(sessionLogsCall({ session_id: ownInteraction.sessionId }))).body.result.isError, true);
    assert.equal(sessionLogRequests, 0);
    await db.insert(schema.organizationRolesTable).values({
      id: randomUUID(), organizationId: org, role: "riir-log-reader", name: "Fixture log reader",
      permission: JSON.stringify({ log: ["read"], mcpGateway: ["read"] }),
    });
    await db.update(schema.membersTable).set({ role: "member,riir-log-reader" }).where(eq(schema.membersTable.userId, owner));
    const otherOrg = randomUUID();
    await db.insert(schema.organizationsTable).values({ id: otherOrg, name: otherOrg, slug: otherOrg, createdAt: new Date() });
    const otherOrgAgent = await AgentModel.create({
      organizationId: otherOrg, agentType: "llm_proxy", name: "Foreign log fixture",
    }, undefined, { skipCreationDefaultTools: true });
    const [otherUserLog, otherOrgLog] = await db.insert(schema.interactionsTable).values(
      [[gateway.id, member], [otherOrgAgent.id, owner]].map(([profileId, userId]) => ({
        profileId, userId, type: "openai:chatCompletions", request: {}, response: {},
      })),
    ).returning();
    for (const [id, visible] of [[ownInteraction.id, true], [otherUserLog.id, false], [otherOrgLog.id, false]]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(interactionCall(id));
      assert.equal(legacy.body.result.isError, !visible, JSON.stringify(legacy.body));
      if (visible) assert.deepEqual(legacy.body.result.structuredContent.interaction.request, ownInteraction.request);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(interactionCall(id)), legacy);
    }
    assert.equal(interactionRequests, 3);
    const beforeInteractionCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopInteraction = new AbortController();
    const interactionCancelled = assert.rejects(call(stopInteraction, "riir-interaction-cancel", getInteraction,
      { interaction_id: ownInteraction.id }), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native interaction did not respond"))]);
    } finally {
      stopInteraction.abort();
      await interactionCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("interaction relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeInteractionCancel)).toolResult.isError, true);
    assert.equal(interactionRequests, 4);
    holdToolReply = undefined;
    const tiedAt = "2026-01-02T00:00:00.123Z";
    const sharedSession = "riir-interaction-page";
    const pageRows = await db.insert(schema.interactionsTable).values(
      [[gateway.id, owner], [gateway.id, owner], [gateway.id, member], [otherOrgAgent.id, owner]].map(([profileId, userId]) => ({
        profileId, userId, sessionId: sharedSession, externalAgentId: "riir-page-client",
        createdAt: new Date(tiedAt), source: "guardrail:annotator", cost: "0.0000200000",
        type: "openai:chatCompletions", request: { messages: [] }, response: {},
      })),
    ).returning();
    const pageIds = pageRows.slice(0, 2).map(({ id }) => id).sort().reverse();
    const interactionPageArgs = {
      session_id: sharedSession, external_agent_id: "riir-page-client",
      start_date: tiedAt, end_date: tiedAt, user_id: member, limit: 1,
    };
    for (const [offset, ids] of [[0, [pageIds[0]]], [1, [pageIds[1]]], [2, []]]) {
      const args = { ...interactionPageArgs, offset };
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(interactionPage(args));
      const { data, pagination } = legacy.body.result.structuredContent;
      assert.equal(pagination.total, 2);
      assert.deepEqual(data.map(({ id }) => id), ids);
      for (const row of data) {
        assert.equal(row.requestType, "subagent");
        assert.equal(Object.hasOwn(row, "request"), false);
        assert.equal(Object.hasOwn(row, "response"), false);
      }
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(interactionPage(args)), legacy);
    }
    const beforeInteractionPageCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopInteractionPage = new AbortController();
    const interactionPageCancelled = assert.rejects(call(stopInteractionPage, "riir-interaction-page-cancel",
      listInteractions, interactionPageArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native interaction page did not respond"))]);
    } finally {
      stopInteractionPage.abort();
      await interactionPageCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("interaction page relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeInteractionPageCancel)).toolResult.isError, true);
    assert.equal(interactionPageRequests, 4);
    holdToolReply = undefined;

    const sessionAt = "2026-01-03T00:00:00.123Z";
    const [sessionA, sessionB, ungrouped] = await db.insert(schema.interactionsTable).values([
      { id: randomUUID(), sessionId: "riir-session-a", profileId: gateway.id, userId: owner, cost: "0.01" },
      { id: randomUUID(), sessionId: "riir-session-b", profileId: gateway.id, userId: owner, cost: "0.02", billingMode: "subscription" },
      { id: randomUUID(), profileId: gateway.id, userId: owner, cost: "0.03" },
      { sessionId: "riir-other-user", profileId: gateway.id, userId: member, cost: "99" },
      { sessionId: "riir-other-org", profileId: otherOrgAgent.id, userId: owner, cost: "99" },
      { sessionId: "riir-session-a", profileId: gateway.id, userId: member, cost: "99", createdAt: new Date("2026-01-03T00:00:00.000Z") },
      { sessionId: "riir-session-a", profileId: otherOrgAgent.id, userId: owner, cost: "99", createdAt: new Date("2026-01-03T00:00:00.001Z") },
    ].map((row) => ({
      createdAt: new Date(sessionAt), type: "openai:chatCompletions", request: {}, response: {}, ...row,
    }))).returning();
    const sessionArgs = { start_date: "2026-01-03T00:00:00.000Z", end_date: sessionAt, user_id: member, limit: 1 };
    const expectedSessions = [sessionA, sessionB, ungrouped].sort((a, b) => b.id.localeCompare(a.id));
    for (const stored of [false, true]) {
      if (stored) assert.equal(await InteractionSessionHeadModel.backfill(), "complete");
      let cursor = "malformed";
      for (const expectedSession of expectedSessions) {
        config.mcpGateway.rustDiscoverEnabled = false;
        const legacy = await post(sessionCall({ ...sessionArgs, cursor }));
        const { data, pagination } = legacy.body.result.structuredContent;
        assert.equal(data.length, 1);
        assert.equal(data[0].sessionId ?? data[0].interactionId, expectedSession.sessionId ?? expectedSession.id);
        assert.equal(data[0].requestCount, 1);
        assert.equal(data[0].totalCost, expectedSession.cost);
        assert.equal(data[0].totalSubscriptionCost, expectedSession.billingMode === "subscription" ? expectedSession.cost : null);
        config.mcpGateway.rustDiscoverEnabled = true;
        assert.deepEqual(await post(sessionCall({ ...sessionArgs, cursor })), legacy);
        cursor = pagination.nextCursor;
      }
      assert.equal(cursor, null);
    }
    const beforeSessionCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopSessions = new AbortController();
    const sessionsCancelled = assert.rejects(call(stopSessions, "riir-session-page-cancel", listSessions, sessionArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native session page did not respond"))]);
    } finally {
      stopSessions.abort();
      await sessionsCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("session page relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeSessionCancel)).toolResult.isError, true);
    assert.equal(sessionRequests, 7);
    holdToolReply = undefined;

    const sessionLogsArgs = { session_id: sharedSession, limit: 1 };
    for (const [args, ids, total] of [
      [{ ...sessionLogsArgs, offset: 0 }, [pageIds[1]], 2],
      [{ ...sessionLogsArgs, offset: 1 }, [pageIds[0]], 2],
      [{ ...sessionLogsArgs, offset: 2 }, [], 2],
      [{ session_id: ungrouped.id.toUpperCase() }, [ungrouped.id], 1],
      [{ session_id: otherOrgLog.id }, [], 0],
    ]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(sessionLogsCall(args));
      const { data, pagination } = legacy.body.result.structuredContent;
      assert.equal(pagination.total, total);
      assert.deepEqual(data.map(({ id }) => id), ids);
      if (args.session_id === sharedSession && data.length) assert.deepEqual(data[0].request, { messages: [] });
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(sessionLogsCall(args)), legacy);
    }
    const beforeSessionLogsCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopSessionLogs = new AbortController();
    const sessionLogsCancelled = assert.rejects(call(stopSessionLogs, "riir-session-logs-cancel", getSessionLogs, sessionLogsArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native session logs did not respond"))]);
    } finally {
      stopSessionLogs.abort();
      await sessionLogsCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("session logs relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeSessionLogsCancel)).toolResult.isError, true);
    assert.equal(sessionLogRequests, 6);
    holdToolReply = undefined;
    const createTeam = "archestra__create_team";
    const teamCreateArgs = {
      name: "Team creation parity fixture", description: "Created as a child", parent_id: ownTeam.id,
      roles: ["member"],
      labels: [{ key: "team-create", value: "first" }, { key: "team-create", value: "last" }],
    };
    const teamCreateCall = (args) => ({
      ...usageCall(createTeam), params: { name: createTeam, arguments: args },
    });
    const editTeam = "archestra__edit_team";
    const teamEditCall = (id, fields) => ({
      ...usageCall(editTeam), params: { name: editTeam, arguments: { id, ...fields } },
    });
    const deleteTeam = "archestra__delete_team";
    const addTeamMember = "archestra__add_team_member";
    const updateTeamMemberRole = "archestra__update_team_member_role";
    const removeTeamMember = "archestra__remove_team_member";
    const teamMemberRemoveCall = (teamId, userId) => ({
      ...usageCall(removeTeamMember),
      params: { name: removeTeamMember, arguments: { team_id: teamId, user_id: userId } },
    });
    const teamMemberRoleCall = (teamId, userId, role) => ({
      ...usageCall(updateTeamMemberRole),
      params: { name: updateTeamMemberRole, arguments: { team_id: teamId, user_id: userId, role } },
    });
    const teamMemberAddCall = (teamId, user, role) => ({
      ...usageCall(addTeamMember),
      params: { name: addTeamMember, arguments: { team_id: teamId, user, role } },
    });
    const teamDeleteCall = (id) => ({
      ...usageCall(deleteTeam), params: { name: deleteTeam, arguments: { id } },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyTeamDenied = await post(teamCreateCall(teamCreateArgs));
    assert.equal(legacyTeamDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(teamCreateCall(teamCreateArgs)), legacyTeamDenied);
    assert.equal(teamCreateRequests, 0);
    assert.equal(await TeamModel.findByName(teamCreateArgs.name, org), null);
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedTeamEdit = teamEditCall(ownTeam.id, { name: "Denied team rename fixture" });
    const legacyEditDenied = await post(deniedTeamEdit);
    assert.equal(legacyEditDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedTeamEdit), legacyEditDenied);
    assert.equal(teamEditRequests, 0);
    assert.equal((await TeamModel.findById(ownTeam.id)).name, ownTeam.name);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyDeleteDenied = await post(teamDeleteCall(ownTeam.id));
    assert.equal(legacyDeleteDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(teamDeleteCall(ownTeam.id)), legacyDeleteDenied);
    assert.equal(teamDeleteRequests, 0);
    assert.ok(await TeamModel.findById(ownTeam.id));
    const deniedTeamAdd = teamMemberAddCall(hiddenTeam.id, owner);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyAddDenied = await post(deniedTeamAdd);
    assert.equal(legacyAddDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedTeamAdd), legacyAddDenied);
    assert.equal(teamMemberAddRequests, 0);
    assert.deepEqual((await TeamModel.getTeamMembers(hiddenTeam.id)).map(({ userId }) => userId), [member]);
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedRole = teamMemberRoleCall(hiddenTeam.id, member, "member");
    const legacyRoleDenied = await post(deniedRole);
    assert.equal(legacyRoleDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedRole), legacyRoleDenied);
    assert.equal(teamMemberRoleRequests, 0);
    const deniedRemoval = teamMemberRemoveCall(hiddenTeam.id, member);
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyRemovalDenied = await post(deniedRemoval);
    assert.equal(legacyRemovalDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedRemoval), legacyRemovalDenied);
    assert.equal(teamMemberRemoveRequests, 0);
    const addExternalGroup = "archestra__add_team_external_group";
    const addExternalGroupCall = (teamId, fields) => ({
      ...usageCall(addExternalGroup), params: { name: addExternalGroup, arguments: { team_id: teamId, ...fields } },
    });
    const deniedExternalGroup = addExternalGroupCall(hiddenTeam.id, { group_identifier: "Denied group" });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyExternalGroupDenied = await post(deniedExternalGroup);
    assert.equal(legacyExternalGroupDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedExternalGroup), legacyExternalGroupDenied);
    assert.equal(externalGroupAddRequests, 0);
    const removeExternalGroup = "archestra__remove_team_external_group";
    const removeExternalGroupCall = (teamId, fields) => ({
      ...usageCall(removeExternalGroup), params: { name: removeExternalGroup, arguments: { team_id: teamId, ...fields } },
    });
    const deniedExternalUnlink = removeExternalGroupCall(hiddenTeam.id, { group_identifier: "fixture-hidden" });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyExternalUnlinkDenied = await post(deniedExternalUnlink);
    assert.equal(legacyExternalUnlinkDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(deniedExternalUnlink), legacyExternalUnlinkDenied);
    assert.equal(externalGroupRemoveRequests, 0);

    const createLimit = "archestra__create_limit";
    const createLimitArgs = {
      entity_type: "agent", entity_id: gateway.id, limit_type: "token_cost", limit_value: 23,
      model: ["fixture-model-a", "fixture-model-b"], reason: "  Fixture budget  ", behavior: "soft",
    };
    const createLimitCall = (args) => ({
      ...usageCall(createLimit), params: { name: createLimit, arguments: args },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedLimitCreate = await post(createLimitCall(createLimitArgs));
    assert.equal(deniedLimitCreate.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(createLimitCall(createLimitArgs)), deniedLimitCreate);
    assert.equal(limitCreateRequests, 0);
    await db.update(schema.membersTable).set({ role: "admin" }).where(eq(schema.membersTable.userId, owner));
    await t.test("create_agent preserves the initial policy transaction, staged setup and single-write audit", async () => {
      const tool = "archestra__create_agent";
      const agents = schema.agentsTable, policies = schema.resourcePermissionPoliciesTable, audit = schema.auditLogsTable;
      const rows = (name) => db.select().from(agents).where(and(eq(agents.organizationId, org), eq(agents.name, name)));
      const policyFor = (id) => ResourcePermissionPolicyModel.find({ organizationId: org, resource: "agent", scope: id });
      const policyScopes = () => db.select({ scope: policies.scope }).from(policies)
        .where(and(eq(policies.organizationId, org), eq(policies.resource, "agent"))).orderBy(policies.scope);
      const audits = () => db.select().from(audit).where(and(eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${tool}`))).orderBy(audit.eventSequence);
      const invoke = async (args, outcome) => {
        const before = (await audits()).length;
        const response = await post({ ...usageCall(tool), params: { name: tool, arguments: args } });
        assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
        const records = await audits();
        assert.equal(records.length, before + 1);
        const { action, actorId, resourceId, before: snapshot, after, outcome: actual } = records.at(-1);
        assert.deepEqual([action, actorId, resourceId, snapshot, after, actual], ["agent.created", owner, null, null, null, outcome]);
        return response;
      };
      const name = "Agent creation parity fixture";
      const args = {
        name, description: "Unicode fixture 🧪", icon: "🧪", systemPrompt: "Use the fixture.",
        toolExposureMode: "full", accessAllTools: true, accessAllSubagents: true,
        subagentLoadBalancing: { enabled: true, algorithm: "round_robin", retries: 2 },
        llmApiKeyId: ownKey.id, modelId: earlyModel.id,
        labels: [{ key: "create-agent-fixture", value: "first" }, { key: "create-agent-fixture", value: "final" }],
        suggestedPrompts: [{ summaryTitle: "Fixture", prompt: "Run the fixture" }],
        knowledgeBaseIds: [ownKb.id], connectorIds: [ownConnector.id],
        initialGrants: [{ subject: { type: "user", id: member }, actions: ["read"] }],
      };
      const differentActor = { name: `${name} denied`, initialGrants: [{ subject: { type: "user", id: randomUUID() }, actions: ["read"] }] };
      let denial;
      const parity = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const denied = await invoke(differentActor, "failure");
        if (native) assert.deepEqual(denied, denial);
        else denial = denied;
        assert.deepEqual(await rows(differentActor.name), []);
        assert.equal(agentCreateRequests, 0);

        const beforePolicies = await policyScopes();
        await db.execute(sql`ALTER TABLE resource_permission_policies ADD CONSTRAINT riir_reject_agent_policy CHECK (resource <> 'agent') NOT VALID`);
        const rejectedName = `${name} policy rollback`;
        let rejected;
        try {
          rejected = await invoke({ name: rejectedName }, "failure");
        } finally {
          await db.execute(sql`ALTER TABLE resource_permission_policies DROP CONSTRAINT riir_reject_agent_policy`);
        }
        assert.deepEqual(await rows(rejectedName), []);
        assert.deepEqual(await policyScopes(), beforePolicies);

        const setupFailureName = `${name} setup failure`;
        const previousFailures = new Set((await rows(setupFailureName)).map(({ id }) => id));
        await db.execute(sql`ALTER TABLE agent_labels ADD CONSTRAINT riir_reject_agent_label CHECK (false) NOT VALID`);
        let setupFailure;
        try {
          setupFailure = await invoke({ name: setupFailureName, labels: args.labels, accessAllTools: true }, "failure");
        } finally {
          await db.execute(sql`ALTER TABLE agent_labels DROP CONSTRAINT riir_reject_agent_label`);
        }
        const [staged, ...extraStaged] = (await rows(setupFailureName)).filter(({ id }) => !previousFailures.has(id));
        assert.ok(staged, "The agent row must still exist in the caller's organization");
        assert.deepEqual(extraStaged, []);
        assert.equal(staged.accessAllTools, false);
        assert.equal(staged.latestVersion, 0);
        assert.ok(await policyFor(staged.id));
        assert.deepEqual(await db.select().from(schema.agentLabelsTable).where(eq(schema.agentLabelsTable.agentId, staged.id)), []);

        const previousIds = new Set((await rows(name)).map(({ id }) => id));
        const response = await invoke(args, "success");
        const [row, ...extra] = (await rows(name)).filter(({ id }) => !previousIds.has(id));
        assert.deepEqual(extra, []);
        assert.deepEqual([row.agentType, row.authorId, row.slug, row.accessAllTools, row.toolExposureMode, row.latestVersion],
          ["agent", owner, null, true, "search_and_run_only", 1]);
        assert.deepEqual([row.description, row.icon, row.systemPrompt, row.llmApiKeyId, row.modelId, row.accessAllSubagents],
          [args.description, args.icon, args.systemPrompt, args.llmApiKeyId, args.modelId, true]);
        const detail = await AgentModel.findById(row.id);
        assert.deepEqual(detail.knowledgeBaseIds, args.knowledgeBaseIds);
        assert.deepEqual(detail.connectorIds, args.connectorIds);
        assert.deepEqual(detail.labels.map(({ key, value }) => ({ key, value })), [args.labels.at(-1)]);
        assert.deepEqual(detail.suggestedPrompts.map(({ summaryTitle, prompt }) => ({ summaryTitle, prompt })), args.suggestedPrompts);
        const policy = await policyFor(row.id);
        assert.equal(policy.legacySharingMigrated, true);
        assert.equal(policy.legacyOrganizationAudience, false);
        assert.ok(policy.grants.some(({ subject, actions }) => subject.id === owner && actions.includes("manage-permissions")));
        assert.deepEqual(policy.grants.find(({ subject }) => subject.id === member)?.actions, ["read"]);
        const version = await gatewayVersions(row.id);
        const { id, createdAt, updatedAt, ...stored } = row;
        parity.push({
          response: JSON.parse(JSON.stringify(response).replaceAll(id, "agent-id")), rejected, setupFailure,
          stored, grants: policy.grants, version, assignments: detail.tools.map(({ name }) => name).sort(),
          exclusions: await gatewayExclusions(id),
        });
      }
      assert.deepEqual(parity[1], parity[0]);
      assert.equal(agentCreateRequests, 3);
    });

    await t.test("edit_agent preserves Auto rollback, staged edits and single-write audit", async () => {
      const tool = "archestra__edit_agent";
      const agents = schema.agentsTable, audit = schema.auditLogsTable;
      const read = async (id) => (await db.select().from(agents).where(eq(agents.id, id)))[0];
      const auditRows = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${tool}`), eq(audit.resourceId, id),
      )).orderBy(audit.eventSequence);
      const oldLabels = [{ key: "edit-agent-fixture", value: "before" }];
      const newLabels = [{ key: "edit-agent-fixture", value: "after" }];
      const suggestions = [{ summaryTitle: "After", prompt: "Run the fixture." }];
      const readLabels = async (id) => (await AgentModel.findById(id)).labels.map(({ key, value }) => ({ key, value }));
      const runtimeScope = { organizationId: org, resource: "agentRuntime", scope: "*" };
      const runtimePolicy = await ResourcePermissionPolicyModel.find(runtimeScope);
      await ResourcePermissionPolicyModel.replace({
        ...runtimeScope, revision: runtimePolicy?.revision ?? 0,
        grants: [...(runtimePolicy?.grants ?? []), { subject: { type: "user", id: owner }, actions: ["configure"] }],
      });
      const parity = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const target = await AgentModel.create({
          organizationId: org, agentType: "agent", name: "Edit agent parity fixture",
          description: "Before", icon: "📝", systemPrompt: "Keep until explicitly cleared",
          runtime: buildCustomAgentRuntime({ image: "fixture.invalid/runtime:1" }),
          networkPolicy: { egressMode: "off" },
          llmApiKeyId: ownKey.id, modelId: earlyModel.id,
          knowledgeBaseIds: [ownKb.id], connectorIds: [ownConnector.id], labels: oldLabels,
        }, owner);
        const normalize = (value) => JSON.parse(JSON.stringify(value).replaceAll(target.id, "agent-id"));
        const invoke = async (id, fields, outcome) => {
          const before = (await auditRows(id)).length;
          const response = await post({ ...usageCall(tool), params: { name: tool, arguments: { id, ...fields } } });
          assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
          const records = await auditRows(id);
          assert.equal(records.length, before + 1);
          const row = records.at(-1);
          assert.deepEqual([row.action, row.actorId, row.resourceId, row.outcome], ["agent.updated", owner, id, outcome]);
          assert.ok(row.before);
          if (outcome === "failure") assert.equal(row.after, null);
          else assert.ok(row.after);
          const comparableSnapshot = (snapshot) => {
            if (!snapshot) return null;
            const { createdAt, labels, ...state } = snapshot;
            return { ...state, labels: labels.map(({ key, value }) => ({ key, value })) };
          };
          return normalize({ response, before: comparableSnapshot(row.before), after: comparableSnapshot(row.after) });
        };

        const { lastUsedAt: beforeUsage, ...gateBefore } = await read(gateway.id);
        const denied = await invoke(gateway.id, { name: "Wrong resource kind" }, "failure");
        const { lastUsedAt: afterUsage, ...gateAfter } = await read(gateway.id);
        assert.deepEqual(gateAfter, gateBefore);
        assert.equal(agentEditRequests, 0);

        const original = await read(target.id);
        const originalVersions = await gatewayVersions(target.id);
        await db.execute(sql`ALTER TABLE agent_excluded_tools ADD CONSTRAINT riir_reject_agent_prefill CHECK (false) NOT VALID`);
        let rolledBack;
        try {
          rolledBack = await invoke(target.id, { name: "Must roll back", accessAllTools: true, labels: newLabels }, "failure");
        } finally {
          await db.execute(sql`ALTER TABLE agent_excluded_tools DROP CONSTRAINT riir_reject_agent_prefill`);
        }
        assert.deepEqual(await read(target.id), original);
        assert.deepEqual(await gatewayExclusions(target.id), []);
        assert.deepEqual(await readLabels(target.id), oldLabels);
        assert.deepEqual(await gatewayVersions(target.id), originalVersions);

        await db.execute(sql`ALTER TABLE agent_labels ADD CONSTRAINT riir_reject_edit_labels CHECK (false) NOT VALID`);
        let partiallyApplied;
        try {
          partiallyApplied = await invoke(target.id, { description: "Committed before labels", labels: newLabels }, "failure");
        } finally {
          await db.execute(sql`ALTER TABLE agent_labels DROP CONSTRAINT riir_reject_edit_labels`);
        }
        const staged = await read(target.id);
        assert.equal(staged.description, "Committed before labels");
        assert.deepEqual(staged.runtime, original.runtime);
        assert.equal(staged.systemPrompt, original.systemPrompt);
        assert.deepEqual(await readLabels(target.id), oldLabels);
        assert.deepEqual(await gatewayVersions(target.id), originalVersions);

        const edited = await invoke(target.id, {
          name: "Agent renamed by parity fixture", description: null, icon: null, systemPrompt: null,
          runtime: null, networkPolicy: null, llmApiKeyId: null, modelId: null,
          accessAllTools: true, toolExposureMode: "full", accessAllSubagents: true,
          labels: newLabels, suggestedPrompts: suggestions, knowledgeBaseIds: [], connectorIds: [],
        }, "success");
        const { id, createdAt, updatedAt, ...stored } = await read(target.id);
        assert.deepEqual([stored.description, stored.icon, stored.systemPrompt, stored.runtime, stored.networkPolicy, stored.llmApiKeyId, stored.modelId],
          [null, null, null, null, null, null, null]);
        assert.deepEqual([stored.accessAllTools, stored.toolExposureMode, stored.accessAllSubagents, stored.latestVersion],
          [true, "search_and_run_only", true, 2]);
        const detail = await AgentModel.findById(target.id);
        assert.deepEqual([detail.knowledgeBaseIds, detail.connectorIds, await readLabels(target.id)], [[], [], newLabels]);
        const delegate = await db.select({ name: schema.toolsTable.name }).from(schema.toolsTable)
          .where(eq(schema.toolsTable.delegateToAgentId, target.id));
        assert.deepEqual(delegate, [{ name: "agent__agent_renamed_by_parity_fixture" }]);
        const exclusions = await gatewayExclusions(target.id);
        assert.ok(exclusions.includes(builtinIds.get("archestra__whoami")));
        assert.ok(!exclusions.includes(builtinIds.get("archestra__search_tools")));
        const relationshipOnly = await invoke(target.id, { labels: [], suggestedPrompts: [] }, "success");
        assert.deepEqual(await readLabels(target.id), []);
        const versions = await gatewayVersions(target.id);
        assert.deepEqual(versions.map(({ version }) => version), [1, 2, 3]);
        parity.push({ denied, rolledBack, partiallyApplied, edited, relationshipOnly, stored, exclusions, versions });
      }
      assert.deepEqual(parity[1], parity[0]);
      assert.equal(agentEditRequests, 3);
    });

    await t.test("reload_mcp_server_tools preserves replacement, partial commits and single-write audit", async () => {
      const tool = "archestra__reload_mcp_server_tools";
      const tools = schema.toolsTable, descriptions = schema.mcpServerToolDescriptionsTable, audit = schema.auditLogsTable;
      const [orgRow] = await db.select().from(schema.organizationsTable).where(eq(schema.organizationsTable.id, org));
      await db.update(schema.organizationsTable).set({ defaultNetworkPolicy: null }).where(eq(schema.organizationsTable.id, org));
      const request = (serverId) => ({ ...usageCall(tool), params: { name: tool, arguments: { serverId } } });
      const readTools = (id) => db.select().from(tools).where(eq(tools.catalogId, id)).orderBy(tools.rawName, tools.name);
      const readDescriptions = (id) => db.select().from(descriptions).where(eq(descriptions.mcpServerId, id)).orderBy(descriptions.description);
      const audits = () => db.select().from(audit).where(and(eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${tool}`))).orderBy(audit.eventSequence);
      const reported = (name, description) => ({ name, description, inputSchema: { type: "object" }, _meta: { source: "fixture" } });
      const responses = [];
      try {
        for (const native of [false, true]) {
          config.mcpGateway.rustDiscoverEnabled = native;
          const missing = await post(request(randomUUID()));
          assert.equal(missing.body.result.isError, true);
          assert.equal(reloadCatalogRequests, 0);
          const catalog = await InternalMcpCatalogModel.create({
            name: `Reload fixture ${native}`, serverType: "remote", serverUrl: `http://127.0.0.1:${remote.address().port}/reload`,
            environmentId: await AgentModel.findEnvironmentId(gateway.id),
          }, { organizationId: org, authorId: owner });
          const server = await McpServerModel.create({ name: catalog.name, catalogId: catalog.id, serverType: "remote", userId: owner });
          assert.ok(await McpServerModel.findById(server.id, owner, false));
          const sibling = await McpServerModel.create({ name: catalog.name, catalogId: catalog.id, serverType: "remote", ownerId: owner });
          const nameFor = await mintCatalogToolNames({ catalogId: catalog.id, rawToolNames: ["echo", "added"] });
          const [echo, duplicate, , unrelated] = await db.insert(tools).values([
            { catalogId: catalog.id, name: nameFor("echo"), rawName: "echo", deletedAt: new Date() },
            { catalogId: catalog.id, name: "old-prefix__echo", rawName: "echo" },
            { catalogId: catalog.id, name: "removed", rawName: "removed" },
            { catalogId: catalog.id, name: "unrelated", rawName: "unrelated", agentId: gateway.id },
          ]).returning();
          const assignments = schema.agentToolsTable;
          await db.insert(assignments).values({ agentId: gateway.id, toolId: duplicate.id, mcpServerId: server.id });
          await db.insert(descriptions).values({ mcpServerId: sibling.id, toolId: echo.id, description: "Sibling account" });
          const invoke = async (outcome) => {
            const before = (await audits()).length;
            const response = await post(request(server.id));
            assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
            const all = await audits();
            assert.equal(all.length, before + 1);
            const row = all.at(-1);
            assert.deepEqual([row.action, row.actorId, row.resourceId, row.outcome], ["mcpServer.updated", owner, server.id, outcome]);
            assert.ok(row.before);
            assert.deepEqual(row.after, outcome === "success" ? row.before : null);
            return JSON.parse(JSON.stringify(response).replaceAll(server.id, "server-id").replaceAll(catalog.name, "catalog-name"));
          };
          reloadTools = [reported("echo", "Updated"), reported("added", "New")];
          const created = await invoke("success");
          assert.deepEqual(created.body.result.structuredContent, { serverId: "server-id", created: 1, updated: 1, deleted: 2, unchanged: 0 });
          const [added, updated, kept] = await readTools(catalog.id);
          assert.equal(updated.id, echo.id);
          assert.equal(updated.deletedAt, null);
          assert.equal(updated.name, nameFor("echo"));
          assert.equal(added.name, nameFor("added"));
          assert.deepEqual(updated.parameters, { type: "object" });
          assert.deepEqual(updated.meta, { _meta: { source: "fixture" } });
          assert.equal(kept.id, unrelated.id);
          const [assignment] = await db.select().from(assignments).where(eq(assignments.toolId, echo.id));
          assert.deepEqual([assignment.agentId, assignment.mcpServerId, assignment.credentialResolutionMode], [gateway.id, server.id, "static"]);
          assert.deepEqual((await readDescriptions(server.id)).map(({ toolId, description }) => [toolId, description]), [[added.id, "New"], [echo.id, "Updated"]]);
          assert.deepEqual((await readDescriptions(sibling.id)).map(({ description }) => description), ["Sibling account"]);

          await db.insert(descriptions).values({ mcpServerId: server.id, toolId: unrelated.id, description: "Stale" });
          const before = await readDescriptions(server.id);
          reloadTools = [reported("echo", "Changed again"), reported("added", "New")];
          await db.execute(sql`ALTER TABLE mcp_server_tool_descriptions ADD CONSTRAINT riir_reject_description CHECK (false) NOT VALID`);
          let failure;
          try {
            failure = await invoke("failure");
          } finally {
            await db.execute(sql`ALTER TABLE mcp_server_tool_descriptions DROP CONSTRAINT riir_reject_description`);
          }
          assert.deepEqual(await readDescriptions(server.id), before);
          assert.equal((await readTools(catalog.id)).find(({ id }) => id === echo.id).description, "Changed again");
          reloadTools = [];
          const empty = await invoke("success");
          assert.deepEqual(empty.body.result.structuredContent, { serverId: "server-id", created: 0, updated: 0, deleted: 0, unchanged: 0 });
          assert.equal((await readTools(catalog.id)).length, 3);
          assert.deepEqual(await readDescriptions(server.id), []);
          responses.push({ missing, created, failure, empty });
        }
        assert.deepEqual(responses[0], responses[1]);
        assert.equal(reloadCatalogRequests, 10);
      } finally {
        await db.update(schema.organizationsTable).set({ defaultNetworkPolicy: orgRow.defaultNetworkPolicy }).where(eq(schema.organizationsTable.id, org));
      }
    });

    await t.test("deploy_mcp_server preserves installation identity, user link rollback and audit", async () => {
      assert.equal(McpServerRuntimeManager.isEnabled, false, "This fixture must not provision live Kubernetes resources");
      const name = "archestra__deploy_mcp_server";
      const request = (catalogId, scope, teamId) => ({
        ...usageCall(name), params: { name, arguments: { catalogId, scope, teamId } },
      });
      const installs = schema.mcpServersTable, links = schema.mcpServerUsersTable, audit = schema.auditLogsTable;
      const installations = (catalogId) => db.select().from(installs).where(eq(installs.catalogId, catalogId)).orderBy(installs.id);
      const userLinks = (id) => db.select().from(links).where(eq(links.mcpServerId, id));
      const audits = () => db.select().from(audit).where(and(eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${name}`)))
        .orderBy(audit.eventSequence);
      const expectedAudit = [];
      const invoke = async (call, outcome) => {
        const response = await post(call);
        assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
        expectedAudit.push(["mcpServer.created", owner, outcome, null]);
        assert.deepEqual((await audits()).map(({ action, actorId, outcome, resourceId }) => [action, actorId, outcome, resourceId]), expectedAudit);
        return response;
      };
      const makeCatalog = (requiresAuth = false) => InternalMcpCatalogModel.create({
        name: "Deployment parity fixture", serverType: "local", requiresAuth, localConfig: { command: "node" },
      }, { organizationId: org, authorId: owner });
      const restricted = await makeCatalog(true);
      const deniedCall = request(restricted.id, "personal");
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await invoke(deniedCall, "failure");
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await invoke(deniedCall, "failure"), denied);
      assert.deepEqual(await installations(restricted.id), []);
      assert.equal(deployCatalogRequests, 0);

      const parity = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const item = await makeCatalog();
        const personal = request(item.id, "personal");
        await db.execute(sql`ALTER TABLE mcp_server_user ADD CONSTRAINT riir_reject_install_user CHECK (false) NOT VALID`);
        let rolledBack;
        try {
          rolledBack = await invoke(personal, "failure");
        } finally {
          await db.execute(sql`ALTER TABLE mcp_server_user DROP CONSTRAINT riir_reject_install_user`);
        }
        assert.deepEqual(await installations(item.id), []);
        const results = [rolledBack];
        const storedRows = [];
        for (const [scope, teamId] of [["personal", undefined], ["team", ownTeam.id]]) {
          const call = request(item.id, scope, teamId);
          const created = await invoke(call, "success");
          const stored = (await installations(item.id)).find((row) => row.scope === scope);
          assert.ok(stored);
          assert.equal(stored.ownerId, owner);
          assert.equal(stored.teamId, teamId ?? null);
          assert.equal(stored.name, `${item.name}-${teamId ?? owner}`);
          assert.equal(stored.deploymentName, constructFrozenMcpDeploymentName(stored.name, stored.id));
          assert.equal(stored.localInstallationStatus, "idle");
          assert.equal(stored.secretId, null);
          assert.deepEqual((await userLinks(stored.id)).map(({ userId }) => userId), [owner]);
          const repeated = await invoke(call, scope === "personal" ? "success" : "failure");
          assert.deepEqual((await installations(item.id)).filter((row) => row.scope === scope), [stored]);
          results.push(...[created, repeated].map((response) => JSON.parse(JSON.stringify(response).replaceAll(stored.id, "install-id"))));
          const { id, catalogId, deploymentName, createdAt, updatedAt, lastUsedAt, ...rest } = stored;
          storedRows.push(rest);
        }
        assert.equal((await installations(item.id)).length, 2);
        parity.push({ results, storedRows });
      }
      assert.deepEqual(parity[0], parity[1]);
      assert.equal(deployCatalogRequests, 3);
    });

    await t.test("deployment discovery preserves scoped assignments, staged rollback and single-write audit", async () => {
      const tool = "archestra__deploy_mcp_server";
      const tools = schema.toolsTable, installs = schema.mcpServersTable;
      const descriptions = schema.mcpServerToolDescriptionsTable, assignments = schema.agentToolsTable, audit = schema.auditLogsTable;
      const [orgRow] = await db.select().from(schema.organizationsTable).where(eq(schema.organizationsTable.id, org));
      const initialWrites = reloadCatalogRequests, initialInstalls = deployCatalogRequests;
      const initialLists = deploymentLists;
      const catalogName = "Deployment discovery fixture";
      const environmentId = await AgentModel.findEnvironmentId(gateway.id);
      const assignmentTarget = await AgentModel.create({
        name: "Deployment discovery assignment fixture", agentType: "agent", organizationId: org, environmentId,
      }, owner, { skipCreationDefaultTools: true });
      const outsideTarget = await AgentModel.create({
        name: "Out-of-environment deployment assignment fixture", agentType: "agent", organizationId: org,
        environmentId: environmentId === otherEnvironment.id ? null : otherEnvironment.id,
      }, owner, { skipCreationDefaultTools: true });
      const storedInstalls = (catalogId) => db.select().from(installs).where(eq(installs.catalogId, catalogId));
      const audits = () => db.select().from(audit).where(and(eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${tool}`))).orderBy(audit.eventSequence);
      const makeCatalog = (requiresAuth = false) => InternalMcpCatalogModel.create({
        name: catalogName, serverType: "remote", environmentId, requiresAuth,
        serverUrl: `http://127.0.0.1:${remote.address().port}/deploy-discovery`,
      }, { organizationId: org, authorId: owner });
      const invoke = async (catalogId, outcome, agentIds = [assignmentTarget.id]) => {
        const before = (await audits()).length;
        const response = await post({ ...usageCall(tool), params: { name: tool, arguments: { catalogId, agentIds } } });
        assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
        const records = await audits();
        assert.equal(records.length, before + 1);
        const row = records.at(-1);
        assert.deepEqual([row.action, row.actorId, row.resourceId, row.outcome, row.before, row.after],
          ["mcpServer.created", owner, null, outcome, null, null]);
        return response;
      };
      const reported = (name, description) => ({ name, description, inputSchema: { type: "object" }, _meta: { source: "deployment" } });
      deploymentTools = [reported("existing", "From discovery"), reported("added", "New tool")];
      await db.update(schema.organizationsTable).set({ defaultNetworkPolicy: null }).where(eq(schema.organizationsTable.id, org));
      const parity = [];
      try {
        const restricted = await makeCatalog(true);
        for (const native of [false, true]) {
          config.mcpGateway.rustDiscoverEnabled = native;
          const denied = await invoke(restricted.id, "failure");
          assert.deepEqual(await storedInstalls(restricted.id), []);
          assert.equal(reloadCatalogRequests, initialWrites);
          assert.equal(deployCatalogRequests, initialInstalls);
          const cases = [];
          for (const scenario of ["success", "descriptions", "repin", "denied-target"]) {
            const catalog = await makeCatalog();
            const nameFor = await mintCatalogToolNames({ catalogId: catalog.id, rawToolNames: deploymentTools.map(({ name }) => name) });
            const [proxy] = await db.insert(tools).values({ name: nameFor("existing"), description: "Proxy copy" }).returning();
            const [original] = await db.insert(assignments).values({
              agentId: assignmentTarget.id, toolId: proxy.id, credentialResolutionMode: "dynamic",
            }).returning();
            if (scenario === "descriptions") {
              await db.execute(sql`ALTER TABLE mcp_server_tool_descriptions ADD CONSTRAINT riir_reject_deploy_descriptions CHECK (false) NOT VALID`);
            } else if (scenario === "repin") {
              await db.execute(sql`ALTER TABLE agent_tools ADD CONSTRAINT riir_reject_deploy_repin
                CHECK (credential_resolution_mode <> 'dynamic' OR mcp_server_id IS NULL) NOT VALID`);
            }
            const writesBefore = reloadCatalogRequests;
            let response;
            try {
              // Remote discovery is best-effort after installation. Even when
              // a stage fails the public deploy result succeeds.
              response = await invoke(catalog.id, "success", scenario === "denied-target"
                ? [assignmentTarget.id, outsideTarget.id]
                : [assignmentTarget.id, assignmentTarget.id]);
            } finally {
              if (scenario === "descriptions") await db.execute(sql`ALTER TABLE mcp_server_tool_descriptions DROP CONSTRAINT riir_reject_deploy_descriptions`);
              if (scenario === "repin") await db.execute(sql`ALTER TABLE agent_tools DROP CONSTRAINT riir_reject_deploy_repin`);
            }
            assert.equal(reloadCatalogRequests - writesBefore, native ? (scenario === "success" || scenario === "repin" ? 6 : 4) : 0);
            const [server, ...extra] = await storedInstalls(catalog.id);
            assert.ok(server);
            assert.deepEqual(extra, []);
            const [added, existing] = await db.select().from(tools).where(eq(tools.catalogId, catalog.id)).orderBy(tools.rawName);
            assert.equal(existing.id, proxy.id);
            assert.deepEqual([added.name, existing.name], [nameFor("added"), nameFor("existing")]);
            const synced = [added, existing].map(({ rawName, description, parameters, meta }) => ({ rawName, description, parameters, meta }));
            assert.deepEqual(synced, [...deploymentTools].reverse().map(({ name, description, inputSchema, _meta }) => ({
              rawName: name, description, parameters: inputSchema, meta: { _meta },
            })));
            const reportedRows = await db.select().from(descriptions).where(eq(descriptions.mcpServerId, server.id)).orderBy(descriptions.description);
            assert.deepEqual(reportedRows.map(({ toolId, description }) => [toolId, description]),
              scenario === "descriptions" ? [] : [[existing.id, "From discovery"], [added.id, "New tool"]]);
            const existingPairs = await db.select().from(assignments).where(eq(assignments.toolId, existing.id));
            assert.deepEqual(existingPairs.map(({ id, agentId, credentialResolutionMode, mcpServerId }) => [id, agentId, credentialResolutionMode, mcpServerId]),
              [[original.id, assignmentTarget.id, "dynamic", scenario === "success" ? server.id : null]]);
            if (scenario !== "success") assert.deepEqual(existingPairs[0], original);
            const newPairs = await db.select().from(assignments).where(eq(assignments.toolId, added.id));
            assert.deepEqual(newPairs.map(({ agentId, credentialResolutionMode, mcpServerId }) => [agentId, credentialResolutionMode, mcpServerId]),
              scenario === "success" || scenario === "repin" ? [[assignmentTarget.id, "static", server.id]] : []);
            cases.push({ response: JSON.parse(JSON.stringify(response).replaceAll(server.id, "install-id")), synced });
          }
          parity.push({ denied, cases });
        }
        assert.deepEqual(parity[1], parity[0]);
        assert.equal(deploymentLists - initialLists, 8);
        assert.equal(deployCatalogRequests - initialInstalls, 4);
        assert.equal(reloadCatalogRequests - initialWrites, 20);
      } finally {
        await db.update(schema.organizationsTable).set({ defaultNetworkPolicy: orgRow.defaultNetworkPolicy }).where(eq(schema.organizationsTable.id, org));
      }
    });

    await t.test("create_mcp_server preserves catalog, initial policy rollback and audit", async () => {
      const tool = "archestra__create_mcp_server";
      const request = (args) => ({ ...usageCall(tool), params: { name: tool, arguments: args } });
      const entries = schema.internalMcpCatalogTable, policies = schema.resourcePermissionPoliciesTable;
      const audit = schema.auditLogsTable;
      const readRows = (name) => db.select().from(entries).where(and(eq(entries.organizationId, org), eq(entries.name, name)));
      const readPolicy = (id) => ResourcePermissionPolicyModel.find({ organizationId: org, resource: "mcpRegistry", scope: id });
      const policyRows = () => db.select().from(policies).where(and(eq(policies.organizationId, org), eq(policies.resource, "mcpRegistry")))
        .orderBy(policies.scope);
      const audits = () => db.select().from(audit).where(and(eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${tool}`)))
        .orderBy(audit.eventSequence);
      const outcomes = [];
      const invoke = async (args, outcome) => {
        const response = await post(request(args));
        assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
        outcomes.push(outcome);
        const records = await audits();
        assert.deepEqual(records.map(({ outcome }) => outcome), outcomes);
        const record = records.at(-1);
        assert.deepEqual([record.action, record.actorId, record.resourceId, record.before, record.after],
          ["internalMcpCatalog.created", owner, null, null, null]);
        return response;
      };
      const name = "MCP catalog creation parity fixture";
      const targetEnv = await EnvironmentModel.create({ organizationId: org, authorId: owner, name: name });
      const environment = { key: "FIXTURE_TOKEN", type: "secret", promptOnInstallation: false };
      const token = randomUUID();
      const initialGrants = [{ subject: { type: "user", id: member }, actions: ["read"] }];
      const args = { name, serverType: "local", command: "node", arguments: ["fixture.mjs"],
        environmentId: targetEnv.id, initialGrants,
        description: "Fixture description", labels: [{ key: "fixture", value: "original" }, { key: "fixture", value: "final" }] };
      const badGrant = { ...args, initialGrants: [{ subject: { type: "user", id: randomUUID() }, actions: ["read"] }] };
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await invoke(badGrant, "failure");
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await invoke(badGrant, "failure"), denied);
      assert.deepEqual(await readRows(name), []);
      assert.equal(createCatalogRequests, 0);

      const parity = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const rejectedName = `${name} rejected ${native}`;
        const beforePolicies = await policyRows();
        await db.execute(sql`ALTER TABLE resource_permission_policies ADD CONSTRAINT riir_reject_mcp_create
          CHECK (resource <> 'mcpRegistry') NOT VALID`);
        let rejected;
        try {
          rejected = await invoke({ ...args, name: rejectedName }, "failure");
        } finally {
          await db.execute(sql`ALTER TABLE resource_permission_policies DROP CONSTRAINT riir_reject_mcp_create`);
        }
        assert.deepEqual(await readRows(rejectedName), []);
        assert.deepEqual(await policyRows(), beforePolicies);

        const createdName = `${name} ${native}`;
        const response = await invoke({ ...args, name: createdName, environment: [{ ...environment, value: token }] }, "success");
        const [stored, ...extra] = await readRows(createdName);
        assert.deepEqual(extra, []);
        assert.equal(stored.authorId, owner);
        assert.equal(stored.environmentId, targetEnv.id);
        assert.equal(stored.scope, "personal");
        assert.deepEqual(stored.localConfig, { command: "node", arguments: ["fixture.mjs"], environment: [environment] });
        assert.ok(stored.localConfigSecretId);
        assert.deepEqual((await SecretModel.findById(stored.localConfigSecretId)).secret, { FIXTURE_TOKEN: token });
        const policy = await readPolicy(stored.id);
        assert.ok(policy.legacySharingMigrated);
        assert.equal(policy.legacyOrganizationAudience, false);
        assert.ok(policy.grants.find(({ subject, actions }) => subject.id === owner && actions.includes("manage-permissions")));
        assert.deepEqual(policy.grants.find(({ subject }) => subject.id === member)?.actions, ["read"]);
        const item = await InternalMcpCatalogModel.findById(stored.id, { expandSecrets: false });
        assert.equal(item.labels.length, 1);
        assert.deepEqual(item.labels.map(({ key, value }) => [key, value]), [["fixture", "final"]]);
        assert.equal(JSON.stringify(response).includes(token), false);
        const normalize = (value) => JSON.parse(JSON.stringify(value).replaceAll(stored.id, "catalog-id").replaceAll(createdName, name));
        const { id, name: _, localConfigSecretId, createdAt, updatedAt, ...record } = stored;
        parity.push({ response: normalize(response), rejected, record, grants: policy.grants });
      }
      assert.deepEqual(parity[0], parity[1]);
      assert.equal(createCatalogRequests, 2);
    });

    await t.test("edit_mcp_config preserves credential separation, image approval and auditing", async () => {
      const name = "archestra__edit_mcp_config";
      const request = (id, patch) => ({ ...usageCall(name), params: { name, arguments: { id, ...patch } } });
      const entries = schema.internalMcpCatalogTable, audit = schema.auditLogsTable;
      const row = async (id) => (await db.select().from(entries).where(eq(entries.id, id)))[0];
      const audits = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const env = { key: "FIXTURE_TOKEN", type: "secret", promptOnInstallation: false };
      const originalToken = randomUUID(), token = randomUUID();
      const localConfig = { command: "node", arguments: ["fixture.mjs"], dockerImage: "fixture.invalid/mcp:1", environment: [env] };
      const makeEntry = async (environmentId = null) => {
        const bag = await SecretModel.create({ name: `mcp-config-fixture-${randomUUID()}`, secret: { FIXTURE_TOKEN: originalToken } });
        const entry = await InternalMcpCatalogModel.create({
          name: "Runtime configuration fixture", serverType: "local", environmentId, localConfig, localConfigSecretId: bag.id,
        }, { organizationId: org, authorId: owner });
        await db.update(entries).set({
          catalogItemApprovalStatus: "approved", catalogItemApprovalReason: "Reviewed fixture",
          catalogItemApprovalReviewedBy: owner, catalogItemApprovalReviewedAt: new Date(),
        }).where(eq(entries.id, entry.id));
        return entry.id;
      };
      const isolated = await makeEntry(otherEnvironment.id);
      const isolatedBefore = await row(isolated);
      const deniedPatch = { environment: [{ ...env, value: token }] };
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(request(isolated, deniedPatch));
      assert.equal(denied.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(request(isolated, deniedPatch)), denied);
      assert.deepEqual(await row(isolated), isolatedBefore);
      assert.deepEqual((await SecretModel.findById(isolatedBefore.localConfigSecretId)).secret, { FIXTURE_TOKEN: originalToken });
      assert.deepEqual((await audits(isolated)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(editCatalogConfigRequests, 0);

      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const id = await makeEntry();
        const before = await row(id);
        const localBefore = await InternalMcpCatalogModel.findById(id, { expandSecrets: false, includeWriteRevision: true });
        const rotated = await post(request(id, { ...deniedPatch, arguments: [] }));
        assert.equal(rotated.body.result.isError, false, JSON.stringify(rotated.body));
        assert.equal(JSON.stringify(rotated).includes(token), false);
        const after = await row(id);
        assert.deepEqual(after, { ...before, localConfig: { ...localConfig, arguments: [] }, updatedAt: after.updatedAt });
        assert.deepEqual((await SecretModel.findById(before.localConfigSecretId)).secret, { FIXTURE_TOKEN: token });
        if (native) {
          assert.equal(await callRustApi({
            socketPath: socket, path: "/internal/v1/mcp/tools/edit-mcp-config",
            json: JSON.stringify({ id, organizationId: org, environmentId: null, revision: localBefore.writeRevision,
              fields: { localConfig: { ...localConfig, dockerImage: "fixture.invalid/mcp:stale" } } }),
          }), false);
          assert.deepEqual(await row(id), after);
        }
        await db.execute(sql`ALTER TABLE internal_mcp_catalog ADD CONSTRAINT riir_reject_mcp_config
          CHECK (installation_command IS DISTINCT FROM 'rejected-fixture') NOT VALID`);
        let rejected;
        try {
          rejected = await post(request(id, { dockerImage: "fixture.invalid/mcp:2", installationCommand: "rejected-fixture" }));
        } finally {
          await db.execute(sql`ALTER TABLE internal_mcp_catalog DROP CONSTRAINT riir_reject_mcp_config`);
        }
        assert.equal(rejected.body.result.isError, true);
        assert.deepEqual(await row(id), after);
        const replaced = await post(request(id, { dockerImage: "fixture.invalid/mcp:2" }));
        assert.equal(replaced.body.result.isError, false);
        const final = await row(id);
        assert.deepEqual(final, { ...after, localConfig: { ...after.localConfig, dockerImage: "fixture.invalid/mcp:2" },
          catalogItemApprovalStatus: null, catalogItemApprovalReason: null, catalogItemApprovalReviewedBy: null,
          catalogItemApprovalReviewedAt: null, updatedAt: final.updatedAt });
        const records = await audits(id);
        assert.deepEqual(records.map(({ action, actorId, outcome }) => ({ action, actorId, outcome })),
          ["success", "failure", "success"].map((outcome) => ({ action: "internalMcpCatalog.updated", actorId: owner, outcome })));
        assert.equal(records[0].after.hasLocalConfigSecret, true);
        assert.equal(records[1].after, null);
        assert.equal(JSON.stringify(records).includes(token), false);
        responses.push([rotated, rejected, replaced].map((response) => JSON.parse(JSON.stringify(response).replaceAll(id, "catalog-id"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(editCatalogConfigRequests, 3);
    });

    await t.test("edit_mcp_description preserves metadata, label rollback and single-write audit", async () => {
      const name = "archestra__edit_mcp_description";
      const request = (id, patch) => ({ ...usageCall(name), params: { name, arguments: { id, ...patch } } });
      const entries = schema.internalMcpCatalogTable, audit = schema.auditLogsTable;
      const row = async (id) => (await db.select().from(entries).where(eq(entries.id, id)))[0];
      const audits = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const makeEntry = (environmentId = null) => InternalMcpCatalogModel.create({
        name: "MCP metadata fixture", serverType: "remote", serverUrl: "https://metadata.example.invalid/mcp",
        environmentId, description: "Original description", docsUrl: "https://metadata.example.invalid/docs",
        labels: [{ key: "metadata-fixture", value: "original" }],
      }, { organizationId: org, authorId: owner });
      const { id: isolated } = await makeEntry(otherEnvironment.id);
      const isolatedBefore = await row(isolated);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(request(isolated, { description: "Denied" }));
      assert.equal(denied.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(request(isolated, { description: "Denied" })), denied);
      assert.deepEqual(await row(isolated), isolatedBefore);
      assert.deepEqual((await audits(isolated)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(editCatalogDescriptionRequests, 0);

      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { id } = await makeEntry();
        const before = await row(id);
        const changed = await post(request(id, { description: null, icon: "🔧", instructions: "Usage fixture" }));
        assert.equal(changed.body.result.isError, false, JSON.stringify(changed.body));
        const updated = await row(id);
        assert.deepEqual(updated, { ...before, description: null, icon: "🔧", instructions: "Usage fixture", updatedAt: updated.updatedAt });
        const replacement = [{ key: "metadata-fixture", value: "replaced" }, { key: "source-fixture", value: "catalog" }];
        const labelsOnly = await post(request(id, { labels: replacement }));
        assert.equal(labelsOnly.body.result.isError, false);
        assert.deepEqual(await row(id), updated);
        const labels = async () => (await InternalMcpCatalogModel.findById(id, { expandSecrets: false })).labels
          .map(({ key, value }) => ({ key, value }));
        assert.deepEqual(await labels(), replacement);
        const rejected = await post(request(id, { description: "Committed metadata", labels: [
          { key: "metadata-fixture", value: "rejected" }, { key: "metadata-fixture", value: "duplicate" },
        ] }));
        assert.equal(rejected.body.result.isError, true);
        const partial = await row(id);
        assert.deepEqual(partial, { ...updated, description: "Committed metadata", updatedAt: partial.updatedAt });
        assert.deepEqual(await labels(), replacement);
        const cleared = await post(request(id, { labels: [] }));
        assert.equal(cleared.body.result.isError, false);
        assert.deepEqual(await labels(), []);
        assert.deepEqual(await row(id), partial);
        const records = await audits(id);
        assert.deepEqual(records.map(({ action, actorId, outcome }) => ({ action, actorId, outcome })),
          ["success", "success", "failure", "success"].map((outcome) =>
            ({ action: "internalMcpCatalog.updated", actorId: owner, outcome })));
        assert.equal(records[0].before.description, before.description);
        assert.equal(records[0].after.description, null);
        assert.equal(records[2].after, null);
        assert.equal(records[3].after.description, partial.description);
        responses.push([changed, labelsOnly, rejected, cleared].map((response) =>
          JSON.parse(JSON.stringify(response).replaceAll(id, "catalog-id"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(editCatalogDescriptionRequests, 4);
    });

    await t.test("bulk tool assignment preserves credential updates, duplicates, partial failures and audit", async () => {
      const pin = await McpServerModel.create({
        name: catalog.name, catalogId: catalog.id, serverType: "remote", ownerId: owner, scope: "org",
      });
      const existingToolId = builtinIds.get("archestra__whoami"), newToolId = builtinIds.get("archestra__list_teams");
      assert.ok(existingToolId && newToolId);
      const missingToolId = randomUUID();
      const assignments = schema.agentToolsTable;
      const audit = schema.auditLogsTable;
      const rows = (id) => db.select().from(assignments).where(eq(assignments.agentId, id)).orderBy(assignments.toolId);
      for (const [type, tool, idField] of [
        ["agent", "archestra__bulk_assign_tools_to_agents", "agentId"],
        ["mcp_gateway", "archestra__bulk_assign_tools_to_mcp_gateways", "mcpGatewayId"],
      ]) {
        const request = (items) => ({
          ...usageCall(tool), params: { name: tool, arguments: { assignments: items } },
        });
        const audits = () => db.select().from(audit).where(and(
          eq(audit.organizationId, org), eq(audit.resourceId, org), eq(audit.httpPath, `mcp-tool:${tool}`),
        )).orderBy(audit.eventSequence);
        const makeTarget = (environmentId = null) => AgentModel.create({
          organizationId: org, agentType: type, name: `Assignment parity ${type}`, accessAllTools: false, environmentId,
        }, owner, { skipCreationDefaultTools: true });
        const { id: isolatedId } = await makeTarget(otherEnvironment.id);
        const isolatedBefore = await rows(isolatedId);
        const parity = [];
        for (const native of [false, true]) {
          config.mcpGateway.rustDiscoverEnabled = native;
          const { id } = await makeTarget();
          const pinned = await AgentToolModel.create(id, echo.id, { mcpServerId: pin.id });
          const unchanged = await AgentToolModel.create(id, existingToolId);
          await AgentVersionModel.forkIfChanged(id);
          const beforeVersions = await gatewayVersions(id);
          const auditBefore = await audits();
          const insert = { [idField]: id, toolId: newToolId };
          const change = { [idField]: id, toolId: echo.id, resolveAtCallTime: true };
          const duplicate = { [idField]: id, toolId: existingToolId };
          const failures = [
            { [idField]: id, toolId: missingToolId },
            { [idField]: isolatedId, toolId: existingToolId },
            { [idField]: id, toolId: echo.id, mcpServerId: installation.id },
          ];
          const response = await post(request([change, failures[0], duplicate, failures[1], insert, failures[2]]));
          assert.equal(response.body.result.isError, false, JSON.stringify(response.body));
          const result = response.body.result.structuredContent;
          assert.deepEqual(result.succeeded, [change, insert].map(({ toolId }) => ({ [idField]: id, toolId })));
          assert.deepEqual(result.duplicates, [duplicate]);
          assert.deepEqual(result.failed.map((entry) => entry.errorCode ?? null), ["not_found", null, "validation_error"]);
          const stored = await rows(id);
          const changed = stored.find(({ toolId }) => toolId === echo.id);
          assert.deepEqual(changed, { ...pinned, mcpServerId: null, credentialResolutionMode: "dynamic", updatedAt: changed?.updatedAt });
          assert.ok(changed.updatedAt >= pinned.updatedAt);
          assert.deepEqual(stored.find(({ toolId }) => toolId === existingToolId), unchanged);
          assert.equal(stored.find(({ toolId }) => toolId === newToolId)?.credentialResolutionMode, "static");
          assert.deepEqual(await rows(isolatedId), isolatedBefore);
          const versions = await gatewayVersions(id);
          assert.equal(versions.length, beforeVersions.length + 1);
          const retry = await post(request([change, duplicate, insert]));
          assert.deepEqual(retry.body.result.structuredContent, {
            succeeded: [], failed: [], duplicates: [change, duplicate, insert].map(({ toolId }) => ({ [idField]: id, toolId })),
          });
          assert.deepEqual(await rows(id), stored);
          assert.deepEqual(await gatewayVersions(id), versions);
          const records = await audits();
          assert.equal(records.length, auditBefore.length + 2);
          assert.deepEqual(records.slice(-2).map(({ action, actorId, outcome, before, after }) =>
            [action, actorId, outcome, after.agentToolAssignmentCount - before.agentToolAssignmentCount]),
          [1, 0].map((delta) => ["agentTool.bulk_assigned", owner, "success", delta]));
          parity.push([response, retry].map((entry) => JSON.parse(JSON.stringify(entry).replaceAll(id, "target-id"))));
        }
        assert.deepEqual(parity[0], parity[1]);
      }
      assert.equal(assignAgentToolRequests, 12);
    });

    await t.test("bulk_remove_tools_from_agents preserves Auto exclusions, Custom removals and partial failures", async () => {
      const name = "archestra__bulk_remove_tools_from_agents";
      const request = (removals) => ({
        ...usageCall(name), params: { name, arguments: { removals } },
      });
      const [secondTool, sibling] = await Promise.all(["second", "sibling"].map((label) =>
        ToolModel.createToolIfNotExists({ name: `${catalog.name}__${label}`, rawName: label,
          description: "Bulk removal fixture", parameters: { type: "object" }, catalogId: catalog.id })));
      const metaToolId = builtinIds.get("archestra__run_tool");
      assert.ok(metaToolId);
      const unknownToolId = randomUUID(), missingAgentId = randomUUID();
      const assignments = schema.agentToolsTable, exclusions = schema.agentExcludedToolsTable;
      const audit = schema.auditLogsTable;
      const assigned = async (id) => (await db.select({ toolId: assignments.toolId }).from(assignments)
        .where(eq(assignments.agentId, id)).orderBy(assignments.toolId)).map(({ toolId }) => toolId);
      const excluded = async (id) => (await db.select({ toolId: exclusions.toolId }).from(exclusions)
        .where(eq(exclusions.agentId, id)).orderBy(exclusions.toolId)).map(({ toolId }) => toolId);
      const readAudit = () => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, org), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const outputs = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const makeTarget = (accessAllTools, environmentId = null) => AgentModel.create({
          organizationId: org, agentType: "agent", name: "Tool removal fixture", accessAllTools, environmentId,
        }, owner, { skipCreationDefaultTools: true });
        const [auto, custom, isolated] = await Promise.all([
          makeTarget(true), makeTarget(false), makeTarget(false, otherEnvironment.id),
        ]);
        for (const agent of [auto, custom, isolated]) {
          await AgentToolModel.create(agent.id, echo.id, { mcpServerId: installation.id });
        }
        await db.insert(exclusions).values({ agentId: auto.id, toolId: sibling.id });
        await AgentVersionModel.forkIfChanged(auto.id);
        await AgentVersionModel.forkIfChanged(custom.id);
        const [initialExclusions, initialAutoAssignments, initialCustomAssignments, autoVersions, customVersions] =
          await Promise.all([excluded(auto.id), assigned(auto.id), assigned(custom.id), gatewayVersions(auto.id), gatewayVersions(custom.id)]);
        const auditBefore = await readAudit();
        const successes = [
          { agentId: auto.id, toolId: echo.id },
          { agentId: custom.id, toolId: echo.id },
          { agentId: auto.id, toolId: secondTool.id },
        ];
        const missing = { agentId: custom.id, toolId: unknownToolId };
        const invalid = [
          { agentId: auto.id, toolId: unknownToolId },
          { agentId: auto.id, toolId: metaToolId },
          { agentId: missingAgentId, toolId: echo.id },
          { agentId: isolated.id, toolId: echo.id },
        ];
        const notices = [];
        const unsubscribe = onAgentToolSurfaceChange((id) => notices.push(id));
        let response;
        try {
          response = await post(request([successes[0], invalid[0], successes[1], missing, ...invalid.slice(1), successes[2]]));
        } finally {
          unsubscribe();
        }
        assert.equal(response.body.result.isError, false, JSON.stringify(response.body));
        const result = response.body.result.structuredContent;
        assert.deepEqual(result.succeeded, successes);
        assert.deepEqual(result.notAssigned, [missing]);
        assert.deepEqual(result.failed.map(({ agentId, toolId }) => ({ agentId, toolId })), invalid);
        assert.deepEqual(notices, [auto.id, auto.id]);
        assert.deepEqual(await excluded(auto.id), [...new Set([...initialExclusions, echo.id, secondTool.id])].sort());
        assert.deepEqual(await assigned(auto.id), initialAutoAssignments);
        assert.deepEqual(await assigned(custom.id), initialCustomAssignments.filter((id) => id !== echo.id));
        assert.ok((await assigned(isolated.id)).includes(echo.id));
        for (const [id, versions] of [[auto.id, autoVersions], [custom.id, customVersions]]) {
          assert.equal((await gatewayVersions(id)).length, versions.length + 1);
        }
        const records = await readAudit();
        assert.equal(records.length, auditBefore.length + 1);
        const record = records.at(-1);
        assert.equal(record.action, "agentTool.bulk_removed");
        assert.equal(record.actorId, owner);
        assert.equal(record.outcome, "success");
        assert.equal(record.after.agentToolAssignmentCount, record.before.agentToolAssignmentCount - 1);
        outputs.push(JSON.parse(JSON.stringify(response)
          .replaceAll(auto.id, "auto-id").replaceAll(custom.id, "custom-id").replaceAll(isolated.id, "isolated-id")));
      }
      assert.deepEqual(outputs[0], outputs[1]);
      assert.equal(removeAgentToolRequests, 3);
    });

    await t.test("patch_agent_skill_policy preserves conflicts, atomic rollback and audit", async () => {
      const name = "archestra__patch_agent_skill_policy";
      const request = (id, patch) => ({
        ...usageCall(name), params: { name, arguments: { id, patch } },
      });
      const rulesTable = schema.agentActivationSkillRulesTable;
      const agents = schema.agentsTable;
      const audit = schema.auditLogsTable;
      const readRows = (id) => db.select().from(rulesTable).where(eq(rulesTable.agentId, id)).orderBy(rulesTable.id);
      const readAgent = async (id) => (await db.select().from(agents).where(eq(agents.id, id)))[0];
      const readAudit = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const opaqueNative = { source: "native", skillId: randomUUID() };
      const remainingRules = [
        { disposition: "exclude", reference: { source: "external_mcp", mcpServerId: randomUUID(), uri: "skill://unavailable" } },
        { disposition: "exclude", reference: { source: "plugin", pluginId: randomUUID(), skillPath: "skills/unavailable" } },
      ];
      const initialRules = [{ disposition: "allow", reference: opaqueNative }, ...remainingRules];
      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { id } = await AgentModel.create({
          organizationId: org, agentType: "agent", name: "Activation policy parity fixture",
        }, owner, { skipCreationDefaultTools: true });
        await AgentActivationSkillRuleModel.addRules({ agentId: id, rules: initialRules });
        await AgentVersionModel.forkIfChanged(id);
        const before = await readAgent(id);
        const rows = await readRows(id);
        const versions = await gatewayVersions(id);
        const expectedRevision = before.activationSkillPolicyRevision;
        const patch = { expectedRevision, mode: "manual", operations: [
          { op: "remove", disposition: "allow", reference: opaqueNative },
        ] };
        const unavailable = await post(request(id, { expectedRevision, operations: [
          { op: "add", disposition: "allow", reference: { ...opaqueNative, skillId: randomUUID() } },
        ] }));
        assert.equal(unavailable.body.result.isError, true);
        let rollback;
        await db.execute(sql`ALTER TABLE agents ADD CONSTRAINT riir_reject_skill_mode CHECK (activation_skill_mode <> 'manual') NOT VALID`);
        try {
          rollback = await post(request(id, patch));
        } finally {
          await db.execute(sql`ALTER TABLE agents DROP CONSTRAINT riir_reject_skill_mode`);
        }
        assert.equal(rollback.body.result.isError, true);
        assert.deepEqual(await readAgent(id), before);
        assert.deepEqual(await readRows(id), rows);
        assert.deepEqual(await gatewayVersions(id), versions);

        const changed = await post(request(id, patch));
        const revision = expectedRevision + 1;
        assert.deepEqual(changed.body.result.structuredContent, {
          mode: "manual", revision, allowedReferences: [], excludedReferences: [],
          allowedSkills: [], excludedSkills: [], hiddenAllowedCount: 0, hiddenExcludedCount: 2,
        });
        const after = await readAgent(id);
        const committedRows = await readRows(id);
        assert.deepEqual(await AgentActivationSkillRuleModel.findPolicySnapshot(id), {
          mode: "manual", revision, rules: remainingRules,
        });
        const committedVersions = await gatewayVersions(id);
        assert.equal(committedVersions.length, versions.length + 1);
        assert.deepEqual(committedVersions.at(-1).snapshot.activationSkillRules, remainingRules);
        const stale = await post(request(id, patch));
        assert.equal(stale.body.result.isError, true);
        const noOp = await post(request(id, { ...patch, expectedRevision: revision }));
        assert.deepEqual(noOp, changed);
        if (native) {
          assert.equal(await callRustApi({
            socketPath: socket, path: "/internal/v1/mcp/tools/patch-agent-skill-policy",
            json: JSON.stringify({ agentId: id, organizationId: org, expectedRevision, replacement: { mode: "all", rules: [] } }),
          }), "conflict");
        }
        assert.deepEqual(await readAgent(id), after);
        assert.deepEqual(await readRows(id), committedRows);
        assert.deepEqual(await gatewayVersions(id), committedVersions);
        const records = await readAudit(id);
        assert.deepEqual(records.map(({ action, actorId, outcome }) => ({ action, actorId, outcome })),
          ["failure", "failure", "success", "failure"].map((outcome) => ({ action: "agent.updated", actorId: owner, outcome })));
        assert.equal(records[2].before?.activationSkillPolicyRevision, expectedRevision);
        assert.equal(records[2].after?.activationSkillPolicyRevision, revision);
        assert.deepEqual(records[2].after?.activationSkillRuleCounts, { allowed: 0, excluded: 2 });
        responses.push([unavailable, rollback, changed, stale, noOp]);
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(skillPolicyPatchRequests, 3);
    });

    await t.test("set_app_lock preserves authorization, creation grace and single-write audit", async () => {
      const name = "archestra__set_app_lock";
      const request = (appId, locked) => ({
        ...usageCall(name), params: { name, arguments: { appId, locked } },
      });
      const apps = schema.appsTable;
      const audit = schema.auditLogsTable;
      const readApp = async (id) => (await db.select().from(apps).where(eq(apps.id, id)))[0];
      const readAudit = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const hiddenBefore = await readApp(hiddenApp.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(request(hiddenApp.id, true));
      assert.equal(denied.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(request(hiddenApp.id, true)), denied);
      assert.deepEqual(await readApp(hiddenApp.id), hiddenBefore);
      assert.deepEqual((await readAudit(hiddenApp.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(appLockRequests, 0);

      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const sessionKey = randomUUID();
        const fixtureName = `App lock parity fixture ${native ? "Rust" : "TypeScript"}`;
        const { id } = await AppModel.create({
          app: { organizationId: org, authorId: owner, mcpServerId: installation.id, name: fixtureName,
            locked: true, enabled: false, creationGraceSessionKey: sessionKey },
          payload: { html: "<title>Fixture</title>", uiPermissions: null },
        });
        const initial = await readApp(id);
        const deniedDisabled = await post(request(id, false));
        assert.equal(deniedDisabled.body.result.isError, true);
        if (native) {
          assert.equal(await callRustApi({
            socketPath: socket, path: "/internal/v1/mcp/tools/set-app-lock",
            json: JSON.stringify({ id, organizationId: org, locked: false, sessionKey: randomUUID() }),
          }), null);
        }
        assert.deepEqual(await readApp(id), initial);
        const graced = await executeArchestraTool(name, { appId: id, locked: false }, {
          agent: { id: gateway.id, name: gateway.name }, agentId: gateway.id, organizationId: org, userId: owner,
          isolationKey: sessionKey, gatewayExecution: { native, signal: new AbortController().signal },
        });
        await drainBackgroundWork();
        assert.deepEqual(graced.structuredContent, { id, locked: false });
        const unlocked = await readApp(id);
        assert.deepEqual(unlocked, { ...initial, locked: false, updatedAt: unlocked.updatedAt });
        await AppModel.setEnabled(id, true);
        await AppModel.setCreationGraceSessionKey(id, sessionKey);
        const enabled = await readApp(id);
        const locked = await post(request(id, true));
        assert.deepEqual(locked.body.result.structuredContent, { id, locked: true });
        const stored = await readApp(id);
        assert.deepEqual(stored, { ...enabled, locked: true, creationGraceSessionKey: null, updatedAt: stored.updatedAt });
        assert.ok(stored.updatedAt >= enabled.updatedAt);
        const unlockedAgain = await post(request(id, false));
        assert.deepEqual(unlockedAgain.body.result.structuredContent, { id, locked: false });
        const final = await readApp(id);
        assert.deepEqual(final, { ...stored, locked: false, updatedAt: final.updatedAt });
        const records = await readAudit(id);
        assert.deepEqual(records.map(({ action, actorId, outcome }) => ({ action, actorId, outcome })),
          ["failure", "success", "success", "success"].map((outcome) => ({ action: "app.updated", actorId: owner, outcome })));
        assert.deepEqual(records.map(({ before, after }) => [before?.locked, after?.locked]),
          [[true, undefined], [true, false], [false, true], [true, false]]);
        responses.push([deniedDisabled, graced, locked, unlockedAgain].map((value) =>
          JSON.parse(JSON.stringify(value).replaceAll(id, "app-id").replaceAll(fixtureName, "App fixture"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(appLockRequests, 3);
    });
    await t.test("set_app_tools preserves atomic replacement, lifecycle gates and single-write audit", async () => {
      const name = "archestra__set_app_tools";
      const request = (appId, tools) => ({
        ...usageCall(name), params: { name, arguments: { appId, tools } },
      });
      const rows = schema.appToolsTable, audit = schema.auditLogsTable;
      const stored = (appId) => db.select().from(rows).where(eq(rows.appId, appId)).orderBy(rows.toolId);
      const audits = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const [added, removed] = await db.insert(schema.toolsTable).values(["added", "removed"].map((suffix) => ({
        name: `riir-remote__app_tool_fixture_${suffix}`, rawName: `app_tool_fixture_${suffix}`, catalogId: catalog.id,
      }))).returning();
      await AgentToolModel.create(gateway.id, added.id, { mcpServerId: installation.id });
      const cases = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const hidden = await post(request(hiddenApp.id, []));
        assert.equal(hidden.body.result.isError, true);
        assert.equal(appToolRequests, 0);
        const backing = await InternalMcpCatalogModel.create({
          name: `App tools backing fixture ${native}`, serverType: "app",
        }, { organizationId: org, authorId: owner });
        const appServer = await McpServerModel.create({
          name: backing.name, catalogId: backing.id, serverType: "app", ownerId: owner,
        });
        const { id } = await AppModel.create({
          app: { organizationId: org, authorId: owner, mcpServerId: appServer.id,
            name: `App tools parity fixture ${native}` },
          payload: { html: "<title>Fixture</title>", uiPermissions: null },
        });
        await db.insert(rows).values([echo.id, removed.id].map((toolId) => ({
          appId: id, toolId, mcpServerId: installation.id, credentialResolutionMode: "static",
        })));
        const before = await stored(id);
        const unknown = await post(request(id, ["riir-remote__unknown_tool"]));
        assert.equal(unknown.body.result.isError, true);
        assert.equal(appToolRequests, 0);
        assert.deepEqual(await stored(id), before);

        const desired = [added.name, echo.name];
        await db.execute(sql`ALTER TABLE app_tools ADD CONSTRAINT riir_reject_dynamic_app_tool
          CHECK (credential_resolution_mode <> 'dynamic') NOT VALID`);
        let failed;
        try {
          failed = await post(request(id, desired));
        } finally {
          await db.execute(sql`ALTER TABLE app_tools DROP CONSTRAINT riir_reject_dynamic_app_tool`);
        }
        assert.equal(failed.body.result.isError, true);
        assert.deepEqual(await stored(id), before);

        const set = await post(request(id, [...desired, added.name]));
        assert.equal(set.body.result.isError, false, JSON.stringify(set.body));
        assert.deepEqual(set.body.result.structuredContent, { id, tools: desired });
        assert.deepEqual((await stored(id)).map((row) => [row.toolId, row.mcpServerId, row.credentialResolutionMode]),
          [echo.id, added.id].sort().map((toolId) => [toolId, null, "dynamic"]));
        assert.equal((await stored(id)).find(({ toolId }) => toolId === echo.id).id,
          before.find(({ toolId }) => toolId === echo.id).id);

        const sessionKey = randomUUID();
        await db.update(schema.appsTable).set({ locked: true, enabled: false, creationGraceSessionKey: sessionKey })
          .where(eq(schema.appsTable.id, id));
        const locked = await post(request(id, []));
        assert.equal(locked.body.result.isError, true);
        assert.equal((await stored(id)).length, 2);
        if (native) {
          assert.equal(await callRustApi({
            socketPath: socket, path: "/internal/v1/mcp/tools/set-app-tools",
            json: JSON.stringify({
              id, organizationId: org, environmentId: backing.environmentId, toolIds: [],
              archestraCatalogId: ARCHESTRA_MCP_CATALOG_ID, playwrightCatalogId: PLAYWRIGHT_MCP_CATALOG_ID,
            }),
          }), false);
        }
        const cleared = await executeArchestraTool(name, { appId: id, tools: [] }, {
          agent: { id: gateway.id, name: gateway.name }, agentId: gateway.id, organizationId: org, userId: owner,
          isolationKey: sessionKey, gatewayExecution: { native, signal: new AbortController().signal },
        });
        await drainBackgroundWork();
        assert.deepEqual(cleared.structuredContent, { id, tools: [] });
        assert.deepEqual(await stored(id), []);
        const records = await audits(id);
        assert.deepEqual(records.map(({ action, actorId, outcome }) => [action, actorId, outcome]),
          ["failure", "failure", "success", "failure", "success"].map((outcome) => ["app.updated", owner, outcome]));
        const initialNames = [echo.name, removed.name].sort();
        assert.deepEqual(records.map(({ before, after }) => [before.tools, after?.tools]),
          [[initialNames, undefined], [initialNames, undefined], [initialNames, desired.toSorted()],
            [desired.toSorted(), undefined], [desired.toSorted(), []]]);
        assert.equal((await audits(hiddenApp.id)).length, native ? 2 : 1);
        cases.push([hidden, unknown, failed, set, locked, cleared].map((value) =>
          JSON.parse(JSON.stringify(value).replaceAll(id, "app-id").replaceAll(`App tools parity fixture ${native}`, "App fixture"))));
      }
      assert.deepEqual(cases[0], cases[1]);
      assert.equal(appToolRequests, 3);
    });

    await t.test("set_app_labels preserves replacement, vocabulary rollback and audit behavior", async () => {
      const name = "archestra__set_app_labels";
      const request = (appId, labels, options = {}) => ({
        ...usageCall(name), ...options, params: { name, arguments: { appId, labels } },
      });
      const old = [{ key: "riir-label-old", value: "Original" }];
      const labels = [{ key: "riir-label-z", value: "Discarded" }, { key: "riir-label-a", value: "A 🧪" },
        { key: "riir-label-z", value: "Last" }];
      const desired = [labels[2], labels[1]];
      const audit = schema.auditLogsTable;
      const hiddenBefore = await AppLabelModel.getLabelsForApp(hiddenApp.id);
      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const denied = await post(request(hiddenApp.id, labels));
        assert.equal(denied.body.result.isError, true);
        assert.deepEqual(await AppLabelModel.getLabelsForApp(hiddenApp.id), hiddenBefore);
        assert.equal(appLabelRequests, 0);

        const fixtureName = `App labels parity fixture ${native}`;
        const { id } = await AppModel.create({
          app: { organizationId: org, authorId: owner, mcpServerId: installation.id, name: fixtureName },
          payload: { html: "<title>Label fixture</title>", uiPermissions: null },
        });
        await AppLabelModel.syncAppLabels(id, old);
        const initial = await AppLabelModel.getLabelsForApp(id);
        const previousLogs = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
        const rolledBack = { key: "riir-app-label-transient-key", value: "riir-app-label-transient-value" };
        await db.execute(sql`ALTER TABLE app_labels ADD CONSTRAINT riir_reject_app_label CHECK (false) NOT VALID`);
        let failed;
        try {
          failed = await post(request(id, [rolledBack], { checkAudit: false }));
        } finally {
          await db.execute(sql`ALTER TABLE app_labels DROP CONSTRAINT riir_reject_app_label`);
        }
        assert.equal(failed.body.result.isError, true);
        assert.equal(appLabelRequests, native ? 1 : 0);
        assert.deepEqual(await AppLabelModel.getLabelsForApp(id), initial);
        assert.deepEqual(await db.select().from(schema.labelKeysTable).where(eq(schema.labelKeysTable.key, rolledBack.key)), []);
        assert.deepEqual(await db.select().from(schema.labelValuesTable).where(eq(schema.labelValuesTable.value, rolledBack.value)), []);
        assert.equal((await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id)).length, previousLogs.length);

        const set = await post(request(id, labels));
        assert.deepEqual(set.body.result.structuredContent, { id, labels: desired }, JSON.stringify(set.body));
        assert.deepEqual((await AppLabelModel.getLabelsForApp(id)).map(({ key, value }) => ({ key, value })), [...desired].reverse());
        await AppModel.setLocked(id, true);
        const locked = await post(request(id, []));
        assert.equal(locked.body.result.isError, true);
        if (native) {
          assert.equal(await callRustApi({
            socketPath: socket, path: "/internal/v1/mcp/tools/set-app-labels",
            json: JSON.stringify({ id, organizationId: org, labels: {} }),
          }), false);
        }
        assert.equal((await AppLabelModel.getLabelsForApp(id)).length, 2);
        await AppModel.setLocked(id, false);
        const cleared = await post(request(id, []));
        assert.deepEqual(cleared.body.result.structuredContent, { id, labels: [] });
        assert.deepEqual(await AppLabelModel.getLabelsForApp(id), []);
        responses.push([denied, failed, set, locked, cleared].map((response) =>
          JSON.parse(JSON.stringify(response).replaceAll(id, "app-id").replaceAll(fixtureName, "App label fixture"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.deepEqual(await db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${name}`),
      )), []);
      assert.equal(appLabelRequests, 3);
    });

    await t.test("delete_app rolls back with its policy and audits successful deletion once", async () => {
      const name = "archestra__delete_app";
      const request = (appId, options = {}) => ({
        ...usageCall(name), ...options, params: { name, arguments: { appId } },
      });
      const audit = schema.auditLogsTable;
      const audits = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const policyFor = (id) => ResourcePermissionPolicyModel.find({ organizationId: org, resource: "app", scope: id });
      const readOne = async (table, id) => (await db.select().from(table).where(eq(table.id, id)))[0];
      const hiddenBefore = await readOne(schema.appsTable, hiddenApp.id);
      const cases = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const denied = await post(request(hiddenApp.id));
        assert.equal(denied.body.result.isError, true);
        assert.deepEqual(await readOne(schema.appsTable, hiddenApp.id), hiddenBefore);
        assert.equal(appDeleteRequests, 0);
        const fixtureName = `App deletion parity fixture ${native}`;
        const backing = await InternalMcpCatalogModel.create({
          name: fixtureName, serverType: "app",
        }, { organizationId: org, authorId: owner });
        const server = await McpServerModel.create({
          name: backing.name, catalogId: backing.id, serverType: "app", userId: owner,
        });
        const launch = await ToolModel.create({
          name: ToolModel.slugifyName(backing.name, "open"), catalogId: backing.id,
        });
        const { id } = await AppModel.create({
          app: { organizationId: org, authorId: owner, mcpServerId: server.id, name: fixtureName, locked: true },
          payload: { html: "<title>Delete fixture</title>", uiPermissions: null },
        });
        const versions = () => db.select().from(schema.appVersionsTable).where(eq(schema.appVersionsTable.appId, id));
        const locked = await post(request(id));
        assert.equal(locked.body.result.isError, true);
        assert.equal(appDeleteRequests, 0);
        if (native) {
          assert.equal(await callRustApi({
            socketPath: socket, path: "/internal/v1/mcp/tools/delete-app",
            json: JSON.stringify({ id, organizationId: org }),
          }), false);
        }
        await AppModel.setLocked(id, false);
        const initialApp = await readOne(schema.appsTable, id);
        const initialPolicy = await policyFor(id);
        const initialVersions = await versions();
        assert.ok(initialPolicy);
        assert.equal(initialVersions.length, 1);
        await db.execute(sql`CREATE FUNCTION riir_reject_app_policy_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'fixture policy delete failure' USING ERRCODE = '23514'; END $$`);
        await db.execute(sql`CREATE TRIGGER riir_reject_app_policy_delete BEFORE DELETE ON resource_permission_policies
          FOR EACH ROW WHEN (OLD.resource = 'app') EXECUTE FUNCTION riir_reject_app_policy_delete()`);
        let failed;
        try {
          failed = await post(request(id, { checkAudit: false }));
        } finally {
          await db.execute(sql`DROP TRIGGER riir_reject_app_policy_delete ON resource_permission_policies`);
          await db.execute(sql`DROP FUNCTION riir_reject_app_policy_delete()`);
        }
        assert.equal(failed.body.result.isError, true);
        assert.equal(appDeleteRequests, native ? 1 : 0);
        assert.deepEqual(await readOne(schema.appsTable, id), initialApp);
        assert.deepEqual(await policyFor(id), initialPolicy);
        for (const [table, record] of [
          [schema.mcpServersTable, server], [schema.internalMcpCatalogTable, backing], [schema.toolsTable, launch],
        ]) assert.equal((await readOne(table, record.id)).deletedAt, null);
        // Unexpected DB exceptions are rendered by the gateway, outside
        // the app tool's organization audit hook, in both modes.
        assert.deepEqual((await audits(id)).map(({ outcome }) => outcome), ["failure"]);

        const deleted = await post(request(id));
        assert.equal(deleted.body.result.isError, false, JSON.stringify(deleted.body));
        const stored = await readOne(schema.appsTable, id);
        assert.ok(stored.deletedAt);
        assert.deepEqual(stored, { ...initialApp, deletedAt: stored.deletedAt, updatedAt: stored.updatedAt });
        assert.equal(await policyFor(id), null);
        assert.deepEqual(await versions(), initialVersions);
        for (const [table, record] of [
          [schema.mcpServersTable, server], [schema.internalMcpCatalogTable, backing], [schema.toolsTable, launch],
        ]) assert.ok((await readOne(table, record.id)).deletedAt);
        const repeated = await post(request(id));
        assert.equal(repeated.body.result.isError, true);
        assert.deepEqual(await readOne(schema.appsTable, id), stored);
        assert.deepEqual((await audits(id)).map(({ action, actorId, outcome, before, after }) => [
          action, actorId, outcome, before?.locked, after,
        ]), [
          ["app.deleted", owner, "failure", true, null],
          ["app.deleted", owner, "success", false, null],
          ["app.deleted", owner, "failure", false, null],
        ]);
        cases.push([denied, locked, failed, deleted, repeated].map((value) =>
          JSON.parse(JSON.stringify(value).replaceAll(id, "app-id").replaceAll(fixtureName, "App fixture"))));
      }
      assert.deepEqual(cases[0], cases[1]);
      assert.deepEqual((await audits(hiddenApp.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(appDeleteRequests, 2);
    });

    await t.test("scaffold_app preserves app, policy, initial version rollback and single-write audit", async () => {
      const tool = "archestra__scaffold_app", name = "Scaffold parity fixture";
      const apps = schema.appsTable, catalogs = schema.internalMcpCatalogTable;
      const versions = schema.appVersionsTable, policies = schema.resourcePermissionPoliciesTable, audit = schema.auditLogsTable;
      const [previousOrg] = await db.select().from(schema.organizationsTable).where(eq(schema.organizationsTable.id, org));
      const defaults = (newAppsDisabledByDefault, newAppsLockedByDefault) => db.update(schema.organizationsTable)
        .set({ newAppsDisabledByDefault, newAppsLockedByDefault }).where(eq(schema.organizationsTable.id, org));
      const sessionKey = randomUUID(), sessionId = randomUUID();
      const args = {
        name, description: "Scaffolded fixture 🧪", icon: "🧪", uiPermissions: { clipboardWrite: {} },
        labels: [{ key: "scaffold-fixture", value: "kept" }],
        initialGrants: [{ subject: { type: "user", id: member }, actions: ["read"] }],
      };
      const audits = () => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${tool}`),
      )).orderBy(audit.eventSequence);
      const request = (input, options = {}) => ({ ...usageCall(tool), ...options, params: { name: tool, arguments: input } });
      const rows = (targetName) => db.select().from(apps).where(and(eq(apps.organizationId, org), eq(apps.name, targetName)));
      const catalogRows = (targetName) => db.select().from(catalogs).where(and(eq(catalogs.organizationId, org), eq(catalogs.name, targetName)));
      const policyScopes = () => db.select({ scope: policies.scope }).from(policies).where(and(
        eq(policies.organizationId, org), eq(policies.resource, "app"),
      )).orderBy(policies.scope);
      const versionIds = () => db.select({ id: versions.id }).from(versions).orderBy(versions.id);
      const rejected = { ...args, name: `${name} missing project`, project_id: randomUUID() };
      const responseParity = [];
      await defaults(true, true);
      try {
        for (const native of [false, true]) {
          config.mcpGateway.rustDiscoverEnabled = native;
          const denied = await post(request(rejected));
          assert.equal(denied.body.result.isError, true);
          assert.deepEqual(await rows(rejected.name), []);
          assert.equal(appScaffoldRequests, 0);
          assert.deepEqual((await audits()).at(-1).outcome, "failure");
          const previousAudits = (await audits()).length;
          const beforePolicies = await policyScopes(), beforeVersions = await versionIds();
          const rollbackName = `${name} failed initial version`;
          await db.execute(sql`ALTER TABLE app_versions ADD CONSTRAINT riir_reject_app_initial_version CHECK (false) NOT VALID`);
          let failed;
          try {
            failed = await post(request({ ...args, name: rollbackName }, { checkAudit: false }));
          } finally {
            await db.execute(sql`ALTER TABLE app_versions DROP CONSTRAINT riir_reject_app_initial_version`);
          }
          assert.equal(failed.body.result.isError, true);
          assert.equal(appScaffoldRequests, native ? 1 : 0);
          assert.deepEqual(await rows(rollbackName), []);
          assert.deepEqual(await catalogRows(rollbackName), []);
          assert.deepEqual(await policyScopes(), beforePolicies);
          assert.deepEqual(await versionIds(), beforeVersions);
          assert.equal((await audits()).length, previousAudits);

          const created = await executeArchestraTool(tool, args, {
            agent: { id: gateway.id, name: gateway.name }, agentId: gateway.id, organizationId: org, userId: owner,
            sessionId, isolationKey: sessionKey, gatewayExecution: { native, signal: new AbortController().signal },
          });
          await drainBackgroundWork();
          assert.equal(created.isError, false, JSON.stringify(created.content[0]));
          const id = created.structuredContent.id;
          const row = (await rows(name)).find((candidate) => candidate.id === id);
          assert.deepEqual([row.enabled, row.locked, row.creationGraceSessionKey, row.authoringSessionId, row.latestVersion],
            [false, true, sessionKey, sessionId, 1]);
          const [version, ...laterVersions] = await db.select().from(versions).where(eq(versions.appId, id));
          assert.deepEqual(laterVersions, []);
          assert.deepEqual([version.version, version.uiPermissions, version.spec], [1, args.uiPermissions, null]);
          assert.equal(typeof version.html, "string");
          assert.ok(version.html.length > 0);
          const policy = await ResourcePermissionPolicyModel.find({ organizationId: org, resource: "app", scope: id });
          assert.ok(policy.legacySharingMigrated);
          assert.equal(policy.legacyOrganizationAudience, false);
          assert.ok(policy.grants.some(({ subject, actions }) => subject.id === owner && actions.includes("manage-permissions")));
          assert.deepEqual(policy.grants.find(({ subject }) => subject.id === member)?.actions, ["read"]);
          const app = await AppModel.findById(id);
          const server = await McpServerModel.findById(row.mcpServerId);
          const backing = await InternalMcpCatalogModel.findById(server.catalogId);
          const launch = await db.select().from(schema.toolsTable).where(eq(schema.toolsTable.catalogId, backing.id));
          assert.deepEqual([server.serverType, backing.serverType, backing.icon, launch.length], ["app", "app", args.icon, 1]);
          assert.deepEqual(app.labels.map(({ key, value }) => ({ key, value })), args.labels);
          const records = await audits();
          assert.equal(records.length, previousAudits + 1);
          const [event] = records.slice(-1);
          assert.deepEqual([event.action, event.actorId, event.resourceId, event.outcome, event.before, event.after.latestVersion],
            ["app.created", owner, id, "success", null, 1]);

          const duplicate = await post(request(args));
          assert.equal(duplicate.body.result.isError, true);
          assert.equal((await rows(name)).filter(({ deletedAt }) => deletedAt === null).length, 1);
          const dupAudit = (await audits()).at(-1);
          assert.deepEqual([dupAudit.outcome, dupAudit.resourceId, dupAudit.after], ["failure", null, null]);
          assert.equal((await audits()).length, previousAudits + 2);
          const { id: _rowId, mcpServerId, createdAt, updatedAt, ...fields } = row;
          responseParity.push({
            response: JSON.parse(JSON.stringify({ created, denied, failed, duplicate }).replaceAll(id, "app-id")),
            fields, grants: policy.grants,
            payload: { html: version.html, uiPermissions: version.uiPermissions, contentHash: version.contentHash },
          });
          assert.equal(await AppModel.delete(id), true);
          await deleteAppBacking(app);
        }
        assert.deepEqual(responseParity[1], responseParity[0]);
        assert.equal(appScaffoldRequests, 3);
      } finally {
        await defaults(previousOrg.newAppsDisabledByDefault, previousOrg.newAppsLockedByDefault);
      }
    });

    await t.test("edit_app preserves no-ops, rejects a racing head and rolls back version writes", async () => {
      const name = "archestra__edit_app";
      const request = (appId, baseVersion, replacementHtml, options = {}) => ({
        ...usageCall(name), ...options, params: { name, arguments: { appId, baseVersion, replacementHtml } },
      });
      const audit = schema.auditLogsTable, apps = schema.appsTable;
      const read = async (id) => (await db.select().from(apps).where(eq(apps.id, id)))[0];
      const audits = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const html = (body) => `<!doctype html>\n<html><head><title>Fixture</title></head><body><p>${body}</p></body></html>`;
      const permissions = { clipboardWrite: {} };
      const spec = { summary: "Edit fixture", features: [], tools: [] };
      const baseline = { html: html("Original"), uiPermissions: permissions };
      const results = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const denied = await post(request(hiddenApp.id, 1, html("Denied")));
        assert.equal(denied.body.result.isError, true);
        assert.equal(appEditRequests, 0);
        const fixtureName = `App edit parity fixture ${native}`;
        const { id } = await AppModel.create({
          app: { organizationId: org, authorId: owner, mcpServerId: installation.id, name: fixtureName, spec },
          payload: baseline,
        });
        const history = () => AppVersionModel.listForApp(id);
        const [original] = await history();
        const initial = await read(id);
        const unchanged = await post(request(id, 1, baseline.html));
        assert.equal(unchanged.body.result.structuredContent?.latestVersion, 1, JSON.stringify(unchanged.body));
        assert.deepEqual(await read(id), initial);
        assert.deepEqual(await history(), [original]);
        const first = await post(request(id, 1, html("Edited")));
        assert.equal(first.body.result.structuredContent?.latestVersion, 2, JSON.stringify(first.body));
        const [second] = await history();
        assert.deepEqual([second.html, second.uiPermissions, second.spec, second.contentHash],
          [html("Edited"), permissions, spec, AppVersionModel.computeContentHash({ html: html("Edited"), uiPermissions: permissions })]);
        const overlapping = await post(request(id, 1, html("Overlapping edit")));
        assert.equal(overlapping.body.result.isError, true);
        assert.deepEqual(await history(), [second, original]);
        assert.equal(appEditRequests, native ? 2 : 0);

        const preRollback = await read(id);
        await db.execute(sql`ALTER TABLE apps ADD CONSTRAINT riir_reject_app_head CHECK (latest_version <> 3) NOT VALID`);
        let failed;
        try {
          failed = await post(request(id, 2, html("Rejected head"), { checkAudit: false }));
        } finally {
          await db.execute(sql`ALTER TABLE apps DROP CONSTRAINT riir_reject_app_head`);
        }
        assert.equal(failed.body.result.isError, true);
        assert.deepEqual(await read(id), preRollback);
        assert.deepEqual(await history(), [second, original]);

        // Hold the row until the tool reaches its final lock, then advance the head.
        // Both handlers read head 2, but must reject after acquiring the lock at 3.
        let pending;
        await db.transaction(async (tx) => {
          await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, id)).for("update");
          pending = post(request(id, 2, html("Losing edit")));
          pending.catch(() => {});
          let blocked = false;
          for (let i = 0; i < 60 && !blocked; i++) {
            const { rows: [row] } = await tx.execute(sql`SELECT EXISTS (
              SELECT 1 FROM pg_locks
              WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
            ) AS blocked`);
            blocked = row.blocked;
            if (!blocked) await delay(40);
          }
          assert.ok(blocked, "The edit must reach the app row lock before the competing fork");
          const winner = { html: html("Winning edit"), uiPermissions: permissions };
          await AppVersionModel.insertVersion(tx, {
            appId: id, version: 3, payload: winner, contentHash: AppVersionModel.computeContentHash(winner), spec,
          });
          await tx.update(apps).set({ latestVersion: 3 }).where(eq(apps.id, id));
        });
        const stale = await pending;
        assert.equal(stale.body.result.isError, true);
        assert.equal((await read(id)).latestVersion, 3);
        const actual = await history();
        assert.deepEqual(actual.map(({ version, html }) => [version, html]),
          [[3, html("Winning edit")], [2, html("Edited")], [1, baseline.html]]);
        assert.deepEqual((await audits(id)).map(({ action, actorId, outcome, before, after }) =>
          [action, actorId, outcome, before?.latestVersion, after?.latestVersion]), [
          ["app.updated", owner, "success", 1, 1],
          ["app.updated", owner, "success", 1, 2],
          ["app.updated", owner, "failure", 2, undefined],
          ["app.updated", owner, "failure", 2, undefined],
        ]);
        results.push([denied, unchanged, first, overlapping, failed, stale].map((response) =>
          JSON.parse(JSON.stringify(response).replaceAll(id, "app-id").replaceAll(fixtureName, "App edit fixture"))));
      }
      assert.deepEqual(results[0], results[1]);
      assert.equal(appEditRequests, 4);
    });

    await t.test("restore_app_version preserves stale-head rejection, no-ops, rollback and audit", async () => {
      const name = "archestra__restore_app_version";
      const apps = schema.appsTable, audit = schema.auditLogsTable, assignments = schema.appToolsTable;
      const read = async (id) => (await db.select().from(apps).where(eq(apps.id, id)))[0];
      const audits = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const request = (appId, version, baseVersion, options = {}) => ({
        ...usageCall(name), ...options, params: { name, arguments: { appId, version, baseVersion } },
      });
      const html = (text) => `<!doctype html>\n<html><head><title>Fixture</title></head><body><p>${text}</p></body></html>`;
      const firstPayload = { html: html("Original"), uiPermissions: { clipboardWrite: {} } };
      const secondPayload = { html: html("Changed"), uiPermissions: null };
      const spec = (summary) => ({ summary, features: [], tools: [] });
      const activeSpec = spec("Current spec");
      const responses = [];
      const priorWrites = appEditRequests;
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const denied = await post(request(hiddenApp.id, 1, 1));
        assert.equal(denied.body.result.isError, true);
        const fixtureName = `Restore parity fixture ${native}`;
        const backing = await InternalMcpCatalogModel.create({
          name: fixtureName, serverType: "app",
        }, { organizationId: org, authorId: owner });
        const server = await McpServerModel.create({
          name: backing.name, catalogId: backing.id, serverType: "app", userId: owner,
        });
        const { id } = await AppModel.create({
          app: { organizationId: org, authorId: owner, mcpServerId: server.id, name: fixtureName, spec: spec("Historical spec") },
          payload: firstPayload,
        });
        await AppModel.update({ id, patch: { spec: activeSpec }, version: secondPayload });
        const labels = [{ key: "restore-fixture", value: "kept" }];
        await AppLabelModel.syncAppLabels(id, labels);
        const [pin] = await db.insert(assignments).values({ appId: id, toolId: echo.id, mcpServerId: installation.id }).returning();
        const history = () => AppVersionModel.listForApp(id);
        const before = await read(id);
        const historical = await history();
        const missing = await post(request(id, 99, 2));
        assert.equal(missing.body.result.isError, true);
        assert.equal(appEditRequests, priorWrites);

        const wideStale = await post(request(id, 1, 2 ** 31));
        assert.equal(wideStale.body.result.isError, true);
        const noOp = await post(request(id, 2, 2));
        assert.equal(noOp.body.result.structuredContent?.latestVersion, 2, JSON.stringify(noOp.body));
        assert.deepEqual(await read(id), before);
        assert.deepEqual(await history(), historical);

        await db.execute(sql`ALTER TABLE apps ADD CONSTRAINT riir_reject_restore_head CHECK (latest_version <> 3) NOT VALID`);
        let failed;
        try {
          failed = await post(request(id, 1, 2, { checkAudit: false }));
        } finally {
          await db.execute(sql`ALTER TABLE apps DROP CONSTRAINT riir_reject_restore_head`);
        }
        assert.equal(failed.body.result.isError, true);
        assert.deepEqual(await read(id), before);
        assert.deepEqual(await history(), historical);

        const restored = await post(request(id, 1, 2));
        assert.deepEqual(restored.body.result.structuredContent, {
          id, name: fixtureName, description: null, scope: "personal", latestVersion: 3, labels,
        });
        const stored = await read(id);
        assert.deepEqual(stored, { ...before, latestVersion: 3, updatedAt: stored.updatedAt });
        const [head, ...older] = await history();
        assert.deepEqual(older, historical);
        assert.deepEqual([head.version, head.html, head.uiPermissions, head.spec, head.contentHash],
          [3, firstPayload.html, firstPayload.uiPermissions, activeSpec, historical.at(-1).contentHash]);
        assert.deepEqual(await db.select().from(assignments).where(eq(assignments.appId, id)), [pin]);
        const stale = await post(request(id, 1, 2));
        assert.equal(stale.body.result.isError, true);
        assert.deepEqual(await read(id), stored);
        assert.deepEqual(await history(), [head, ...historical]);
        assert.deepEqual((await audits(id)).map(({ action, actorId, outcome, before, after }) =>
          [action, actorId, outcome, before?.latestVersion, after?.latestVersion]), [
          ["app.updated", owner, "failure", 2, undefined],
          ["app.updated", owner, "failure", 2, undefined],
          ["app.updated", owner, "success", 2, 2],
          ["app.updated", owner, "success", 2, 3],
          ["app.updated", owner, "failure", 3, undefined],
        ]);
        responses.push([denied, missing, wideStale, noOp, failed, restored, stale].map((response) =>
          JSON.parse(JSON.stringify(response).replaceAll(id, "app-id").replaceAll(fixtureName, "Restore fixture"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(appEditRequests - priorWrites, 5);
    });

    await t.test("publish_app preserves grants, conflicts, failed writes, backing scope and single-write audit", async () => {
      const name = "archestra__publish_app";
      const policies = schema.resourcePermissionPoliciesTable, audit = schema.auditLogsTable;
      const request = (appId, scope, teams, options = {}) => ({
        ...usageCall(name), ...options, params: { name, arguments: { appId, scope, teams } },
      });
      const grant = (type, id, actions = ["read", "use"]) => ({ subject: { type, id }, actions });
      const team = grant("team", ownTeam.id);
      const organization = grant("organization", "*");
      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const denied = await post(request(hiddenApp.id, "team", [ownTeam.name]));
        assert.equal(denied.body.result.isError, true);
        assert.equal(appPublishRequests, 0);
        const fixtureName = `Publish parity fixture ${native}`;
        const catalog = await InternalMcpCatalogModel.create({ name: fixtureName, serverType: "app" },
          { organizationId: org, authorId: owner });
        const server = await McpServerModel.create({
          catalogId: catalog.id, name: fixtureName, serverType: "app", userId: owner,
        });
        const { id, slug } = await AppModel.create({
          app: { organizationId: org, authorId: owner, mcpServerId: server.id, name: fixtureName, slug: `publish-fixture-${native}` },
          payload: { html: "<title>Publish fixture</title>", uiPermissions: null },
          initialPermissionGrants: [grant("team", ownTeam.id, ["read"])],
        });
        const key = { organizationId: org, resource: "app", scope: id };
        const where = and(eq(policies.organizationId, org), eq(policies.resource, "app"), eq(policies.scope, id));
        const current = () => ResourcePermissionPolicyModel.find(key);
        const backing = () => McpServerModel.findById(server.id);
        const original = await current();
        const history = await AppVersionModel.listForApp(id);
        const toTeam = await post(request(id, "team", [ownTeam.name, ownTeam.id]));
        assert.deepEqual(toTeam.body.result.structuredContent, { id, scope: "team", runUrl: `/a/${slug}` }, JSON.stringify(toTeam.body));
        const teamPolicy = await current();
        const teamGrants = original.grants.map((entry) => entry.subject.id === ownTeam.id ? team : entry);
        assert.deepEqual([teamPolicy.revision, teamPolicy.grants, (await backing()).scope, (await AppModel.findById(id)).scope],
          [original.revision + 1, teamGrants, "personal", "team"]);

        await db.execute(sql`ALTER TABLE resource_permission_policies ADD CONSTRAINT riir_reject_publish
          CHECK (NOT (resource = 'app' AND grants @> '[{"subject":{"type":"organization"}}]'::jsonb)) NOT VALID`);
        let failed;
        try {
          failed = await post(request(id, "org", undefined, { checkAudit: false }));
        } finally {
          await db.execute(sql`ALTER TABLE resource_permission_policies DROP CONSTRAINT riir_reject_publish`);
        }
        assert.equal(failed.body.result.isError, true);
        assert.deepEqual(await current(), teamPolicy);
        assert.equal((await backing()).scope, "personal");

        const concurrentGrants = [...teamGrants, grant("user", member, ["read"])];
        let pending;
        await db.transaction(async (tx) => {
          await tx.select({ revision: policies.revision }).from(policies).where(where).for("update");
          pending = post(request(id, "org"));
          pending.catch(() => {});
          let blocked = false;
          for (let i = 0; i < 60 && !blocked; i++) {
            const { rows: [row] } = await tx.execute(sql`SELECT EXISTS (
              SELECT 1 FROM pg_locks WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
            ) AS blocked`);
            blocked = row.blocked;
            if (!blocked) await delay(40);
          }
          assert.ok(blocked, "Publish must reach the policy write before the competing revision is committed");
          await tx.update(policies).set({ revision: teamPolicy.revision + 1, grants: concurrentGrants }).where(where);
        });
        const stale = await pending;
        assert.equal(stale.body.result.isError, true);
        const competing = await current();
        assert.deepEqual([competing.revision, competing.grants, (await backing()).scope],
          [teamPolicy.revision + 1, concurrentGrants, "personal"]);

        const toOrg = await post(request(id, "org"));
        assert.deepEqual(toOrg.body.result.structuredContent, { id, scope: "org", runUrl: `/a/${slug}` });
        const published = await current();
        assert.deepEqual([published.revision, published.grants, published.legacySharingMigrated, published.legacyOrganizationAudience],
          [competing.revision + 1, [...concurrentGrants, organization], original.legacySharingMigrated, false]);
        assert.deepEqual([(await backing()).scope, (await AppModel.findById(id)).scope, await AppVersionModel.listForApp(id)],
          ["org", "org", history]);
        const records = await db.select().from(audit).where(and(
          eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
        )).orderBy(audit.eventSequence);
        assert.deepEqual(records.map(({ action, actorId, outcome, before, after }) =>
          [action, actorId, outcome, before?.resourcePermissions, after?.resourcePermissions]), [
          ["app.updated", owner, "success", original.grants, teamGrants],
          ["app.updated", owner, "failure", teamGrants, undefined],
          ["app.updated", owner, "success", concurrentGrants, published.grants],
        ]);
        responses.push([denied, toTeam, failed, stale, toOrg].map((response) =>
          JSON.parse(JSON.stringify(response).replaceAll(id, "app-id").replaceAll(fixtureName, "Publish fixture")
            .replaceAll(`/a/${slug}`, "/a/publish-fixture"))));

        const createPolicy = () => native
          ? callRustApi({ socketPath: socket, path: "/internal/v1/mcp/tools/publish-app",
              json: JSON.stringify({ appId: id, organizationId: org, revision: 0, grants: original.grants }) })
          : ResourcePermissionPolicyModel.replace({ ...key, revision: 0, grants: original.grants }).then((row) => row?.revision ?? null);
        assert.equal(await createPolicy(), null);
        assert.deepEqual(await current(), published);
        await db.delete(policies).where(where);
        assert.equal(await createPolicy(), 1);
        const recreated = await current();
        assert.deepEqual([recreated.grants, recreated.legacySharingMigrated, recreated.legacyOrganizationAudience],
          [original.grants, false, false]);
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(appPublishRequests, 4);
    });

    await t.test("refine_app preserves spec-only writes, rollback and single-write audit", async () => {
      const name = "archestra__refine_app";
      const apps = schema.appsTable, audit = schema.auditLogsTable;
      const read = async (id) => (await db.select().from(apps).where(eq(apps.id, id)))[0];
      const audits = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const request = (appId, spec, options = {}) => ({
        ...usageCall(name), ...options, params: { name, arguments: { appId, spec } },
      });
      const baseline = { summary: "Initial spec", features: ["Retain history"], tools: [] };
      const revised = { summary: "Revised spec 🧪", features: ["Show totals", "Sort rows"], data: null, tools: [echo.name] };
      const gracedSpec = { ...revised, summary: "Revised in creating session", ui: "Compact" };
      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const hiddenBefore = await read(hiddenApp.id);
        const denied = await post(request(hiddenApp.id, revised));
        assert.equal(denied.body.result.isError, true);
        assert.deepEqual(await read(hiddenApp.id), hiddenBefore);
        assert.equal(appRefineRequests, 0);

        const fixtureName = `App refine parity fixture ${native}`;
        const backing = await InternalMcpCatalogModel.create({
          name: fixtureName, serverType: "app",
        }, { organizationId: org, authorId: owner });
        const server = await McpServerModel.create({
          name: backing.name, catalogId: backing.id, serverType: "app", userId: owner,
        });
        const { id } = await AppModel.create({
          app: { organizationId: org, authorId: owner, mcpServerId: server.id, name: fixtureName, spec: baseline },
          payload: { html: "<title>Refine fixture</title>", uiPermissions: null },
        });
        const original = await read(id);
        const versions = await AppVersionModel.listForApp(id);
        const inspected = await post(request(id));
        const inspection = inspected.body.result.structuredContent;
        assert.deepEqual([inspection.spec, inspection.persisted], [baseline, false]);
        assert.deepEqual(await read(id), original);
        assert.equal(appRefineRequests, 0);

        await db.execute(sql`ALTER TABLE apps ADD CONSTRAINT riir_reject_refined_spec
          CHECK (spec ->> 'summary' IS DISTINCT FROM 'Failed spec') NOT VALID`);
        let failed;
        try {
          failed = await post(request(id, { ...revised, summary: "Failed spec" }, { checkAudit: false }));
        } finally {
          await db.execute(sql`ALTER TABLE apps DROP CONSTRAINT riir_reject_refined_spec`);
        }
        assert.equal(failed.body.result.isError, true);
        assert.deepEqual(await read(id), original);
        assert.deepEqual(await AppVersionModel.listForApp(id), versions);
        assert.equal((await audits(id)).length, 1);

        const saved = await post(request(id, revised));
        const result = saved.body.result.structuredContent;
        assert.deepEqual([result.id, result.spec, result.persisted], [id, revised, true]);
        const stored = await read(id);
        assert.deepEqual(stored, { ...original, spec: revised, updatedAt: stored.updatedAt });
        assert.deepEqual(await AppVersionModel.listForApp(id), versions);
        assert.deepEqual(await db.select().from(schema.appToolsTable).where(eq(schema.appToolsTable.appId, id)), []);

        const sessionKey = randomUUID();
        await db.update(apps).set({ enabled: false, locked: true, creationGraceSessionKey: sessionKey }).where(eq(apps.id, id));
        const locked = await post(request(id, gracedSpec));
        assert.equal(locked.body.result.isError, true);
        if (native) {
          assert.equal(await callRustApi({
            socketPath: socket, path: "/internal/v1/mcp/tools/refine-app",
            json: JSON.stringify({ id, organizationId: org, spec: gracedSpec }),
          }), false);
        }
        const graced = await executeArchestraTool(name, { appId: id, spec: gracedSpec }, {
          agent: { id: gateway.id, name: gateway.name }, agentId: gateway.id, organizationId: org, userId: owner,
          isolationKey: sessionKey, gatewayExecution: { native, signal: new AbortController().signal },
        });
        await drainBackgroundWork();
        assert.equal(graced.structuredContent?.persisted, true, JSON.stringify(graced));
        assert.deepEqual((await read(id)).spec, gracedSpec);
        assert.deepEqual(await AppVersionModel.listForApp(id), versions);
        assert.deepEqual((await audits(id)).map(({ action, actorId, outcome, before, after }) =>
          [action, actorId, outcome, before?.spec, after?.spec]), [
          ["app.updated", owner, "success", baseline, baseline],
          ["app.updated", owner, "success", baseline, revised],
          ["app.updated", owner, "failure", revised, undefined],
          ["app.updated", owner, "success", revised, gracedSpec],
        ]);
        responses.push([denied, inspected, failed, saved, locked, graced].map((response) =>
          JSON.parse(JSON.stringify(response).replaceAll(id, "app-id").replaceAll(fixtureName, "App refine fixture"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(appRefineRequests, 3);
    });

    await t.test("create_knowledge_base commits the initial policy atomically and audits once", async () => {
      const tool = "archestra__create_knowledge_base";
      const createCall = (args) => ({ ...usageCall(tool), params: { name: tool, arguments: args } });
      const bases = schema.knowledgeBasesTable;
      const policies = schema.resourcePermissionPoliciesTable;
      const audit = schema.auditLogsTable;
      const args = { name: "New knowledge base", description: "Creation fixture", initialGrants: [
        { subject: { type: "user", id: member }, actions: ["read"] },
      ] };
      const readAudit = () => db.select().from(audit)
        .where(and(eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${tool}`))).orderBy(audit.eventSequence);
      const readBases = (name) => db.select().from(bases).where(and(eq(bases.organizationId, org), eq(bases.name, name)));
      const auditOutcomes = [];
      const call = async (input, outcome) => {
        const response = await post(createCall(input));
        assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
        auditOutcomes.push(outcome);
        const records = await readAudit();
        assert.deepEqual(records.map((row) => row.outcome), auditOutcomes);
        const record = records.at(-1);
        assert.equal(record.actorId, owner);
        assert.equal(record.action, "knowledgeBase.created");
        assert.equal(record.before, null);
        return { response, record };
      };
      const invalidGrant = { ...args, initialGrants: [{ subject: { type: "user", id: randomUUID() }, actions: ["read"] }] };
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await call(invalidGrant, "failure");
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual((await call(invalidGrant, "failure")).response, denied.response);
      assert.deepEqual(await readBases(args.name), []);
      assert.equal(knowledgeCreateRequests, 0);

      const outcomes = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { response, record } = await call(args, "success");
        const body = response.body.result.structuredContent.knowledgeBase;
        const row = (await readBases(args.name)).find(({ id }) => id === body.id);
        assert.ok(row?.createdAt instanceof Date);
        assert.ok(row.updatedAt instanceof Date);
        assert.deepEqual(row, {
          id: body.id, organizationId: org, name: args.name, description: args.description,
          createdBy: owner, createdByServiceAccountId: null, visibility: "org-wide", teamIds: [], status: "active",
          createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: null,
        });
        assert.deepEqual(body, { id: row.id, organizationId: org, name: args.name, description: args.description, status: "active" });
        const [policy] = await db.select().from(policies).where(and(
          eq(policies.organizationId, org), eq(policies.resource, "knowledgeBase"), eq(policies.scope, body.id),
        ));
        assert.equal(policy.legacySharingMigrated, true);
        assert.equal(policy.legacyOrganizationAudience, false);
        assert.equal(policy.revision, 1);
        assert.equal(policy.grants.length, 2);
        assert.ok(policy.grants.some(({ subject, actions }) => subject.type === "user" && subject.id === owner && actions.includes("manage-permissions")));
        assert.deepEqual(policy.grants.find(({ subject }) => subject.type === "user" && subject.id === member)?.actions, ["read"]);
        assert.equal(record.resourceId, body.id);
        assert.equal(record.after?.name, args.name);
        outcomes.push({ grants: policy.grants, response: JSON.parse(JSON.stringify(response).replaceAll(body.id, "knowledge-base-id")
          .replaceAll(row.createdAt.toISOString(), "created").replaceAll(row.updatedAt.toISOString(), "updated")) });
      }
      assert.deepEqual(outcomes[1], outcomes[0]);

      const rejection = { ...args, name: "Failed KB policy write" };
      await db.execute(sql`ALTER TABLE resource_permission_policies ADD CONSTRAINT riir_reject_kb_policy CHECK (resource <> 'knowledgeBase') NOT VALID`);
      try {
        config.mcpGateway.rustDiscoverEnabled = false;
        const legacy = await call(rejection, "failure");
        config.mcpGateway.rustDiscoverEnabled = true;
        const native = await call(rejection, "failure");
        assert.deepEqual(native.response, legacy.response);
        assert.equal(native.record.resourceId, null);
        assert.equal(native.record.after, null);
        assert.deepEqual(await readBases(rejection.name), []);
      } finally {
        await db.execute(sql`ALTER TABLE resource_permission_policies DROP CONSTRAINT riir_reject_kb_policy`);
      }
      assert.equal(knowledgeCreateRequests, 2);
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyTeamCreated = await post(teamCreateCall(teamCreateArgs));
    assert.equal(legacyTeamCreated.body.result.isError, false, JSON.stringify(legacyTeamCreated.body));
    const invalidTeamParent = teamCreateCall({ ...teamCreateArgs, parent_id: randomUUID() });
    const legacyParentDenied = await post(invalidTeamParent);
    assert.equal(legacyParentDenied.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(invalidTeamParent), legacyParentDenied);
    assert.equal(teamCreateRequests, 0);
    const nativeTeamCreated = await post(teamCreateCall(teamCreateArgs));
    assert.equal(nativeTeamCreated.body.result.isError, false, JSON.stringify(nativeTeamCreated.body));
    const legacyNewTeam = legacyTeamCreated.body.result.structuredContent.team;
    const nativeNewTeam = nativeTeamCreated.body.result.structuredContent.team;
    assert.equal(nativeNewTeam.memberCount, 1);
    assert.deepEqual(nativeNewTeam.labels, [{ key: "team-create", value: "last" }]);
    assert.equal(JSON.stringify(nativeTeamCreated).replaceAll(nativeNewTeam.id, legacyNewTeam.id)
      .replaceAll(nativeNewTeam.createdAt, legacyNewTeam.createdAt), JSON.stringify(legacyTeamCreated));
    for (const team of [legacyNewTeam, nativeNewTeam]) {
      const members = await TeamModel.getTeamMembers(team.id);
      assert.deepEqual(members.map(({ userId, role, syncedFromSso, roleSyncedFromSso }) =>
        ({ userId, role, syncedFromSso, roleSyncedFromSso })), [
        { userId: owner, role: "admin", syncedFromSso: false, roleSyncedFromSso: false },
      ]);
      assert.equal(members[0].createdAt.toISOString(), team.createdAt);
    }
    const failedTeamArgs = { ...teamCreateArgs, name: "Team membership rollback fixture" };
    await db.execute(sql`ALTER TABLE team_member ADD CONSTRAINT riir_reject_creator_membership CHECK (false) NOT VALID`);
    try {
      config.mcpGateway.rustDiscoverEnabled = false;
      const rejectedLegacyTeam = await post(teamCreateCall(failedTeamArgs));
      assert.equal(rejectedLegacyTeam.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(teamCreateCall(failedTeamArgs)), rejectedLegacyTeam);
      assert.equal(await TeamModel.findByName(failedTeamArgs.name, org), null);
      assert.equal(teamCreateRequests, 2);
    } finally {
      await db.execute(sql`ALTER TABLE team_member DROP CONSTRAINT riir_reject_creator_membership`);
    }
    const editBothTeams = async (fields) => {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(teamEditCall(legacyNewTeam.id, fields));
      config.mcpGateway.rustDiscoverEnabled = true;
      const native = await post(teamEditCall(nativeNewTeam.id, fields));
      const legacyTeam = legacy.body.result.structuredContent?.team;
      const nativeTeam = native.body.result.structuredContent?.team;
      if (legacyTeam && nativeTeam) {
        const normalize = ({ id, updatedAt, createdAt, ...team }) => team;
        assert.deepEqual(normalize(nativeTeam), normalize(legacyTeam));
        assert.deepEqual(native, {
          ...legacy,
          body: JSON.parse(JSON.stringify(legacy.body).replaceAll(legacyTeam.id, nativeTeam.id)
            .replaceAll(legacyTeam.createdAt, nativeTeam.createdAt)
            .replaceAll(legacyTeam.updatedAt, nativeTeam.updatedAt)),
        });
      } else {
        assert.deepEqual(native, legacy);
      }
      return native.body.result;
    };
    const renamed = (await editBothTeams({ name: "Team rename parity fixture" })).structuredContent.team;
    assert.equal(renamed.parentId, ownTeam.id);
    assert.deepEqual(renamed.roles, ["member"]);
    assert.deepEqual(renamed.labels, nativeNewTeam.labels);
    const cleared = (await editBothTeams({ parent_id: null, description: null, roles: [], labels: [] })).structuredContent.team;
    assert.equal(cleared.description, null);
    assert.equal(cleared.parentId, null);
    assert.deepEqual(cleared.roles, []);
    assert.deepEqual(cleared.labels, []);
    const teamState = async () => {
      const team = await TeamModel.findById(nativeNewTeam.id);
      const labels = await db.select().from(schema.teamLabelsTable).where(eq(schema.teamLabelsTable.teamId, team.id));
      return { team, labels };
    };
    const beforeTeamEditFailure = await teamState();
    assert.equal(beforeTeamEditFailure.team.name, renamed.name);
    assert.equal(beforeTeamEditFailure.team.parentId, null);
    assert.deepEqual(beforeTeamEditFailure.team.roles, []);
    assert.deepEqual(beforeTeamEditFailure.labels, []);
    await db.execute(sql`ALTER TABLE team_labels ADD CONSTRAINT riir_reject_team_edit_label CHECK (false) NOT VALID`);
    try {
      const failedEdit = await editBothTeams({ name: "Team edit must roll back", labels: [{ key: "team-edit", value: "reject" }] });
      assert.equal(failedEdit.isError, true);
      assert.deepEqual(await teamState(), beforeTeamEditFailure);
    } finally {
      await db.execute(sql`ALTER TABLE team_labels DROP CONSTRAINT riir_reject_team_edit_label`);
    }
    const relabeled = (await editBothTeams({ labels: [{ key: "team-edit", value: "saved" }] })).structuredContent.team;
    assert.deepEqual(relabeled.labels, [{ key: "team-edit", value: "saved" }]);
    assert.equal((await teamState()).labels.length, 1);
    assert.equal(relabeled.memberCount, 1);
    assert.equal(teamEditRequests, 4);

    const noSuchMember = teamMemberAddCall(nativeNewTeam.id, randomUUID());
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyMissingMember = await post(noSuchMember);
    assert.equal(legacyMissingMember.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(noSuchMember), legacyMissingMember);
    assert.equal(teamMemberAddRequests, 0);
    let expectedAdd, expectedDuplicate;
    for (const [index, team] of [legacyNewTeam, nativeNewTeam].entries()) {
      config.mcpGateway.rustDiscoverEnabled = index === 1;
      const add = await post(teamMemberAddCall(team.id, `${member}@example.invalid`, "admin"));
      const added = add.body.result.structuredContent?.member;
      assert.equal(added?.userId, member, JSON.stringify(add.body));
      const duplicate = await post(teamMemberAddCall(team.id, member));
      assert.equal(duplicate.body.result.isError, true);
      if (index === 0) {
        expectedAdd = add;
        expectedDuplicate = duplicate;
      } else {
        const expectedMember = expectedAdd.body.result.structuredContent.member;
        assert.deepEqual({
          ...add, body: JSON.parse(JSON.stringify(add.body)
            .replaceAll(team.id, legacyNewTeam.id)
            .replaceAll(added.id, expectedMember.id)
            .replaceAll(added.createdAt, expectedMember.createdAt)),
        }, expectedAdd);
        assert.deepEqual(duplicate, expectedDuplicate);
      }
      const rows = await TeamModel.getTeamMembers(team.id);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.find(({ userId }) => userId === member), {
        id: added.id, teamId: team.id, userId: member, role: "admin",
        syncedFromSso: false, roleSyncedFromSso: false, createdAt: new Date(added.createdAt),
      });
    }
    assert.equal(teamMemberAddRequests, 1);
    let legacyRoleUpdate, legacyLastAdmin;
    for (const [index, team] of [legacyNewTeam, nativeNewTeam].entries()) {
      config.mcpGateway.rustDiscoverEnabled = index === 1;
      const rows = await TeamModel.getTeamMembers(team.id);
      const existing = rows.find(({ userId }) => userId === member);
      await db.update(schema.teamMembersTable).set({ syncedFromSso: true, roleSyncedFromSso: true })
        .where(eq(schema.teamMembersTable.id, existing.id));
      const changed = await post(teamMemberRoleCall(team.id, member, "member"));
      const updated = changed.body.result.structuredContent?.member;
      assert.equal(updated?.id, existing.id, JSON.stringify(changed.body));
      assert.deepEqual(await TeamModel.getTeamMembers(team.id).then((members) =>
        members.find(({ userId }) => userId === member)), {
        ...existing, role: "member", syncedFromSso: true, roleSyncedFromSso: false,
      });
      const lastAdmin = await post(teamMemberRoleCall(team.id, owner, "member"));
      assert.equal(lastAdmin.body.result.isError, true);
      assert.equal(await TeamModel.getMemberRole(team.id, owner), "admin");
      if (index === 0) {
        legacyRoleUpdate = changed;
        legacyLastAdmin = lastAdmin;
      } else {
        const expected = legacyRoleUpdate.body.result.structuredContent.member;
        assert.deepEqual({
          ...changed, body: JSON.parse(JSON.stringify(changed.body)
            .replaceAll(team.id, expected.teamId)
            .replaceAll(updated.id, expected.id)
            .replaceAll(updated.createdAt, expected.createdAt)),
        }, legacyRoleUpdate);
        assert.deepEqual(lastAdmin, legacyLastAdmin);
      }
    }
    assert.equal(teamMemberRoleRequests, 1);
    assert.equal(await callRustApi({
      socketPath: socket, path: "/internal/v1/mcp/tools/update-team-member-role",
      json: JSON.stringify({ teamId: nativeNewTeam.id, organizationId: org, userId: owner, role: "member" }),
    }), "last_admin");
    assert.equal(await TeamModel.getMemberRole(nativeNewTeam.id, owner), "admin");

    const [scopedProvider, foreignProvider] = await db.insert(schema.identityProvidersTable).values(
      [org, otherOrg].map((organizationId) => ({
        id: randomUUID(), providerId: randomUUID(), organizationId,
        issuer: "https://fixture.example.invalid", domain: "fixture.example.invalid",
      })),
    ).returning();
    const foreignGroup = addExternalGroupCall(nativeNewTeam.id, {
      group_identifier: "Foreign provider fixture", identity_provider_id: foreignProvider.id,
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyForeignGroup = await post(foreignGroup);
    assert.equal(legacyForeignGroup.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(foreignGroup), legacyForeignGroup);
    assert.equal(externalGroupAddRequests, 0);
    const legacyExternalLinks = [];
    for (const [index, team] of [legacyNewTeam, nativeNewTeam].entries()) {
      config.mcpGateway.rustDiscoverEnabled = index === 1;
      const groupArgs = { group_identifier: "FiXTURE-Group" };
      for (const [scopeIndex, fields] of [
        groupArgs, { ...groupArgs, identity_provider_id: scopedProvider.id, role: "admin" },
      ].entries()) {
        const response = await post(addExternalGroupCall(team.id, fields));
        const createdGroup = response.body.result.structuredContent?.externalGroup;
        assert.equal(createdGroup?.groupIdentifier, "fixture-group", JSON.stringify(response.body));
        assert.equal(createdGroup.identityProviderId, fields.identity_provider_id ?? null);
        assert.equal(createdGroup.role, fields.role ?? "member");
        assert.deepEqual((await TeamModel.getExternalGroups(team.id)).find(({ id }) => id === createdGroup.id), {
          ...createdGroup, createdAt: new Date(createdGroup.createdAt),
        });
        if (index === 0) legacyExternalLinks.push(response);
        else {
          const expected = legacyExternalLinks[scopeIndex].body.result.structuredContent.externalGroup;
          assert.deepEqual({
            ...response, body: JSON.parse(JSON.stringify(response.body)
              .replaceAll(team.id, expected.teamId).replaceAll(createdGroup.id, expected.id)
              .replaceAll(createdGroup.createdAt, expected.createdAt)),
          }, legacyExternalLinks[scopeIndex]);
        }
      }
      const storedGroups = await TeamModel.getExternalGroups(team.id);
      const duplicateLink = await post(addExternalGroupCall(team.id, { group_identifier: "FIXTURE-GROUP", role: "admin" }));
      assert.equal(duplicateLink.body.result.isError, true);
      assert.equal(storedGroups.length, 2);
      assert.deepEqual(await TeamModel.getExternalGroups(team.id), storedGroups);
      if (index === 0) legacyExternalLinks.push(duplicateLink);
      else assert.deepEqual(duplicateLink, legacyExternalLinks[2]);
    }
    assert.equal(externalGroupAddRequests, 2);
    assert.equal(await callRustApi({
      socketPath: socket, path: "/internal/v1/mcp/tools/add-team-external-group",
      json: JSON.stringify({ teamId: nativeNewTeam.id, organizationId: org, groupIdentifier: "fixture-group", role: "admin" }),
    }), "unique_violation");

    const expectedUnlinks = [];
    for (const [index, team] of [legacyNewTeam, nativeNewTeam].entries()) {
      const originalLinks = await TeamModel.getExternalGroups(team.id);
      const scoped = originalLinks.find(({ identityProviderId }) => identityProviderId === scopedProvider.id);
      const unscoped = originalLinks.find(({ identityProviderId }) => identityProviderId === null);
      config.mcpGateway.rustDiscoverEnabled = index === 1;
      const byId = { group_id: scoped.id, group_identifier: "FIXTURE-GROUP" };
      const removedById = await post(removeExternalGroupCall(team.id, byId));
      assert.deepEqual(removedById.body.result.structuredContent, { success: true, teamId: team.id });
      assert.deepEqual(await TeamModel.getExternalGroups(team.id), [unscoped]);
      const missingId = await post(removeExternalGroupCall(team.id, byId));
      assert.equal(missingId.body.result.isError, true);
      assert.deepEqual(await TeamModel.getExternalGroups(team.id), [unscoped]);

      await TeamModel.addExternalGroup({
        teamId: team.id, groupIdentifier: scoped.groupIdentifier, identityProviderId: scopedProvider.id, role: "admin",
      });
      const byIdentifier = removeExternalGroupCall(team.id, { group_identifier: "FiXTURE-GrOUP" });
      const removedByIdentifier = await post(byIdentifier);
      assert.deepEqual(removedByIdentifier.body.result.structuredContent, { success: true, teamId: team.id });
      assert.deepEqual(await TeamModel.getExternalGroups(team.id), []);
      const missingIdentifier = await post(byIdentifier);
      assert.equal(missingIdentifier.body.result.isError, true);

      const outcomes = [removedById, missingId, removedByIdentifier, missingIdentifier];
      if (index === 0) expectedUnlinks.push(...outcomes);
      else assert.deepEqual(outcomes.map((response) => ({
        ...response, body: JSON.parse(JSON.stringify(response.body).replaceAll(team.id, legacyNewTeam.id)),
      })), expectedUnlinks);
    }
    assert.equal(externalGroupRemoveRequests, 4);
    assert.equal((await TeamModel.getExternalGroups(hiddenTeam.id)).length, 1);

    const memberInstallation = await McpServerModel.create({
      name: catalog.name, catalogId: catalog.id, serverType: "remote", ownerId: member,
    });
    let legacyRemoval, legacyMissingRemoval, legacyLastAdminRemoval;
    for (const [index, team] of [legacyNewTeam, nativeNewTeam].entries()) {
      const scopedAgent = await AgentModel.create({
        organizationId: org, agentType: "agent", name: `Team member cleanup fixture ${index}`,
      }, owner, {
        skipCreationDefaultTools: true,
        initialPermissionGrants: [{ subject: { type: "team", id: team.id }, actions: ["read", "use"] }],
      });
      const pin = await AgentToolModel.create(scopedAgent.id, echo.id, { mcpServerId: memberInstallation.id });
      assert.equal(pin.mcpServerId, memberInstallation.id);
      config.mcpGateway.rustDiscoverEnabled = index === 1;
      const removal = await post(teamMemberRemoveCall(team.id, member));
      assert.deepEqual(removal.body.result.structuredContent, { success: true, teamId: team.id, userId: member });
      assert.equal(await TeamModel.getMemberRole(team.id, member), null);
      assert.equal((await AgentToolModel.findById(pin.id)).mcpServerId, null);
      const missing = await post(teamMemberRemoveCall(team.id, member));
      const lastAdmin = await post(teamMemberRemoveCall(team.id, owner));
      assert.equal(missing.body.result.isError, true);
      assert.equal(lastAdmin.body.result.isError, true);
      assert.equal(await TeamModel.getMemberRole(team.id, owner), "admin");
      if (index === 0) {
        legacyRemoval = removal;
        legacyMissingRemoval = missing;
        legacyLastAdminRemoval = lastAdmin;
      } else {
        assert.deepEqual({
          ...removal, body: JSON.parse(JSON.stringify(removal.body).replaceAll(team.id, legacyNewTeam.id)),
        }, legacyRemoval);
        assert.deepEqual(missing, legacyMissingRemoval);
        assert.deepEqual(lastAdmin, legacyLastAdminRemoval);
      }
    }
    assert.equal(teamMemberRemoveRequests, 1);
    assert.equal(await callRustApi({
      socketPath: socket, path: "/internal/v1/mcp/tools/remove-team-member",
      json: JSON.stringify({ teamId: nativeNewTeam.id, organizationId: org, userId: owner }),
    }), "last_admin");
    assert.equal(await TeamModel.getMemberRole(nativeNewTeam.id, owner), "admin");

    const deleteFixtures = await Promise.all([legacyNewTeam, nativeNewTeam].map(({ id }) =>
      TeamModel.create({ name: "Child of deleted team fixture", organizationId: org, parentId: id, createdBy: owner })));
    const nativeTeamLabels = await teamState();
    assert.equal(nativeTeamLabels.labels.length, 1);
    let legacyDelete, legacyMissingTeam;
    for (const [index, target] of [legacyNewTeam, nativeNewTeam].entries()) {
      config.mcpGateway.rustDiscoverEnabled = index === 1;
      const removed = await post(teamDeleteCall(target.id));
      assert.deepEqual(removed.body.result.structuredContent, { success: true, id: target.id });
      const missing = await post(teamDeleteCall(target.id));
      assert.equal(missing.body.result.isError, true);
      if (index === 0) {
        legacyDelete = removed;
        legacyMissingTeam = missing;
      } else {
        const normalize = (response) => ({
          ...response,
          body: JSON.parse(JSON.stringify(response.body).replaceAll(target.id, legacyNewTeam.id)),
        });
        assert.deepEqual(normalize(removed), legacyDelete);
        assert.deepEqual(normalize(missing), legacyMissingTeam);
      }
      assert.equal(await TeamModel.findById(target.id), null);
      assert.deepEqual(await TeamModel.getTeamMembers(target.id), []);
      assert.deepEqual(await db.select().from(schema.teamLabelsTable).where(eq(schema.teamLabelsTable.teamId, target.id)), []);
      assert.equal((await TeamModel.findById(deleteFixtures[index].id)).parentId, null);
    }
    assert.equal(teamDeleteRequests, 1);
    config.mcpGateway.rustDiscoverEnabled = false;
    const adminInteraction = await post(interactionCall(otherUserLog.id));
    assert.equal(adminInteraction.body.result.structuredContent.interaction.id, otherUserLog.id);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(interactionCall(otherUserLog.id)), adminInteraction);
    config.mcpGateway.rustDiscoverEnabled = false;
    const adminSessionLogs = await post(sessionLogsCall({ session_id: sharedSession }));
    assert.deepEqual(adminSessionLogs.body.result.structuredContent.data.map(({ id }) => id).sort(), pageRows.slice(0, 3).map(({ id }) => id).sort());
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(sessionLogsCall({ session_id: sharedSession })), adminSessionLogs);
    const [ownLimit] = await db.insert(schema.limitsTable).values([
      { entityType: "agent", entityId: gateway.id, limitType: "token_cost", limitValue: 50,
        lastCleanup: new Date("2026-01-01T00:00:00.123Z") },
      { entityType: "agent", entityId: randomUUID(), limitType: "token_cost", limitValue: 999 },
    ]).returning();
    const limitArgs = { entity_type: "agent", entity_id: gateway.id, limit_type: "token_cost" };
    const limitCall = (args) => ({
      ...usageCall(getLimits), params: { name: getLimits, arguments: args },
    });
    const beforeLimits = limitRequests;
    for (const args of [limitArgs, { entity_type: "agent" }, { ...limitArgs, entity_id: randomUUID() }]) {
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacy = await post(limitCall(args));
      const expected = args.entity_id && args.entity_id !== gateway.id ? [] : [ownLimit.id];
      assert.deepEqual(legacy.body.result.structuredContent.limits.map(({ id }) => id), expected);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(limitCall(args)), legacy);
    }
    assert.equal(limitRequests, beforeLimits + 3);
    const beforeLimitCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
    holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
    const stopLimits = new AbortController();
    const limitsCancelled = assert.rejects(call(stopLimits, "riir-limits-cancel", getLimits, limitArgs), { name: "AbortError" });
    try {
      await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native limit lookup did not respond"))]);
    } finally {
      stopLimits.abort();
      await limitsCancelled;
    }
    await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("limit relay was not cancelled"))]);
    assert.equal((await singleAuditSince(beforeLimitCancel)).toolResult.isError, true);
    assert.equal(limitRequests, beforeLimits + 4);
    holdToolReply = undefined;

    const otherLimit = createLimitCall({ ...createLimitArgs, entity_id: otherOrgAgent.id });
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedForeignLimit = await post(otherLimit);
    assert.equal(deniedForeignLimit.body.result.isError, true);
    const legacyLimitCreate = await post(createLimitCall(createLimitArgs));
    const legacyCreatedLimit = legacyLimitCreate.body.result.structuredContent?.limit;
    assert.equal(legacyCreatedLimit?.cleanupInterval, "calendar_month", JSON.stringify(legacyLimitCreate.body));
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(otherLimit), deniedForeignLimit);
    assert.equal(limitCreateRequests, 0);
    const nativeLimitCreate = await post(createLimitCall(createLimitArgs));
    const nativeCreatedLimit = nativeLimitCreate.body.result.structuredContent?.limit;
    assert.equal(nativeCreatedLimit?.reason, "Fixture budget", JSON.stringify(nativeLimitCreate.body));
    const persistedLimit = async (id) => {
      const [row] = await db.select().from(schema.limitsTable).where(eq(schema.limitsTable.id, id));
      return row;
    };
    const legacyLimitRow = await persistedLimit(legacyCreatedLimit.id);
    const nativeLimitRow = await persistedLimit(nativeCreatedLimit.id);
    const normalizeLimit = (body) => JSON.parse(JSON.stringify(body)
      .replaceAll(nativeLimitRow.id, legacyLimitRow.id)
      .replaceAll(nativeLimitRow.createdAt.toISOString(), legacyLimitRow.createdAt.toISOString())
      .replaceAll(nativeLimitRow.updatedAt.toISOString(), legacyLimitRow.updatedAt.toISOString()));
    assert.deepEqual({ ...nativeLimitCreate, body: normalizeLimit(nativeLimitCreate.body) }, legacyLimitCreate);
    assert.deepEqual(normalizeLimit(nativeLimitRow), JSON.parse(JSON.stringify(legacyLimitRow)));
    for (const row of [legacyLimitRow, nativeLimitRow]) {
      assert.deepEqual(await db.select({
        model: schema.limitModelUsageTable.model,
        input: schema.limitModelUsageTable.currentUsageTokensIn,
        output: schema.limitModelUsageTable.currentUsageTokensOut,
      }).from(schema.limitModelUsageTable).where(eq(schema.limitModelUsageTable.limitId, row.id))
        .orderBy(schema.limitModelUsageTable.model), createLimitArgs.model.map((model) => ({ model, input: 0, output: 0 })));
    }
    assert.equal(limitCreateRequests, 1);

    const updateLimit = "archestra__update_limit";
    const updateLimitCall = (id, fields) => ({
      ...usageCall(updateLimit), params: { name: updateLimit, arguments: { id, ...fields } },
    });
    const limitRows = [legacyLimitRow, nativeLimitRow];
    const models = createLimitArgs.model;
    for (const row of limitRows) {
      await db.update(schema.limitModelUsageTable).set({ currentUsageTokensIn: 30, currentUsageTokensOut: 4 })
        .where(eq(schema.limitModelUsageTable.limitId, row.id));
      await db.insert(schema.limitBillingUsageTable).values({ limitId: row.id, model: models[0], cost: "0.01" });
    }
    const [foreignLimitRow] = await db.insert(schema.limitsTable).values({
      entityType: "agent", entityId: otherOrgAgent.id, limitType: "token_cost", limitValue: 91,
    }).returning();
    const foreignLimitEdit = updateLimitCall(foreignLimitRow.id, { limit_value: 28 });
    config.mcpGateway.rustDiscoverEnabled = false;
    const deniedUpdate = await post(foreignLimitEdit);
    assert.equal(deniedUpdate.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(foreignLimitEdit), deniedUpdate);
    assert.equal(limitUpdateRequests, 0);
    assert.equal((await persistedLimit(foreignLimitRow.id)).limitValue, 91);

    const readLimitUsage = async (id) => {
      const tokens = await db.select({
        input: schema.limitModelUsageTable.currentUsageTokensIn,
        output: schema.limitModelUsageTable.currentUsageTokensOut,
      }).from(schema.limitModelUsageTable).where(eq(schema.limitModelUsageTable.limitId, id));
      const billing = await db.select().from(schema.limitBillingUsageTable).where(eq(schema.limitBillingUsageTable.limitId, id));
      return { tokens, billing: billing.length };
    };
    for (const [fields, reset] of [[{ limit_value: 31 }, false],
      [{ cleanup_interval: "calendar_day", model: [], reason: null }, true]]) {
      const results = [];
      for (const [index, { id }] of limitRows.entries()) {
        config.mcpGateway.rustDiscoverEnabled = index === 1;
        const response = await post(updateLimitCall(id, fields));
        const stored = await persistedLimit(id);
        assert.equal(response.body.result.isError, false, JSON.stringify(response.body));
        assert.equal(stored.limitValue, 31);
        assert.deepEqual(stored.model, reset ? null : models);
        assert.equal(stored.reason, reset ? null : "Fixture budget");
        assert.equal(stored.cleanupInterval, reset ? "calendar_day" : "calendar_month");
        if (reset) assert.ok(stored.lastCleanup instanceof Date);
        else assert.equal(stored.lastCleanup, null);
        assert.deepEqual(await readLimitUsage(id), {
          tokens: models.map(() => reset ? { input: 0, output: 0 } : { input: 30, output: 4 }),
          billing: reset ? 0 : 1,
        });
        results.push({
          ...response, body: JSON.parse(JSON.stringify(response.body)
            .replaceAll(id, "normalized-limit")
            .replaceAll(stored.createdAt.toISOString(), "created")
            .replaceAll(stored.updatedAt.toISOString(), "updated")
            .replaceAll(stored.lastCleanup?.toISOString() ?? "__no_cleanup_timestamp__", "reset")),
        });
      }
      assert.deepEqual(results[1], results[0]);
    }
    assert.equal(limitUpdateRequests, 2);

    const deleteLimit = "archestra__delete_limit";
    const deleteLimitCall = (id) => ({
      ...usageCall(deleteLimit), params: { name: deleteLimit, arguments: { id } },
    });
    config.mcpGateway.rustDiscoverEnabled = false;
    const foreignDelete = deleteLimitCall(foreignLimitRow.id);
    const deniedDelete = await post(foreignDelete);
    assert.equal(deniedDelete.body.result.isError, true);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(foreignDelete), deniedDelete);
    assert.equal(limitDeleteRequests, 0);
    assert.equal(await callRustApi({
      socketPath: socket, path: "/internal/v1/mcp/tools/delete-limit",
      json: JSON.stringify({ id: foreignLimitRow.id, organizationId: org }),
    }), false);
    assert.deepEqual(await persistedLimit(foreignLimitRow.id), foreignLimitRow);

    const [legacyTokens, nativeTokens, legacySpend, nativeSpend] = await db.insert(schema.limitsTable).values(
      ["tokens_per_minute", "tokens_per_minute", "token_cost", "token_cost"].map((limitType) => ({
        entityType: "organization", entityId: org, limitType, limitValue: 91, cleanupInterval: "minute",
      })),
    ).returning();
    const throughKey = ({ id, limitType }) =>
      `keyv:llm-throughput-counter-${limitType.startsWith("tokens") ? "actual-tokens-v1-" : ""}${id}`;
    const setThroughCounter = (row, raw) =>
      CacheEntryModel.withLock(`llm-throughput:${row.id}`, (entries) => entries.set(throughKey(row), raw));
    const getThroughCounter = async (row) => (await CacheEntryModel.getMany([throughKey(row)]))[0]?.value;
    const normalizedUpdate = (response, row) => JSON.parse(JSON.stringify(response)
      .replaceAll(row.id, "normalized-limit")
      .replaceAll(row.createdAt.toISOString(), "created")
      .replaceAll(row.updatedAt.toISOString(), "updated")
      .replaceAll(row.lastCleanup?.toISOString() ?? "__not_reset__", "reset"));

    const sharedEdits = [];
    for (const [index, row] of [legacyTokens, nativeTokens, legacySpend, nativeSpend].entries()) {
      config.mcpGateway.rustDiscoverEnabled = index % 2 === 1;
      const token = row.limitType === "tokens_per_minute";
      const start = await CacheEntryModel.withLock(`llm-throughput:${row.id}`, (entries) => entries.now());
      const raw = JSON.stringify({
        value: { version: 2, generation: randomUUID(), count: 100, released: 4,
          updatedAt: start - 12_000, rate: 20, interval: "minute" },
        expires: start + 300_000,
      });
      await setThroughCounter(row, raw);
      const cap = await post(updateLimitCall(row.id, { limit_value: 120 }));
      assert.equal(cap.body.result.isError, false, JSON.stringify(cap.body));
      const edited = await persistedLimit(row.id);
      assert.equal(edited.limitValue, 120);
      assert.equal(edited.lastCleanup, null);
      const bucket = JSON.parse(await getThroughCounter(row));
      const expected = readBucket({
        raw, now: bucket.value.updatedAt, capacity: 120, interval: "minute",
      });
      const { count, released, ...metadata } = bucket.value;
      assert.deepEqual({ ...metadata, count: expected.count, released: expected.released },
        JSON.parse(JSON.stringify(expected)));
      assert.ok(Math.abs(count - expected.count) < 0.000001);
      assert.ok(Math.abs(released - expected.released) < 0.000001);
      assert.ok(Math.abs(bucket.expires - (bucket.value.updatedAt + count * 60_000 / 120 + 1)) < 0.001);

      await db.insert(schema.limitModelUsageTable).values({ limitId: row.id, model: models[0], currentUsageTokensIn: 7 });
      await db.insert(schema.limitBillingUsageTable).values({ limitId: row.id, model: models[0], cost: "0.01" });
      const transition = updateLimitCall(row.id, {
        ...(token && { limit_type: "tokens" }), cleanup_interval: "calendar_week_monday",
      });
      await setThroughCounter(row, "{");
      const failure = token
        ? await post(transition)
        : await post(updateLimitCall(row.id, { limit_value: 130 }));
      assert.equal(failure.body.result.isError, true);
      assert.deepEqual(await persistedLimit(row.id), edited);
      assert.equal(await getThroughCounter(row), "{");
      assert.deepEqual(await readLimitUsage(row.id), { tokens: [{ input: 7, output: 0 }], billing: 1 });

      await setThroughCounter(row, JSON.stringify(bucket));
      const changed = await post(transition);
      assert.equal(changed.body.result.isError, false, JSON.stringify(changed.body));
      const stored = await persistedLimit(row.id);
      assert.equal(stored.cleanupInterval, "calendar_week_monday");
      assert.equal(stored.limitType, token ? "tokens" : "token_cost");
      assert.deepEqual(await readLimitUsage(row.id), { tokens: [{ input: 0, output: 0 }], billing: 0 });
      if (token) {
        const reset = JSON.parse(await getThroughCounter(row));
        const { value } = reset;
        assert.notEqual(value.generation, bucket.value.generation);
        assert.equal(value.epoch, stored.lastCleanup.toISOString());
        assert.equal(value.count, 0);
        assert.equal(reset.expires, readBucket({
          now: value.updatedAt, capacity: 120, interval: stored.cleanupInterval,
        }).periodEnd);
      } else {
        assert.equal(await getThroughCounter(row), JSON.stringify(bucket));
        const back = await post(updateLimitCall(row.id, { cleanup_interval: "minute" }));
        assert.equal(back.body.result.isError, false, JSON.stringify(back.body));
        const reset = JSON.parse(await getThroughCounter(row)).value;
        assert.notEqual(reset.generation, bucket.value.generation);
        assert.equal(reset.epoch, (await persistedLimit(row.id)).lastCleanup.toISOString());
        assert.equal(reset.count, 0);
      }
      const outcomes = [normalizedUpdate(cap, edited), failure, normalizedUpdate(changed, stored)];
      if (index % 2 === 0) sharedEdits.push(outcomes);
      else assert.deepEqual(outcomes, sharedEdits.at(-1));
    }
    assert.equal(limitUpdateRequests, 9);
    for (const pair of [limitRows, [legacyTokens, nativeTokens], [legacySpend, nativeSpend]]) {
      const outcomes = [];
      for (const [index, { id, limitType }] of pair.entries()) {
        const key = throughKey({ id, limitType });
        await CacheEntryModel.withLock(`llm-throughput:${id}`, (entries) => entries.set(key, "{}"));
        assert.equal((await CacheEntryModel.getMany([key])).length, 1);
        await db.insert(schema.limitBillingUsageTable).values({ limitId: id, model: models[0], cost: "0.01" });
        config.mcpGateway.rustDiscoverEnabled = index === 1;
        const deleted = await post(deleteLimitCall(id));
        assert.deepEqual(deleted.body.result.structuredContent, { success: true, id });
        assert.equal(await persistedLimit(id), undefined);
        assert.deepEqual(await CacheEntryModel.getMany([key]), []);
        assert.deepEqual(await readLimitUsage(id), { tokens: [], billing: 0 });
        const missing = await post(deleteLimitCall(id));
        assert.equal(missing.body.result.isError, true);
        outcomes.push([{ ...deleted, body: JSON.parse(JSON.stringify(deleted.body)
          .replaceAll(id, "normalized-limit")) }, missing]);
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
    }
    assert.equal(limitDeleteRequests, 3);

    config.mcpGateway.rustDiscoverEnabled = false;
    const legacyManager = await post(teamCall("HIDDEN"));
    assert.deepEqual(legacyManager.body.result.structuredContent.teams.map(({ id }) => id), [hiddenTeam.id]);
    config.mcpGateway.rustDiscoverEnabled = true;
    assert.deepEqual(await post(teamCall("HIDDEN")), legacyManager);
    assert.equal(teamRequests, 6);
    await t.test("delete_knowledge_base soft-deletes, invalidates cache and writes one audit row", async () => {
      const name = "archestra__delete_knowledge_base";
      const deleteCall = (id) => ({ ...usageCall(name), params: { name, arguments: { id } } });
      const bases = schema.knowledgeBasesTable;
      const links = schema.agentKnowledgeBasesTable;
      const connectorLinks = schema.knowledgeBaseConnectorAssignmentsTable;
      const audit = schema.auditLogsTable;
      const readBase = async (id) => (await db.select().from(bases).where(eq(bases.id, id)))[0];
      const readAudit = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);

      const foreign = await KnowledgeBaseModel.create({ organizationId: otherOrg, name: "Foreign delete fixture", visibility: "org-wide" });
      const beforeForeign = await readBase(foreign.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deleteCall(foreign.id));
      assert.equal(denied.body.result.isError, true);
      assert.deepEqual((await readAudit(foreign.id)).map(({ outcome }) => outcome), ["failure"]);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deleteCall(foreign.id)), denied);
      assert.deepEqual((await readAudit(foreign.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(await callRustApi({
        socketPath: socket, path: "/internal/v1/mcp/tools/delete-knowledge-base",
        json: JSON.stringify({ id: foreign.id, organizationId: org }),
      }), false);
      assert.deepEqual(await readBase(foreign.id), beforeForeign);
      assert.equal(knowledgeDeleteRequests, 0);

      const outcomes = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const kb = await KnowledgeBaseModel.create({ organizationId: org, name: "KB delete fixture", createdBy: owner, visibility: "private" });
        const before = await readBase(kb.id);
        const assignments = await db.insert(links).values([
          { agentId: ownAgent.id, knowledgeBaseId: kb.id },
          { agentId: privateAgent.id, knowledgeBaseId: kb.id },
        ]).returning();
        const [connectorAssignment] = await db.insert(connectorLinks).values({
          knowledgeBaseId: kb.id, connectorId: ownConnector.id,
        }).returning();
        for (const { agentId } of assignments) {
          assert.ok((await AgentKnowledgeBaseModel.findByAgent(agentId)).some((row) => row.knowledgeBaseId === kb.id));
          agentKnowledgeSourcesCache.set(agentId, true);
        }
        const response = await post(deleteCall(kb.id));
        assert.equal(response.body.result.isError, false, JSON.stringify(response.body));
        const deleted = await readBase(kb.id);
        assert.ok(deleted.deletedAt instanceof Date);
        assert.ok(deleted.updatedAt >= before.updatedAt);
        assert.deepEqual(deleted, { ...before, deletedAt: deleted.deletedAt, updatedAt: deleted.updatedAt });
        assert.equal(await KnowledgeBaseModel.findById(kb.id), null);
        assert.deepEqual(await db.select().from(connectorLinks).where(eq(connectorLinks.knowledgeBaseId, kb.id)), [connectorAssignment]);
        assert.deepEqual((await db.select().from(links).where(eq(links.knowledgeBaseId, kb.id))).map(({ agentId }) => agentId).sort(),
          assignments.map(({ agentId }) => agentId).sort());
        for (const { agentId } of assignments) {
          assert.equal(agentKnowledgeSourcesCache.get(agentId), undefined);
          assert.ok(!(await AgentKnowledgeBaseModel.findByAgent(agentId)).some((row) => row.knowledgeBaseId === kb.id));
        }
        const records = await readAudit(kb.id);
        assert.equal(records.length, 1);
        const [record] = records;
        assert.equal(record.action, "knowledgeBase.deleted");
        assert.equal(record.actorId, owner);
        assert.equal(record.outcome, "success");
        assert.equal(record.before?.name, before.name);
        assert.deepEqual(record.before?.connectors, [ownConnector.name]);
        assert.equal(record.after, null);
        const missing = await post(deleteCall(kb.id));
        assert.equal(missing.body.result.isError, true);
        assert.deepEqual(await readBase(kb.id), deleted);
        assert.deepEqual((await readAudit(kb.id)).map(({ outcome }) => outcome), ["success", "failure"]);
        outcomes.push([response, missing].map((result) => JSON.parse(JSON.stringify(result).replaceAll(kb.id, "knowledge-base-id"))));
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(knowledgeDeleteRequests, 1);
    });

    await t.test("update_knowledge_base preserves response, connector rollback and single-write audit", async () => {
      const name = "archestra__update_knowledge_base";
      const updateCall = (id, fields) => ({ ...usageCall(name), params: { name, arguments: { id, ...fields } } });
      const environment = await EnvironmentModel.create({ organizationId: org, authorId: owner, name: "KB update fixture" });
      const [foreignEnvironment] = await db.insert(schema.environmentsTable)
        .values({ organizationId: otherOrg, name: "Foreign KB update fixture" }).returning();
      const connectors = schema.knowledgeBaseConnectorsTable;
      const audit = schema.auditLogsTable;
      const readConnector = async (id) => (await db.select().from(connectors).where(eq(connectors.id, id)))[0];
      const bases = schema.knowledgeBasesTable;
      const readBase = async (id) => (await db.select().from(bases).where(eq(bases.id, id)))[0];
      const readAudit = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);

      const deniedRequest = updateCall(ownKb.id, { uploadedFilesEnvironmentId: foreignEnvironment.id });
      const beforeDenied = await readBase(ownKb.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deniedRequest);
      assert.equal(denied.body.result.isError, true);
      assert.deepEqual((await readAudit(ownKb.id)).map(({ outcome }) => outcome), ["failure"]);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deniedRequest), denied);
      assert.deepEqual((await readAudit(ownKb.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.deepEqual(await readBase(ownKb.id), beforeDenied);
      assert.equal(knowledgeUpdateRequests, 0);

      await db.execute(sql`ALTER TABLE knowledge_bases ADD CONSTRAINT riir_reject_kb_update CHECK (name <> 'Rejected KB update')`);
      const outcomes = [];
      try {
        for (const native of [false, true]) {
          config.mcpGateway.rustDiscoverEnabled = native;
          const kb = await KnowledgeBaseModel.create({
            organizationId: org, name: "Original KB", description: "Keep until cleared", createdBy: owner, visibility: "private",
          });
          const responses = [];
          const auditOutcomes = [];
          const update = async (fields, outcome) => {
            const response = await post(updateCall(kb.id, fields));
            assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
            auditOutcomes.push(outcome);
            const records = await readAudit(kb.id);
            assert.deepEqual(records.map((row) => row.outcome), auditOutcomes);
            const record = records.at(-1);
            assert.equal(record.action, "knowledgeBase.updated");
            assert.equal(record.actorId, owner);
            return { response, record };
          };
          const untouched = await readBase(kb.id);
          const noUpload = await update({ name: "Not applied", uploadedFilesEnvironmentId: environment.id }, "failure");
          assert.deepEqual(await readBase(kb.id), untouched);
          const [connector] = await db.insert(connectors).values({
            organizationId: org, name: "KB fixture uploads", connectorType: "file_upload", config: {},
          }).returning();
          await db.insert(schema.kbUploadConnectorsTable).values({ knowledgeBaseId: kb.id, connectorId: connector.id });
          await db.insert(schema.knowledgeBaseConnectorAssignmentsTable).values({ knowledgeBaseId: kb.id, connectorId: connector.id });

          const checkSuccess = async (fields, rowPatch, environmentId) => {
            const before = await readBase(kb.id);
            const { response, record } = await update(fields, "success");
            const row = await readBase(kb.id);
            assert.deepEqual(row, { ...before, ...rowPatch, updatedAt: row.updatedAt });
            assert.equal((await readConnector(connector.id)).environmentId, environmentId);
            const { id, organizationId, name: storedName, description, status } = row;
            assert.deepEqual(response.body.result.structuredContent.knowledgeBase,
              { id, organizationId, name: storedName, description, status });
            assert.equal(record.before?.name, before.name);
            assert.equal(record.after?.name, row.name);
            assert.equal(record.after?.uploadedFilesEnvironmentId, environmentId);
            return JSON.parse(JSON.stringify(response).replaceAll(kb.id, "knowledge-base-id")
              .replaceAll(row.createdAt.toISOString(), "created").replaceAll(row.updatedAt.toISOString(), "updated"));
          };
          responses.push(noUpload.response);
          responses.push(await checkSuccess({ name: "Renamed KB", uploadedFilesEnvironmentId: environment.id },
            { name: "Renamed KB" }, environment.id));
          const previousBase = await readBase(kb.id);
          const previousConnector = await readConnector(connector.id);
          responses.push((await update({ name: "Rejected KB update", uploadedFilesEnvironmentId: null }, "failure")).response);
          assert.deepEqual(await readBase(kb.id), previousBase);
          assert.deepEqual(await readConnector(connector.id), previousConnector);
          responses.push(await checkSuccess({ description: null }, { description: null }, environment.id));
          assert.deepEqual(await readConnector(connector.id), previousConnector);
          responses.push(await checkSuccess({ uploadedFilesEnvironmentId: null }, {}, null));
          outcomes.push(responses.map((response) => JSON.parse(JSON.stringify(response).replaceAll(kb.id, "knowledge-base-id"))));
        }
      } finally {
        await db.execute(sql`ALTER TABLE knowledge_bases DROP CONSTRAINT riir_reject_kb_update`);
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(knowledgeUpdateRequests, 5);
    });

    await t.test("delete_knowledge_connector preserves cleanup, scope and single-write audit", async () => {
      const name = "archestra__delete_knowledge_connector";
      const deleteCall = (id) => ({ ...usageCall(name), params: { name, arguments: { id } } });
      const connectors = schema.knowledgeBaseConnectorsTable;
      const runs = schema.connectorRunsTable;
      const tasks = schema.tasksTable;
      const assignments = schema.agentConnectorAssignmentsTable;
      const audit = schema.auditLogsTable;
      const readConnector = async (id) => (await db.select().from(connectors).where(eq(connectors.id, id)))[0];
      const readAudit = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const [unrelatedTask] = await db.insert(tasks).values({
        taskType: "connector_sync", payload: { connectorId: otherConnector.id },
      }).returning();
      const beforeDenied = await readConnector(otherConnector.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deleteCall(otherConnector.id));
      assert.equal(denied.body.result.isError, true);
      assert.deepEqual((await readAudit(otherConnector.id)).map(({ outcome }) => outcome), ["failure"]);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deleteCall(otherConnector.id)), denied);
      assert.deepEqual((await readAudit(otherConnector.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(await callRustApi({
        socketPath: socket, path: "/internal/v1/mcp/tools/delete-knowledge-connector",
        json: JSON.stringify({ id: otherConnector.id, organizationId: org, environmentId: null }),
      }), false);
      assert.deepEqual(await readConnector(otherConnector.id), beforeDenied);
      assert.equal(connectorDeleteRequests, 0);

      const outcomes = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { id: secretId } = await SecretModel.create({ secret: { apiKey: "fixture-not-a-real-credential" } });
        const connector = await KnowledgeBaseConnectorModel.create({
          organizationId: org, name: "Connector deletion fixture", createdBy: owner, connectorType: "jira",
          config: ownConnector.config, secretId,
        });
        const id = connector.id;
        const [assignment] = await db.insert(assignments).values({ agentId: ownAgent.id, connectorId: id }).returning();
        agentKnowledgeSourcesCache.set(ownAgent.id, true);
        const activeRuns = await db.insert(runs).values(["content", "permission"].map((runType) => ({
          connectorId: id, runType, status: "running", leaseEpoch: 7, startedAt: started,
        }))).returning();
        const activeTasks = await db.insert(tasks).values([
          { taskType: "connector_sync", payload: { connectorId: id } },
          { taskType: "permission_sync", status: "processing", payload: { connectorId: id } },
          { taskType: "batch_embedding", payload: { connectorRunId: activeRuns[0].id } },
        ]).returning();
        const response = await post(deleteCall(id));
        assert.equal(response.body.result.isError, false, JSON.stringify(response.body));
        const deleted = await readConnector(id);
        assert.ok(deleted.deletedAt instanceof Date);
        assert.equal(deleted.environmentId, connector.environmentId);
        assert.equal(deleted.enabled, connector.enabled);
        assert.equal(deleted.secretId, null);
        assert.equal(await SecretModel.findById(secretId), null);
        assert.equal(await KnowledgeBaseConnectorModel.findById(id), null);
        assert.equal(agentKnowledgeSourcesCache.get(ownAgent.id), undefined);
        assert.deepEqual(await AgentConnectorAssignmentModel.findByConnector(id), [assignment]);
        assert.ok(!(await AgentConnectorAssignmentModel.findByAgent(ownAgent.id)).some((row) => row.connectorId === id));
        for (const task of activeTasks) {
          assert.deepEqual(await db.select().from(tasks).where(eq(tasks.id, task.id)), []);
        }
        assert.deepEqual(await db.select().from(tasks).where(eq(tasks.id, unrelatedTask.id)), [unrelatedTask]);
        for (const run of activeRuns) {
          const [stopped] = await db.select().from(runs).where(eq(runs.id, run.id));
          assert.equal(stopped.status, "superseded");
          assert.equal(stopped.leaseEpoch, run.leaseEpoch + 1);
          assert.ok(stopped.completedAt instanceof Date);
        }
        const records = await readAudit(id);
        assert.equal(records.length, 1);
        const [record] = records;
        assert.equal(record.action, "connector.deleted");
        assert.equal(record.actorId, owner);
        assert.equal(record.outcome, "success");
        assert.equal(record.before?.name, connector.name);
        assert.equal(record.before?.secretId, undefined);
        assert.equal(record.after, null);
        const missing = await post(deleteCall(id));
        assert.equal(missing.body.result.isError, true);
        assert.deepEqual((await readAudit(id)).map(({ outcome }) => outcome), ["success", "failure"]);
        assert.deepEqual(await readConnector(id), deleted);
        outcomes.push([response, missing].map((result) => JSON.parse(JSON.stringify(result).replaceAll(id, "connector-id"))));
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(connectorDeleteRequests, 1);
    });

    await t.test("update_knowledge_connector preserves checkpoint rollback, sync behavior and single-write audit", async () => {
      const name = "archestra__update_knowledge_connector";
      const edit = (id, fields) => ({ ...usageCall(name), params: { name, arguments: { id, ...fields } } });
      const connectors = schema.knowledgeBaseConnectorsTable, tasks = schema.tasksTable;
      const runs = schema.connectorRunsTable, documents = schema.kbDocumentsTable, audit = schema.auditLogsTable;
      const readConnector = async (id) => (await db.select().from(connectors).where(eq(connectors.id, id)))[0];
      const readTasks = (id) => db.select().from(tasks).where(and(
        eq(tasks.taskType, "permission_sync"), sql`${tasks.payload}->>'connectorId' = ${id}`,
      ));
      const readAudit = (id) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, id), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const deniedRequest = edit(otherConnector.id, { name: "Must not change" });
      const beforeDenied = await readConnector(otherConnector.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deniedRequest);
      assert.equal(denied.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deniedRequest), denied);
      assert.deepEqual(await readConnector(otherConnector.id), beforeDenied);
      assert.deepEqual((await readAudit(otherConnector.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(connectorUpdateRequests, 0);

      const settings = { type: "github", githubUrl: "https://github.fixture.invalid", owner: "fixture", repos: ["docs"], includeIssues: true };
      const configPatch = { ...settings, includeIssues: false };
      const checkpoint = { type: "github", lastSyncedAt: started.toISOString() };
      const outcomes = [];
      await db.execute(sql`ALTER TABLE knowledge_base_connectors ADD CONSTRAINT riir_reject_connector_update CHECK (name <> 'Rejected connector edit')`);
      try {
        for (const native of [false, true]) {
          config.mcpGateway.rustDiscoverEnabled = native;
          const secret = await SecretModel.create({ secret: { apiKey: "not-a-real-credential" } });
          const connector = await KnowledgeBaseConnectorModel.create({
            organizationId: org, createdBy: owner, connectorType: "github", name: "Original connector",
            description: "Fixture description", config: settings, secretId: secret.id,
            visibility: "auto-sync-permissions", lastPermissionSyncStatus: "running", checkpoint,
          });
          const { id } = connector;
          const [running] = await db.insert(runs).values({
            connectorId: id, runType: "permission", status: "running", startedAt: started, leaseEpoch: 7,
          }).returning();
          const [document] = await db.insert(documents).values({
            connectorId: id, organizationId: org, title: "ACL fixture", content: "fixture",
            contentHash: "fixture-hash", acl: ["org:*"],
          }).returning();
          const readRun = async () => (await db.select().from(runs).where(eq(runs.id, running.id)))[0];
          const pendingAudit = [];
          const update = async (fields, outcome) => {
            const response = await post(edit(id, fields));
            assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
            pendingAudit.push(outcome);
            const rows = await readAudit(id);
            assert.deepEqual(rows.map((row) => row.outcome), pendingAudit);
            const record = rows.at(-1);
            assert.equal(record.action, "connector.updated");
            assert.equal(record.actorId, owner);
            assert.equal(record.before?.secretId, undefined);
            assert.equal(record.after?.secretId, undefined);
            return response;
          };
          const initial = await readConnector(id);
          if (native) {
            assert.equal(await callRustApi({
              socketPath: socket, path: "/internal/v1/mcp/tools/update-knowledge-connector",
              json: JSON.stringify({ id, organizationId: org, environmentId: initial.environmentId,
                expected: { connectorType: "github", config: configPatch, visibility: initial.visibility,
                  teamIds: initial.teamIds, enabled: initial.enabled, syncPermissionsFromSource: initial.syncPermissionsFromSource },
                patch: { name: "Stale edit", clearCheckpoint: true },
              }),
            }), null);
            assert.deepEqual(await readConnector(id), initial);
          }
          const rejected = await update({ name: "Rejected connector edit", config: configPatch }, "failure");
          assert.deepEqual(await readConnector(id), initial);
          assert.deepEqual(await readRun(), running);
          assert.deepEqual(await readTasks(id), []);

          const changed = await update({ config: configPatch, description: null }, "success");
          const stored = await readConnector(id);
          assert.deepEqual(stored, {
            ...initial, config: configPatch, description: null, checkpoint: null,
            lastPermissionSyncStatus: "superseded", updatedAt: stored.updatedAt,
          });
          assert.deepEqual(changed.body.result.structuredContent.knowledgeConnector, {
            id, organizationId: org, name: initial.name, connectorType: "github", config: configPatch, description: null, enabled: true,
          });
          const stopped = await readRun();
          assert.equal(stopped.status, "superseded");
          assert.equal(stopped.leaseEpoch, 8);
          const pending = await readTasks(id);
          assert.deepEqual(pending.map(({ status, payload }) => ({ status, payload })),
            [{ status: "pending", payload: { connectorId: id } }]);
          const disabled = await update({ enabled: false, visibility: "team-scoped", team_ids: [ownTeam.id] }, "success");
          const final = await readConnector(id);
          assert.deepEqual(final, {
            ...stored, enabled: false, visibility: "team-scoped", teamIds: [ownTeam.id],
            syncPermissionsFromSource: false, updatedAt: final.updatedAt,
          });
          assert.deepEqual((await db.select().from(documents).where(eq(documents.id, document.id)))[0].acl, [`team:${ownTeam.id}`]);
          assert.deepEqual(await readTasks(id), pending);
          assert.deepEqual(await SecretModel.findById(secret.id), secret);
          outcomes.push([rejected, changed, disabled].map((response) => JSON.parse(JSON.stringify(response)
            .replaceAll(id, "connector-id").replaceAll(secret.id, "secret-id")
            .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "timestamp"))));
        }
      } finally {
        await db.execute(sql`ALTER TABLE knowledge_base_connectors DROP CONSTRAINT riir_reject_connector_update`);
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(connectorUpdateRequests, 3);
    });

    await t.test("create_knowledge_connector commits the initial policy atomically and audits once", async () => {
      const tool = "archestra__create_knowledge_connector";
      const createCall = (args) => ({ ...usageCall(tool), params: { name: tool, arguments: args } });
      const connectors = schema.knowledgeBaseConnectorsTable;
      const policies = schema.resourcePermissionPoliciesTable;
      const audit = schema.auditLogsTable;
      const configInput = { githubUrl: "https://github.fixture.invalid", owner: "fixture", repos: ["docs"] };
      const args = { name: "New connector fixture", connector_type: "github", description: "Creation fixture",
        config: configInput, sync_permissions_from_source: true,
        initialGrants: [{ subject: { type: "user", id: member }, actions: ["read"] }],
      };
      const readConnectors = (name) => db.select().from(connectors)
        .where(and(eq(connectors.organizationId, org), eq(connectors.name, name)));
      const readAudit = () => db.select().from(audit)
        .where(and(eq(audit.organizationId, org), eq(audit.httpPath, `mcp-tool:${tool}`))).orderBy(audit.eventSequence);
      const auditOutcomes = [];
      const create = async (input, outcome) => {
        const response = await post(createCall(input));
        assert.equal(response.body.result.isError, outcome === "failure", JSON.stringify(response.body));
        auditOutcomes.push(outcome);
        const records = await readAudit();
        assert.deepEqual(records.map(({ outcome }) => outcome), auditOutcomes);
        const record = records.at(-1);
        assert.equal(record.actorId, owner);
        assert.equal(record.action, "connector.created");
        assert.equal(record.before, null);
        return { response, record };
      };
      const invalidGrant = { ...args, initialGrants: [{ subject: { type: "user", id: randomUUID() }, actions: ["read"] }] };
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await create(invalidGrant, "failure");
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual((await create(invalidGrant, "failure")).response, denied.response);
      assert.deepEqual(await readConnectors(args.name), []);
      assert.equal(connectorCreateRequests, 0);

      const outcomes = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { response, record } = await create(args, "success");
        const publicRow = response.body.result.structuredContent.knowledgeConnector;
        const stored = (await readConnectors(args.name)).find(({ id }) => id === publicRow.id);
        assert.ok(stored);
        const expectedConfig = { type: "github", ...configInput };
        assert.deepEqual(publicRow, { id: stored.id, organizationId: org, name: args.name, description: args.description,
          connectorType: "github", config: expectedConfig, enabled: true });
        assert.equal(stored.environmentId, gateway.environmentId);
        assert.equal(stored.syncPermissionsFromSource, true);
        assert.equal(stored.secretId, null);
        assert.equal(stored.createdBy, owner);
        assert.deepEqual(stored.config, expectedConfig);
        assert.equal(stored.checkpoint, null);
        const [policy] = await db.select().from(policies).where(and(
          eq(policies.organizationId, org), eq(policies.resource, "knowledgeConnector"), eq(policies.scope, stored.id),
        ));
        assert.equal(policy.legacySharingMigrated, true);
        assert.equal(policy.legacyOrganizationAudience, false);
        assert.equal(policy.revision, 1);
        assert.equal(policy.grants.length, 2);
        assert.ok(policy.grants.some(({ subject, actions }) => subject.type === "user" && subject.id === owner && actions.includes("manage-permissions")));
        assert.deepEqual(policy.grants.find(({ subject }) => subject.type === "user" && subject.id === member)?.actions, ["read"]);
        assert.equal(record.resourceId, stored.id);
        assert.equal(record.after?.name, args.name);
        assert.equal(record.after?.secretId, undefined);
        const normalize = (value) => JSON.parse(JSON.stringify(value).replaceAll(stored.id, "connector-id")
          .replaceAll(stored.createdAt.toISOString(), "created").replaceAll(stored.updatedAt.toISOString(), "updated"));
        outcomes.push({ response: normalize(response), stored: normalize(stored), grants: policy.grants });
      }
      assert.deepEqual(outcomes[1], outcomes[0]);

      const rejected = { ...args, name: "Failed connector policy write" };
      await db.execute(sql`ALTER TABLE resource_permission_policies ADD CONSTRAINT riir_reject_connector_policy CHECK (resource <> 'knowledgeConnector') NOT VALID`);
      try {
        config.mcpGateway.rustDiscoverEnabled = false;
        const legacy = await create(rejected, "failure");
        config.mcpGateway.rustDiscoverEnabled = true;
        const native = await create(rejected, "failure");
        assert.deepEqual(native.response, legacy.response);
        assert.equal(native.record.resourceId, null);
        assert.equal(native.record.after, null);
        assert.deepEqual(await readConnectors(rejected.name), []);
      } finally {
        await db.execute(sql`ALTER TABLE resource_permission_policies DROP CONSTRAINT riir_reject_connector_policy`);
      }
      assert.equal(connectorCreateRequests, 2);
    });

    await t.test("assign_knowledge_connector_to_knowledge_base preserves links, scope and single-write audit", async () => {
      const name = "archestra__assign_knowledge_connector_to_knowledge_base";
      const assignCall = (connectorId, knowledgeBaseId) => ({
        ...usageCall(name), params: { name, arguments: { connector_id: connectorId, knowledge_base_id: knowledgeBaseId } },
      });
      const links = schema.knowledgeBaseConnectorAssignmentsTable;
      const audit = schema.auditLogsTable;
      const readLinks = (connectorId, knowledgeBaseId) => db.select().from(links).where(and(
        eq(links.connectorId, connectorId), eq(links.knowledgeBaseId, knowledgeBaseId),
      ));
      const readAudit = (connectorId) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, connectorId), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const foreign = await KnowledgeBaseModel.create({ organizationId: otherOrg, name: "Foreign assignment fixture" });
      const deniedRequest = assignCall(ownConnector.id, foreign.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deniedRequest);
      assert.equal(denied.body.result.isError, true);
      assert.deepEqual((await readAudit(ownConnector.id)).map(({ outcome }) => outcome), ["failure"]);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deniedRequest), denied);
      assert.deepEqual((await readAudit(ownConnector.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(connectorAssignRequests, 0);

      const deletedBase = await KnowledgeBaseModel.create({ organizationId: org, name: "Deleted assignment fixture", createdBy: owner });
      assert.equal(await KnowledgeBaseModel.delete(deletedBase.id), true);
      for (const base of [foreign, deletedBase]) {
        assert.equal(await callRustApi({
          socketPath: socket, path: "/internal/v1/mcp/tools/assign-connector-to-knowledge-base",
          json: JSON.stringify({ organizationId: org, connectorId: ownConnector.id, knowledgeBaseId: base.id }),
        }), false);
        assert.deepEqual(await readLinks(ownConnector.id, base.id), []);
      }

      const outcomes = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const connector = await createConnector(owner);
        const base = await KnowledgeBaseModel.create({ organizationId: org, name: "Connector assignment fixture", createdBy: owner });
        const responses = [];
        for (const count of [1, 2]) {
          const response = await post(assignCall(connector.id, base.id));
          assert.equal(response.body.result.isError, false, JSON.stringify(response.body));
          const rows = await readLinks(connector.id, base.id);
          assert.equal(rows.length, count);
          for (const link of rows) assert.ok(link.createdAt instanceof Date);
          const records = await readAudit(connector.id);
          assert.equal(records.length, count);
          const record = records.at(-1);
          assert.equal(record.action, "connector.updated");
          assert.equal(record.outcome, "success");
          assert.equal(record.actorId, owner);
          assert.equal(record.before?.knowledgeBases.length, count - 1);
          assert.deepEqual(record.after?.knowledgeBases, Array(count).fill(`${base.name} (${base.id})`));
          responses.push(JSON.parse(JSON.stringify(response)
            .replaceAll(connector.id, "connector-id").replaceAll(base.id, "base-id")));
        }
        outcomes.push(responses);
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(connectorAssignRequests, 2);
    });

    await t.test("unassign_knowledge_connector_from_knowledge_base removes matching links and audits once", async () => {
      const name = "archestra__unassign_knowledge_connector_from_knowledge_base";
      const unassignCall = (connectorId, knowledgeBaseId) => ({
        ...usageCall(name), params: { name, arguments: { connector_id: connectorId, knowledge_base_id: knowledgeBaseId } },
      });
      const links = schema.knowledgeBaseConnectorAssignmentsTable;
      const audit = schema.auditLogsTable;
      const readLinks = (connectorId, knowledgeBaseId) => db.select().from(links).where(and(
        eq(links.connectorId, connectorId), eq(links.knowledgeBaseId, knowledgeBaseId),
      ));
      const readAudit = (connectorId) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, connectorId), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const foreignBase = await KnowledgeBaseModel.create({ organizationId: otherOrg, name: "Foreign unassign fixture" });
      const foreignConnector = await KnowledgeBaseConnectorModel.create({
        organizationId: otherOrg, name: "Foreign unassign fixture", connectorType: "jira", config: ownConnector.config,
      });
      const [foreignLink] = await db.insert(links).values({
        connectorId: foreignConnector.id, knowledgeBaseId: foreignBase.id,
      }).returning();
      const deniedRequest = unassignCall(foreignConnector.id, foreignBase.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deniedRequest);
      assert.equal(denied.body.result.isError, true);
      assert.deepEqual((await readAudit(foreignConnector.id)).map(({ outcome }) => outcome), ["failure"]);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deniedRequest), denied);
      assert.deepEqual((await readAudit(foreignConnector.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(connectorUnassignRequests, 0);
      const tryNativeUnassign = (connectorId, knowledgeBaseId) => callRustApi({
        socketPath: socket, path: "/internal/v1/mcp/tools/unassign-connector-from-knowledge-base",
        json: JSON.stringify({ organizationId: org, connectorId, knowledgeBaseId }),
      });
      assert.equal(await tryNativeUnassign(foreignConnector.id, foreignBase.id), false);
      assert.deepEqual(await readLinks(foreignConnector.id, foreignBase.id), [foreignLink]);
      assert.equal((await post(knowledgeCall(hiddenKb.id))).body.result.isError, true);

      const outcomes = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const connector = await createConnector(owner);
        const id = connector.id;
        await db.insert(links).values([hiddenKb.id, hiddenKb.id, ownKb.id].map((knowledgeBaseId) => ({
          knowledgeBaseId, connectorId: id,
        })));
        assert.equal((await readLinks(id, hiddenKb.id)).length, 2);
        const retained = await readLinks(id, ownKb.id);
        assert.equal(retained.length, 1);
        const request = unassignCall(id, hiddenKb.id);
        const removed = await post(request);
        assert.equal(removed.body.result.isError, false, JSON.stringify(removed.body));
        assert.deepEqual(await readLinks(id, hiddenKb.id), []);
        assert.deepEqual(await readLinks(id, ownKb.id), retained);
        const records = await readAudit(id);
        assert.equal(records.length, 1);
        const [record] = records;
        assert.equal(record.action, "connector.updated");
        assert.equal(record.actorId, owner);
        assert.equal(record.outcome, "success");
        assert.equal(record.before?.knowledgeBases.length, 3);
        assert.deepEqual(record.after?.knowledgeBases, [`${ownKb.name} (${ownKb.id})`]);
        const missing = await post(request);
        assert.equal(missing.body.result.isError, true);
        assert.deepEqual((await readAudit(id)).map(({ outcome }) => outcome), ["success", "failure"]);
        outcomes.push([removed, missing].map((response) => JSON.parse(JSON.stringify(response).replaceAll(id, "connector-id"))));
      }
      assert.deepEqual(outcomes[1], outcomes[0]);
      assert.equal(connectorUnassignRequests, 1);
    });

    await t.test("assign_knowledge_base_to_agent preserves scope, cache, versions and single-write audit", async () => {
      const name = "archestra__assign_knowledge_base_to_agent";
      const path = "/internal/v1/mcp/tools/assign-knowledge-base-to-agent";
      const request = (agentId, knowledgeBaseId) => ({
        ...usageCall(name), params: { name, arguments: { agent_id: agentId, knowledge_base_id: knowledgeBaseId } },
      });
      const links = schema.agentKnowledgeBasesTable;
      const audit = schema.auditLogsTable;
      const readLinks = (agentId) => db.select().from(links).where(eq(links.agentId, agentId));
      const readAudit = (agentId) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, agentId), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const makeAgent = () => AgentModel.create({
        organizationId: org, agentType: "agent", name: "Knowledge assignment fixture",
      }, owner, { skipCreationDefaultTools: true });
      const deletedAgent = await makeAgent();
      await db.update(schema.agentsTable).set({ deletedAt: new Date() }).where(eq(schema.agentsTable.id, deletedAgent.id));
      for (const agentId of [otherOrgAgent.id, deletedAgent.id]) {
        const deniedRequest = request(agentId, ownKb.id);
        config.mcpGateway.rustDiscoverEnabled = false;
        const denied = await post(deniedRequest);
        assert.equal(denied.body.result.isError, true);
        config.mcpGateway.rustDiscoverEnabled = true;
        assert.deepEqual(await post(deniedRequest), denied);
        assert.deepEqual((await readAudit(agentId)).map(({ outcome }) => outcome), ["failure", "failure"]);
        assert.equal(await callRustApi({
          socketPath: socket, path, json: JSON.stringify({ organizationId: org, agentId, knowledgeBaseId: ownKb.id }),
        }), false);
        assert.deepEqual(await readLinks(agentId), []);
      }
      assert.equal(agentKnowledgeAssignRequests, 0);

      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { id } = await makeAgent();
        const versions = await gatewayVersions(id);
        agentKnowledgeSourcesCache.set(id, false);
        const denied = await post(request(id, hiddenKb.id));
        let rejected;
        await db.execute(sql`ALTER TABLE agent_knowledge_base ADD CONSTRAINT riir_reject_agent_kb CHECK (false) NOT VALID`);
        try {
          rejected = await post(request(id, ownKb.id));
        } finally {
          await db.execute(sql`ALTER TABLE agent_knowledge_base DROP CONSTRAINT riir_reject_agent_kb`);
        }
        assert.equal(denied.body.result.isError, true);
        assert.equal(rejected.body.result.isError, true);
        assert.deepEqual(await readLinks(id), []);
        assert.deepEqual(await gatewayVersions(id), versions);
        assert.equal(agentKnowledgeSourcesCache.get(id), false);

        const added = await post(request(id, ownKb.id));
        assert.equal(added.body.result.isError, false, JSON.stringify(added.body));
        assert.equal(agentKnowledgeSourcesCache.get(id), undefined);
        const [link, ...extra] = await readLinks(id);
        assert.deepEqual(extra, []);
        assert.ok(link?.createdAt instanceof Date);
        assert.deepEqual(link, { agentId: id, knowledgeBaseId: ownKb.id, createdAt: link.createdAt });
        const after = await gatewayVersions(id);
        assert.equal(after.length, versions.length + 1);
        assert.deepEqual(after.at(-1).snapshot.knowledgeBases, [{ id: ownKb.id, name: ownKb.name }]);

        agentKnowledgeSourcesCache.set(id, true);
        assert.deepEqual(await post(request(id, ownKb.id)), added);
        assert.equal(agentKnowledgeSourcesCache.get(id), undefined);
        assert.deepEqual(await readLinks(id), [link]);
        assert.deepEqual(await gatewayVersions(id), after);
        const records = await readAudit(id);
        assert.deepEqual(records.map(({ outcome }) => outcome), ["failure", "failure", "success", "success"]);
        for (const record of records) {
          assert.equal(record.action, "agent.updated");
          assert.equal(record.actorId, owner);
        }
        assert.deepEqual(records[2].before?.knowledgeBaseIds, []);
        assert.deepEqual(records[2].after?.knowledgeBaseIds, [ownKb.id]);
        assert.deepEqual(records[3].before, records[3].after);
        responses.push([denied, rejected, added].map((value) => JSON.parse(JSON.stringify(value).replaceAll(id, "agent-id"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(agentKnowledgeAssignRequests, 3);
    });

    await t.test("unassign_knowledge_base_from_agent preserves scope, sibling links, versions and single-write audit", async () => {
      const name = "archestra__unassign_knowledge_base_from_agent";
      const request = (agentId, knowledgeBaseId) => ({
        ...usageCall(name), params: { name, arguments: { agent_id: agentId, knowledge_base_id: knowledgeBaseId } },
      });
      const links = schema.agentKnowledgeBasesTable;
      const audit = schema.auditLogsTable;
      const readLinks = (agentId) => db.select().from(links).where(eq(links.agentId, agentId));
      const readAudit = (agentId) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, agentId), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const removeNative = (agentId, knowledgeBaseId) => callRustApi({
        socketPath: socket, path: "/internal/v1/mcp/tools/unassign-knowledge-base-from-agent",
        json: JSON.stringify({ organizationId: org, agentId, knowledgeBaseId }),
      });
      const [foreignLink] = await db.insert(links).values({
        agentId: otherOrgAgent.id, knowledgeBaseId: ownKb.id,
      }).returning();
      const deniedRequest = request(otherOrgAgent.id, ownKb.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deniedRequest);
      assert.equal(denied.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deniedRequest), denied);
      assert.deepEqual((await readAudit(otherOrgAgent.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(await removeNative(otherOrgAgent.id, ownKb.id), null);
      assert.deepEqual(await readLinks(otherOrgAgent.id), [foreignLink]);
      assert.equal(agentKnowledgeUnassignRequests, 0);

      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { id } = await AgentModel.create({
          organizationId: org, agentType: "agent", name: "Knowledge unassignment fixture",
        }, owner, { skipCreationDefaultTools: true });
        for (const kb of [ownKb, hiddenKb]) {
          assert.equal(await AgentKnowledgeBaseModel.assign(id, kb.id), true);
        }
        const before = await readLinks(id);
        assert.equal(before.length, 2);
        const sibling = before.filter(({ knowledgeBaseId }) => knowledgeBaseId === hiddenKb.id);
        const versions = await gatewayVersions(id);
        agentKnowledgeSourcesCache.set(id, true);
        const inaccessible = await post(request(id, hiddenKb.id));
        assert.equal(inaccessible.body.result.isError, true);
        assert.deepEqual(await readLinks(id), before);
        assert.equal(agentKnowledgeSourcesCache.get(id), true);

        const removed = await post(request(id, ownKb.id));
        assert.equal(removed.body.result.isError, false, JSON.stringify(removed.body));
        assert.deepEqual(await readLinks(id), sibling);
        assert.equal(agentKnowledgeSourcesCache.get(id), undefined);
        const after = await gatewayVersions(id);
        assert.equal(after.length, versions.length + 1);
        assert.deepEqual(after.at(-1).snapshot.knowledgeBases, [{ id: hiddenKb.id, name: hiddenKb.name }]);

        const missing = await post(request(id, ownKb.id));
        assert.equal(missing.body.result.isError, true);
        assert.deepEqual(await readLinks(id), sibling);
        assert.deepEqual(await gatewayVersions(id), after);
        const records = await readAudit(id);
        assert.deepEqual(records.map(({ action, actorId, outcome }) => ({ action, actorId, outcome })),
          ["failure", "success", "failure"].map((outcome) => ({ action: "agent.updated", actorId: owner, outcome })));
        assert.deepEqual(records[1].before?.knowledgeBaseIds, [ownKb.id, hiddenKb.id].sort());
        assert.deepEqual(records[1].after?.knowledgeBaseIds, [hiddenKb.id]);
        if (native) assert.equal(await removeNative(id, ownKb.id), false);
        responses.push([inaccessible, removed, missing].map((value) => JSON.parse(JSON.stringify(value).replaceAll(id, "agent-id"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(agentKnowledgeUnassignRequests, 1);
    });

    await t.test("assign_knowledge_connector_to_agent preserves environment, link, versions and single-write audit", async () => {
      const name = "archestra__assign_knowledge_connector_to_agent";
      const request = (agentId, connectorId) => ({
        ...usageCall(name), params: { name, arguments: { agent_id: agentId, connector_id: connectorId } },
      });
      const links = schema.agentConnectorAssignmentsTable;
      const audit = schema.auditLogsTable;
      const readLinks = (agentId) => db.select().from(links).where(eq(links.agentId, agentId));
      const readAudit = (agentId) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, agentId), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const assignNative = (agentId, connectorId, environmentId) => callRustApi({
        socketPath: socket, path: "/internal/v1/mcp/tools/assign-connector-to-agent",
        json: JSON.stringify({ organizationId: org, agentId, connectorId, environmentId }),
      });
      const foreignRequest = request(otherOrgAgent.id, ownConnector.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(foreignRequest);
      assert.equal(denied.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(foreignRequest), denied);
      assert.deepEqual((await readAudit(otherOrgAgent.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(await assignNative(otherOrgAgent.id, ownConnector.id, null), false);
      assert.deepEqual(await readLinks(otherOrgAgent.id), []);
      assert.equal(agentConnectorAssignRequests, 0);

      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { id } = await AgentModel.create({
          organizationId: org, agentType: "agent", name: "Direct connector assignment fixture",
          environmentId: otherEnvironment.id,
        }, owner, { skipCreationDefaultTools: true });
        const before = await gatewayVersions(id);
        agentKnowledgeSourcesCache.set(id, false);
        const forbidden = await post(request(id, hiddenConnector.id));
        const mismatched = await post(request(id, ownConnector.id));
        assert.equal(forbidden.body.result.isError, true);
        assert.equal(mismatched.body.result.isError, true);
        assert.notDeepEqual(forbidden, mismatched);
        if (native) assert.equal(await assignNative(id, otherConnector.id, null), false);
        assert.deepEqual(await readLinks(id), []);
        assert.deepEqual(await gatewayVersions(id), before);
        assert.equal(agentKnowledgeSourcesCache.get(id), false);

        const added = await post(request(id, otherConnector.id));
        assert.equal(added.body.result.isError, false, JSON.stringify(added.body));
        assert.equal(agentKnowledgeSourcesCache.get(id), undefined);
        const [link, ...extra] = await readLinks(id);
        assert.deepEqual(extra, []);
        assert.ok(link?.createdAt instanceof Date);
        assert.deepEqual(link, { agentId: id, connectorId: otherConnector.id, createdAt: link.createdAt });
        const after = await gatewayVersions(id);
        assert.equal(after.length, before.length + 1);
        assert.deepEqual(after.at(-1).snapshot.connectors, [{ id: otherConnector.id, name: otherConnector.name }]);
        assert.deepEqual(await post(request(id, otherConnector.id)), added);
        assert.deepEqual(await readLinks(id), [link]);
        assert.deepEqual(await gatewayVersions(id), after);
        const records = await readAudit(id);
        assert.deepEqual(records.map(({ action, actorId, outcome }) => ({ action, actorId, outcome })),
          ["failure", "failure", "success", "success"].map((outcome) => ({ action: "agent.updated", actorId: owner, outcome })));
        assert.deepEqual(records[2].before?.connectorIds, []);
        assert.deepEqual(records[2].after?.connectorIds, [otherConnector.id]);
        assert.deepEqual(records[3].before, records[3].after);
        responses.push([forbidden, mismatched, added].map((value) => JSON.parse(JSON.stringify(value).replaceAll(id, "agent-id"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(agentConnectorAssignRequests, 2);
    });

    await t.test("unassign_knowledge_connector_from_agent cleans up stale environment links and audits once", async () => {
      const name = "archestra__unassign_knowledge_connector_from_agent";
      const request = (agentId, connectorId) => ({
        ...usageCall(name), params: { name, arguments: { agent_id: agentId, connector_id: connectorId } },
      });
      const links = schema.agentConnectorAssignmentsTable;
      const audit = schema.auditLogsTable;
      const readLinks = (agentId) => db.select().from(links).where(eq(links.agentId, agentId));
      const readAudit = (agentId) => db.select().from(audit).where(and(
        eq(audit.organizationId, org), eq(audit.resourceId, agentId), eq(audit.httpPath, `mcp-tool:${name}`),
      )).orderBy(audit.eventSequence);
      const removeNative = (agentId, connectorId) => callRustApi({
        socketPath: socket, path: "/internal/v1/mcp/tools/unassign-connector-from-agent",
        json: JSON.stringify({ organizationId: org, agentId, connectorId }),
      });
      const [foreignLink] = await db.insert(links).values({
        agentId: otherOrgAgent.id, connectorId: ownConnector.id,
      }).returning();
      const deniedRequest = request(otherOrgAgent.id, ownConnector.id);
      config.mcpGateway.rustDiscoverEnabled = false;
      const denied = await post(deniedRequest);
      assert.equal(denied.body.result.isError, true);
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(deniedRequest), denied);
      assert.deepEqual((await readAudit(otherOrgAgent.id)).map(({ outcome }) => outcome), ["failure", "failure"]);
      assert.equal(await removeNative(otherOrgAgent.id, ownConnector.id), null);
      assert.deepEqual(await readLinks(otherOrgAgent.id), [foreignLink]);

      const responses = [];
      for (const native of [false, true]) {
        config.mcpGateway.rustDiscoverEnabled = native;
        const { id, environmentId } = await AgentModel.create({
          organizationId: org, agentType: "agent", name: "Direct connector removal fixture",
        }, owner, { skipCreationDefaultTools: true });
        assert.notEqual(environmentId, otherConnector.environmentId);
        for (const connector of [otherConnector, hiddenConnector]) {
          assert.equal(await AgentConnectorAssignmentModel.assign(id, connector.id), true);
        }
        const linksBefore = await readLinks(id);
        assert.equal(linksBefore.length, 2);
        const [sibling] = linksBefore.filter(({ connectorId }) => connectorId === hiddenConnector.id);
        const versions = await gatewayVersions(id);
        agentKnowledgeSourcesCache.set(id, true);
        const forbidden = await post(request(id, hiddenConnector.id));
        assert.equal(forbidden.body.result.isError, true);
        assert.deepEqual(await readLinks(id), linksBefore);
        assert.equal(agentKnowledgeSourcesCache.get(id), true);

        const removed = await post(request(id, otherConnector.id));
        assert.equal(removed.body.result.isError, false, JSON.stringify(removed.body));
        assert.deepEqual(await readLinks(id), [sibling]);
        assert.equal(agentKnowledgeSourcesCache.get(id), undefined);
        const after = await gatewayVersions(id);
        assert.equal(after.length, versions.length + 1);
        assert.deepEqual(after.at(-1).snapshot.connectors, [{ id: hiddenConnector.id, name: hiddenConnector.name }]);
        const missing = await post(request(id, otherConnector.id));
        assert.equal(missing.body.result.isError, true);
        assert.deepEqual(await readLinks(id), [sibling]);
        assert.deepEqual(await gatewayVersions(id), after);
        const records = await readAudit(id);
        assert.deepEqual(records.map(({ action, actorId, outcome }) => ({ action, actorId, outcome })),
          ["failure", "success", "failure"].map((outcome) => ({ action: "agent.updated", actorId: owner, outcome })));
        assert.deepEqual(records[1].before?.connectorIds, [otherConnector.id, hiddenConnector.id].sort());
        assert.deepEqual(records[1].after?.connectorIds, [hiddenConnector.id]);
        if (native) assert.equal(await removeNative(id, otherConnector.id), false);
        responses.push([forbidden, removed, missing].map((value) => JSON.parse(JSON.stringify(value).replaceAll(id, "agent-id"))));
      }
      assert.deepEqual(responses[0], responses[1]);
      assert.equal(agentConnectorUnassignRequests, 1);
    });

    const proxy = await AgentModel.getOrgLlmProxy(org);
    await db.insert(schema.interactionsTable).values([
      { profileId: gateway.id, inputTokens: 1234, outputTokens: 10 },
      { profileId: gateway.id, inputTokens: null, outputTokens: 56 },
      { profileId: unassignedGateway.id, inputTokens: 99, outputTokens: 99 },
      { profileId: proxy.id, inputTokens: 500, outputTokens: 75 },
    ].map((row) => ({ ...row, type: "openai:chatCompletions", request: {}, response: {} })));
    for (const [name, id, input, output] of [
      [agentUsage, gateway.id, 1234, 66],
      [proxyUsage, proxy.id, 500, 75],
    ]) {
      const beforeRequests = usageRequests;
      config.mcpGateway.rustDiscoverEnabled = false;
      const legacyUsage = await post(usageCall(name));
      assert.deepEqual(legacyUsage.body.result.structuredContent, {
        id, totalInputTokens: input, totalOutputTokens: output, totalTokens: input + output,
      });
      config.mcpGateway.rustDiscoverEnabled = true;
      assert.deepEqual(await post(usageCall(name)), legacyUsage);
      assert.equal(usageRequests, beforeRequests + 1);

      const beforeUsageCancel = await McpToolCallModel.getAllMcpToolCallsForAgent(gateway.id);
      holdToolReply = { received: Promise.withResolvers(), closed: Promise.withResolvers() };
      const stopUsage = new AbortController();
      const usageCancelled = assert.rejects(call(stopUsage, "riir-usage-cancel", name), { name: "AbortError" });
      try {
        await Promise.race([holdToolReply.received.promise, delay(4_000).then(() => assert.fail("native usage did not respond"))]);
      } finally {
        stopUsage.abort();
        await usageCancelled;
      }
      await Promise.race([holdToolReply.closed.promise, delay(4_000).then(() => assert.fail("usage relay was not cancelled"))]);
      assert.equal((await singleAuditSince(beforeUsageCancel)).toolResult.isError, true);
      assert.equal(usageRequests, beforeRequests + 2);
      holdToolReply = undefined;
    }

    async function listen(stop) {
      const response = await fetch(`${address}/v1/mcp/${gateway.slug}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${allowed}`, accept: "application/json, text/event-stream",
          "content-type": "application/json", "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", method: "subscriptions/listen", id: "riir-listen",
          params: { notifications: { toolsListChanged: true, resourcesListChanged: true } },
        }),
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(28_000)]),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      return { async next() {
        for (;;) {
          const end = pending.indexOf("\n\n");
          if (end !== -1) {
            const event = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const data = event.split("\n").find((line) => line.startsWith("data: "));
            if (data) return JSON.parse(data.slice(6));
            continue;
          }
          const { done, value } = await reader.read();
          if (done) return null;
          pending += value;
        }
      } };
    }
  } finally {
    config.hooks.enabled = hooksWereEnabled;
    if (remote) {
      remote.closeAllConnections();
      await new Promise((resolve) => remote.close(resolve));
    }
    const appClosed = app.close();
    app.server.closeAllConnections();
    if (relay) {
      relay.closeAllConnections();
      await new Promise((resolve) => relay.close(resolve));
    }
    if (child) {
      child.kill("SIGTERM");
      const forceExit = setTimeout(() => child.kill("SIGKILL"), 3_000);
      try {
        await childExit;
      } finally {
        clearTimeout(forceExit);
      }
    }
    await appClosed;
    cacheManager.shutdown();
    await rmdir(scratch);
  }
});
