import { randomUUID } from "node:crypto";
import OrganizationModel from "@/models/organization";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import ToolModel from "@/models/tool";
import { validateAssignment } from "@/services/agent-tool-assignment";
import { describe, expect, test } from "@/test";
import { agentOwner } from "@/types/tool-owner";
import mcpClient from "./mcp-client";

const deviceConfig = {
  protocolVersion: 1 as const,
  version: "1.0.0",
  platforms: {
    darwin: { command: "node", args: ["server.mjs"] },
    win32: { command: "node.exe", args: ["C:/server.mjs"] },
  },
  tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
};

describe("personal device tool identity", () => {
  test("refuses static and enterprise assignments while admitting call-time personal resolution", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "device",
      deviceConfig,
    });
    const [tool] = await ToolModel.findByCatalogId(catalog.id, {
      kind: "caller",
      userId: user.id,
      organizationId: org.id,
    });
    for (const mode of ["static", "enterprise_managed"] as const) {
      const refusal = await validateAssignment({
        agentId: agent.id,
        toolId: tool.id,
        credentialResolutionMode: mode,
      });
      expect(refusal?.code).toBe("validation_error");
      expect(refusal?.error.message).toContain("personal");
    }
    expect(
      await validateAssignment({
        agentId: agent.id,
        toolId: tool.id,
        credentialResolutionMode: "dynamic",
      }),
    ).toBeNull();
  });

  test("refuses team, organization, service and scheduled identities before attempting a laptop call", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeAgentTool,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "device",
      deviceConfig,
    });
    const [tool] = await ToolModel.findByCatalogId(catalog.id, {
      kind: "caller",
      userId: user.id,
      organizationId: org.id,
    });
    await makeAgentTool(agent.id, tool.id, {
      credentialResolutionMode: "dynamic",
    });
    const trigger = await makeScheduleTrigger({
      organizationId: org.id,
      actorUserId: user.id,
      agentId: agent.id,
    });
    const scheduleRun = await makeScheduleTriggerRun(trigger.id);
    const taskId = randomUUID();
    await ScheduleTriggerRunModel.setRuntimeTaskId({
      runId: scheduleRun.id,
      taskId,
    });
    for (const extra of [
      { runId: taskId },
      { teamId: "team" },
      { isOrganizationToken: true },
      { serviceAccountId: randomUUID() },
      { isBackgroundExecution: true },
    ]) {
      const result = await mcpClient.executeToolCallForOwner(
        { id: randomUUID(), name: tool.name, arguments: {} },
        agentOwner(agent.id),
        {
          tokenId: randomUUID(),
          teamId: null,
          isOrganizationToken: false,
          organizationId: org.id,
          userId: user.id,
          ...extra,
        },
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        /personal user identity|scheduled tasks/,
      );
    }
  });
  test("returns a personal device setup action when no device is paired", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeAgentTool,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    await OrganizationModel.patch(org.id, { deviceMcpEnabled: true });
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "device",
      deviceConfig,
    });
    const [tool] = await ToolModel.findByCatalogId(catalog.id, {
      kind: "caller",
      userId: user.id,
      organizationId: org.id,
    });
    await makeAgentTool(agent.id, tool.id, {
      credentialResolutionMode: "dynamic",
    });
    const result = await mcpClient.executeToolCallForOwner(
      { id: randomUUID(), name: tool.name, arguments: {} },
      agentOwner(agent.id),
      {
        tokenId: randomUUID(),
        teamId: null,
        isOrganizationToken: false,
        organizationId: org.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(true);
    expect(result._meta?.archestraError).toMatchObject({
      type: "auth_required",
      action: "connect_device",
      catalogId: catalog.id,
      actionUrl: expect.stringContaining(`/mcp/registry/${catalog.id}`),
    });
    expect(result._meta?.archestraError).toMatchObject({
      message: expect.stringContaining("your own device"),
    });
  });
});
