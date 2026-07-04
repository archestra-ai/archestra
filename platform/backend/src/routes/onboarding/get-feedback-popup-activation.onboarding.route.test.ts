import config from "@/config";
import { McpToolCallModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/onboarding/feedback-popup-activation", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    // Analytics defaults off outside production, and the pop-up respects the
    // opt-out; enable it so activation is testable. Restored automatically.
    config.analytics.enabled = true;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: onboardingRoutes } = await import("./onboarding.routes");
    await app.register(onboardingRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function getActivatedAt() {
    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/feedback-popup-activation",
    });
    expect(response.statusCode).toBe(200);
    return response.json().activatedAt as string | null;
  }

  test("null on a pristine instance", async () => {
    expect(await getActivatedAt()).toBeNull();
  });

  test("null when an MCP server exists but no successful tool call was routed", async ({
    makeMcpServer,
    makeAgent,
  }) => {
    await makeMcpServer();
    const agent = await makeAgent();
    // A failed call doesn't count as activation.
    await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "test-server",
      method: "tools/call",
      toolCall: { id: "call-1", name: "testTool", arguments: {} },
      toolResult: { id: "call-1", content: [], isError: true },
    });

    expect(await getActivatedAt()).toBeNull();
  });

  test("null when a successful tool call exists but no MCP server is connected", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "test-server",
      method: "tools/call",
      toolCall: { id: "call-1", name: "testTool", arguments: {} },
      toolResult: { id: "call-1", content: [], isError: false },
    });

    expect(await getActivatedAt()).toBeNull();
  });

  test("returns the later of the two activation timestamps once both exist", async ({
    makeMcpServer,
    makeAgent,
  }) => {
    const server = await makeMcpServer();
    const agent = await makeAgent();
    const call = await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "test-server",
      method: "tools/call",
      toolCall: { id: "call-1", name: "testTool", arguments: {} },
      toolResult: { id: "call-1", content: [], isError: false },
    });

    const activatedAt = await getActivatedAt();
    expect(activatedAt).not.toBeNull();
    const expected = Math.max(
      new Date(server.createdAt).getTime(),
      new Date(call.createdAt).getTime(),
    );
    expect(new Date(activatedAt as string).getTime()).toBe(expected);
  });

  test("null on enterprise-licensed instances even when activated", async ({
    makeMcpServer,
    makeAgent,
  }) => {
    await makeMcpServer();
    const agent = await makeAgent();
    await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "test-server",
      method: "tools/call",
      toolCall: { id: "call-1", name: "testTool", arguments: {} },
      toolResult: { id: "call-1", content: [], isError: false },
    });
    // Restored automatically after the test by the shared setup.
    config.enterpriseFeatures.core = true;

    expect(await getActivatedAt()).toBeNull();
  });

  test("null when analytics is disabled (phone-home opt-out)", async ({
    makeMcpServer,
    makeAgent,
  }) => {
    await makeMcpServer();
    const agent = await makeAgent();
    await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "test-server",
      method: "tools/call",
      toolCall: { id: "call-1", name: "testTool", arguments: {} },
      toolResult: { id: "call-1", content: [], isError: false },
    });
    config.analytics.enabled = false;

    expect(await getActivatedAt()).toBeNull();
  });

  test("non-call methods do not count as activation", async ({
    makeMcpServer,
    makeAgent,
  }) => {
    await makeMcpServer();
    const agent = await makeAgent();
    await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "test-server",
      method: "tools/list",
      toolCall: null,
      toolResult: { tools: [] },
    });

    expect(await getActivatedAt()).toBeNull();
  });
});
