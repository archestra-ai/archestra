import { randomUUID } from "node:crypto";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import AgentWorkspaceModel from "@/models/agent-workspace";
import MemberModel from "@/models/member";
import OrganizationModel from "@/models/organization";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import ToolModel from "@/models/tool";
import UserTokenModel from "@/models/user-token";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import mcpGatewayRoutes from "@/routes/mcp-gateway";
import { authenticateMCPGatewayRequest } from "@/routes/mcp-gateway/utils";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { issueRuntimeGatewayCredential } from "./runtime-gateway-credential";
import { stampRuntimeBinding } from "./runtime-identity";

const deviceConfig = {
  protocolVersion: 1 as const,
  version: "1.0.0",
  platforms: {
    darwin: { command: "node", args: ["server.mjs"] },
    win32: { command: "node.exe", args: ["C:/server.mjs"] },
  },
  tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
};

describe("scoped personal runtime gateway credentials", () => {
  const ctx = useRouteTestApp(mcpGatewayRoutes);
  let agent: { id: string; name: string };
  let toolName: string;
  let rawToken: string;
  let taskId: string;
  let runId: string;
  let claims: Parameters<typeof issueRuntimeGatewayCredential>[0];

  beforeEach(
    async ({
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeAgentTool,
    }) => {
      config.openappa.offerSigningSecret =
        "test-runtime-gateway-credential-secret";
      await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
      await OrganizationModel.patch(ctx.organizationId, {
        deviceMcpEnabled: true,
      });
      agent = await makeAgent({ organizationId: ctx.organizationId });
      const catalog = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        serverType: "device",
        deviceConfig,
      });
      const [tool] = await ToolModel.findByCatalogId(catalog.id, {
        kind: "caller",
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
      });
      toolName = tool.name;
      await makeAgentTool(agent.id, tool.id, {
        credentialResolutionMode: "dynamic",
      });
      rawToken = (await UserTokenModel.create(ctx.user.id, ctx.organizationId))
        .value;
      const context = await A2AContextModel.create({
        actorKind: "user",
        actorId: ctx.user.id,
      });
      const task = await A2ATaskModel.create({
        contextId: context.id,
        agentId: agent.id,
        state: "TASK_STATE_WORKING",
      });
      taskId = task.id;
      const workloadName = `workspace-${task.id}`;
      const workspace = await AgentWorkspaceModel.create({
        organizationId: ctx.organizationId,
        agentId: agent.id,
        actorKind: "user",
        actorId: ctx.user.id,
        backend: "kubernetes",
        runtimeScope: "test",
        workloadName,
        state: "active",
        activeTaskId: task.id,
        lastTaskId: task.id,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const run = await AgentRunModel.create({
        organizationId: ctx.organizationId,
        taskId: task.id,
        agentId: agent.id,
        actorKind: "user",
        actorId: ctx.user.id,
        actorUserId: ctx.user.id,
        workloadName,
        backend: "kubernetes",
        runtimeScope: "test",
      });
      runId = run.id;
      claims = {
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        agentId: agent.id,
        workspaceId: workspace.id,
        taskId: task.id,
        expiresAt: Date.now() + 60_000,
      };
    },
  );

  const call = (token: string, headers: Record<string, string> = {}) =>
    ctx.app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...headers,
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: {} },
      },
    });

  test("replaces the exported personal bearer only after opt-in and authenticates interactive calls without headers", async () => {
    const spec = {
      env: { ARCHESTRA_MCP_GATEWAY_TOKEN: rawToken } as Record<string, string>,
      secretEnv: { ARCHESTRA_MCP_GATEWAY_TOKEN: rawToken },
      activeDeadlineSeconds: 60,
    };
    await stampRuntimeBinding({
      spec,
      organizationId: ctx.organizationId,
      workspaceId: claims.workspaceId,
      taskId,
    });
    const token = spec.secretEnv.ARCHESTRA_MCP_GATEWAY_TOKEN;
    expect(token).toMatch(/^rtg1\./);
    expect(JSON.stringify(spec)).not.toContain(rawToken);
    const response = await call(token);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().result._meta.archestraError).toMatchObject({
      action: "connect_device",
    });
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: false,
    });
    const disabledSpec = {
      env: {} as Record<string, string>,
      secretEnv: { ARCHESTRA_MCP_GATEWAY_TOKEN: rawToken },
      activeDeadlineSeconds: 60,
    };
    await stampRuntimeBinding({
      spec: disabledSpec,
      organizationId: ctx.organizationId,
      workspaceId: claims.workspaceId,
      taskId,
    });
    expect(disabledSpec.secretEnv.ARCHESTRA_MCP_GATEWAY_TOKEN).toBe(rawToken);
  });

  test("derives scheduled identity even when the process omits the run header and rejects spoofed task headers", async ({
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const trigger = await makeScheduleTrigger({
      organizationId: ctx.organizationId,
      actorUserId: ctx.user.id,
      agentId: agent.id,
    });
    const scheduled = await makeScheduleTriggerRun(trigger.id);
    await ScheduleTriggerRunModel.setRuntimeTaskId({
      runId: scheduled.id,
      taskId,
    });
    const spec = {
      env: {} as Record<string, string>,
      secretEnv: { ARCHESTRA_MCP_GATEWAY_TOKEN: rawToken },
      activeDeadlineSeconds: 60,
    };
    await stampRuntimeBinding({
      spec,
      organizationId: ctx.organizationId,
      workspaceId: claims.workspaceId,
      taskId,
    });
    const token = spec.secretEnv.ARCHESTRA_MCP_GATEWAY_TOKEN;
    const response = await call(token);
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.stringify(response.json().result)).toContain("scheduled tasks");
    await ScheduleTriggerModel.delete(trigger.id);
    const afterDelete = await call(token);
    expect(afterDelete.statusCode, afterDelete.body).toBe(200);
    expect(JSON.stringify(afterDelete.json().result)).toContain(
      "scheduled tasks",
    );
    const spoof = await call(token, { "X-Archestra-Run-Id": randomUUID() });
    expect(spoof.statusCode, spoof.body).toBe(403);
  });

  test("reports attention for its own task but cannot mutate a sibling run through runtime-status", async () => {
    const token = issueRuntimeGatewayCredential(claims);
    const report = (targetTaskId: string, bearer = token) =>
      ctx.app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}/runtime-status`,
        headers: { authorization: `Bearer ${bearer}` },
        payload: { taskId: targetTaskId, attentionState: "input_required" },
      });
    const own = await report(taskId);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({ updated: true });
    expect((await AgentRunModel.findByTaskId(taskId))?.attentionState).toBe(
      "input_required",
    );
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: ctx.user.id,
    });
    const siblingTask = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    await AgentRunModel.create({
      organizationId: ctx.organizationId,
      taskId: siblingTask.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: ctx.user.id,
      actorUserId: ctx.user.id,
      workloadName: `sibling-${siblingTask.id}`,
      backend: "kubernetes",
      runtimeScope: "test",
    });
    const denied = await report(siblingTask.id);
    expect(denied.statusCode, denied.body).toBe(404);
    expect(
      (await AgentRunModel.findByTaskId(siblingTask.id))?.attentionState,
    ).toBeNull();
    const personal = await report(siblingTask.id, rawToken);
    expect(personal.statusCode, personal.body).toBe(200);
  });

  test("refuses wrong agent, tenant, expiry, tampering, ended runs and non-MCP scopes", async ({
    makeAgent,
  }) => {
    const token = issueRuntimeGatewayCredential(claims);
    const other = await makeAgent({ organizationId: ctx.organizationId });
    expect(
      (await authenticateMCPGatewayRequest(other.id, token)).result,
    ).toBeNull();
    expect(
      (
        await authenticateMCPGatewayRequest(
          agent.id,
          issueRuntimeGatewayCredential({
            ...claims,
            organizationId: "other-org",
          }),
        )
      ).result,
    ).toBeNull();
    expect(
      (
        await authenticateMCPGatewayRequest(
          agent.id,
          issueRuntimeGatewayCredential({
            ...claims,
            expiresAt: Date.now() - 1,
          }),
        )
      ).result,
    ).toBeNull();
    expect(
      (await authenticateMCPGatewayRequest(agent.id, `${token}tamper`)).result,
    ).toBeNull();
    expect(
      (await authenticateMCPGatewayRequest(agent.id, token, undefined, "a2a"))
        .result,
    ).toBeNull();
    expect(await UserTokenModel.validateToken(token)).toBeNull();
    expect(await VirtualApiKeyModel.validateToken(token)).toBeNull();
    expect(
      (await authenticateMCPGatewayRequest(agent.id, token)).result?.userId,
    ).toBe(ctx.user.id);
    await AgentRunModel.close({ id: runId });
    expect(
      (await authenticateMCPGatewayRequest(agent.id, token)).result,
    ).toBeNull();
  });

  test("revokes the bearer when its task completes before run cleanup or its membership is removed", async () => {
    const token = issueRuntimeGatewayCredential(claims);
    expect(
      (await authenticateMCPGatewayRequest(agent.id, token)).result,
    ).not.toBeNull();
    await A2ATaskModel.transitionStateWithEvent({
      id: taskId,
      to: "TASK_STATE_COMPLETED",
      allowedFrom: ["TASK_STATE_WORKING"],
      eventPayload: {
        statusUpdate: {
          taskId,
          contextId: "test",
          status: { state: "TASK_STATE_COMPLETED" },
          final: true,
        },
      },
    });
    expect((await AgentRunModel.findByTaskId(taskId))?.endedAt).toBeNull();
    expect(
      (await authenticateMCPGatewayRequest(agent.id, token)).result,
    ).toBeNull();
  });

  test("checks membership on every request instead of caching a successful runtime authorization", async () => {
    const token = issueRuntimeGatewayCredential(claims);
    expect(
      (await authenticateMCPGatewayRequest(agent.id, token)).result,
    ).not.toBeNull();
    await MemberModel.deleteByMemberOrUserId(ctx.user.id, ctx.organizationId);
    expect(
      (await authenticateMCPGatewayRequest(agent.id, token)).result,
    ).toBeNull();
  });

  test("refuses scheduled platform builtins and both delegation families before provenance can be lost", async () => {
    const context = {
      agent,
      agentId: agent.id,
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      tokenAuth: {
        tokenId: randomUUID(),
        teamId: null,
        isOrganizationToken: false,
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        isBackgroundExecution: true,
      },
    };
    for (const name of [
      "archestra__start_agent_run",
      "agent__delegate",
      "skill__delegate",
    ]) {
      const result = await executeArchestraTool(name, {}, context);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "unavailable to scheduled tasks",
      );
    }
    // With the capability off, dispatch reaches the ordinary tool lookup again.
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: false,
    });
    const normal = await executeArchestraTool("agent__missing", {}, context);
    expect(JSON.stringify(normal)).not.toContain(
      "unavailable to scheduled tasks",
    );
  });
});
