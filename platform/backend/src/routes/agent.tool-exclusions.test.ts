import { type Mock, vi } from "vitest";
import { getAgentTypePermissionChecker } from "@/auth";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;

describe("agent tool-exclusions routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let requireMock: Mock;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);

    requireMock = vi.fn();
    mockGetAgentTypePermissionChecker.mockResolvedValue({
      require: requireMock,
      isAdmin: vi.fn().mockReturnValue(true),
      isTeamAdmin: vi.fn().mockReturnValue(true),
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(true),
    });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("GET returns empty sets and PUT round-trips a full replace", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllTools: true });
    const toolCatalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "github__create_issue",
      catalogId: toolCatalog.id,
    });

    const emptyResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/tool-exclusions`,
    });
    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json()).toEqual({ excludedToolIds: [] });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/tool-exclusions`,
      payload: { excludedToolIds: [tool.id] },
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual({ excludedToolIds: [tool.id] });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/tool-exclusions`,
    });
    expect(getResponse.json()).toEqual({ excludedToolIds: [tool.id] });

    // Full replace with an empty set clears everything
    const clearResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/tool-exclusions`,
      payload: { excludedToolIds: [] },
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({ excludedToolIds: [] });
  });

  test("returns 404 for an agent belonging to another organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${foreignAgent.id}/tool-exclusions`,
    });
    expect(getResponse.statusCode).toBe(404);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${foreignAgent.id}/tool-exclusions`,
      payload: { excludedToolIds: [] },
    });
    expect(putResponse.statusCode).toBe(404);
  });

  test("returns 404 when the caller lacks the agent-type permission", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    requireMock.mockImplementation(() => {
      throw new Error("missing permission");
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/tool-exclusions`,
    });
    expect(getResponse.statusCode).toBe(404);
    expect(requireMock).toHaveBeenCalledWith(agent.agentType, "read");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/tool-exclusions`,
      payload: { excludedToolIds: [] },
    });
    expect(putResponse.statusCode).toBe(404);
    expect(requireMock).toHaveBeenCalledWith(agent.agentType, "update");
  });

  test("PUT rejects invalid exclusions with 400 and leaves state untouched", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllTools: true });
    const toolCatalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "github__create_issue",
      catalogId: toolCatalog.id,
    });
    await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/tool-exclusions`,
      payload: { excludedToolIds: [tool.id] },
    });

    const badResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/tool-exclusions`,
      payload: { excludedToolIds: [crypto.randomUUID()] },
    });
    expect(badResponse.statusCode).toBe(400);

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/tool-exclusions`,
    });
    expect(getResponse.json()).toEqual({ excludedToolIds: [tool.id] });
  });
});
