import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  userHasPermission: vi.fn(),
}));

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("POST /api/connection-setups/passthrough-key", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(true);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: connectionSetupRoutes } = await import(
      "./connection-setup.routes"
    );
    await app.register(connectionSetupRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("provisions a passthrough key scoped to the proxy and returns its value once", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/passthrough-key",
      payload: { llmProxyId: proxy.id },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.value).toMatch(/arch_[0-9a-f]{64}/);
    expect(body.name).toContain("Connection passthrough");
  });

  test("403s without llmVirtualKey:create permission", async ({
    makeAgent,
  }) => {
    mockUserHasPermission.mockImplementation(
      async (_userId, _orgId, resource, action) =>
        !(resource === "llmVirtualKey" && action === "create"),
    );
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/passthrough-key",
      payload: { llmProxyId: proxy.id },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("llmVirtualKey:create");
  });

  test("404s when the LLM proxy is not accessible", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/passthrough-key",
      payload: { llmProxyId: "00000000-0000-0000-0000-000000000000" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("LLM proxy not found");
  });
});
