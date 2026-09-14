import { vi } from "vitest";
import {
  betterAuth,
  getAgentTypePermissionChecker,
  hasPermission,
} from "@/auth";
import { getAgentTypePermissionChecker as realGetAgentTypePermissionChecker } from "@/auth/agent-type-permissions";
import { authPlugin } from "@/auth/fastify-plugin";
import { hasPermission as realHasPermission } from "@/auth/utils";
import { LlmProviderApiKeyModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import agentRoutes from "./agent";

vi.mock("@/auth");

describe("authenticated agent list organization scope", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    vi.mocked(hasPermission).mockImplementation(realHasPermission);
    vi.mocked(getAgentTypePermissionChecker).mockImplementation(
      realGetAgentTypePermissionChecker,
    );
    app = createFastifyInstance();
    await app.register(authPlugin);
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test.for([
    "admin",
    "member",
  ] as const)("scopes %s results, metadata, and totals to the authenticated organization", async (role, {
    makeOrganization,
    makeUser,
    makeMember,
    makeSession,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const unrelatedOrganization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role });
    const session = await makeSession(user.id, {
      activeOrganizationId: organization.id,
    });
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: { user, session },
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof betterAuth.api.getSession>>);

    const localKey = await LlmProviderApiKeyModel.create({
      name: "Local provider",
      provider: "openai",
      scope: "org",
      organizationId: organization.id,
    });
    const unrelatedKey = await LlmProviderApiKeyModel.create({
      name: "Unrelated provider",
      provider: "openai",
      scope: "org",
      organizationId: unrelatedOrganization.id,
    });
    const localAgents = [];
    for (const name of ["Local Alpha", "Local Beta"]) {
      localAgents.push(
        await makeAgent({
          name,
          agentType: "agent",
          organizationId: organization.id,
          scope: "org",
          llmApiKeyId: localKey.id,
        }),
      );
    }
    await makeAgent({
      name: "Unrelated assistant",
      agentType: "agent",
      organizationId: unrelatedOrganization.id,
      scope: "org",
      llmApiKeyId: unrelatedKey.id,
    });

    for (const filter of [
      "",
      `&providerApiKeyId=${localKey.id}`,
      `&organizationId=${unrelatedOrganization.id}`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/agents?agentType=agent&sortBy=name&sortDirection=asc&limit=1&offset=1${filter}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().pagination.total).toBe(2);
      expect(response.json().data).toMatchObject([
        {
          id: localAgents[1].id,
          organizationId: organization.id,
          resolvedLlmProviderKeyName: "Local provider",
        },
      ]);
      expect(response.body).not.toContain("Unrelated provider");
    }

    const unrelatedResponse = await app.inject({
      method: "GET",
      url: `/api/agents?agentType=agent&providerApiKeyId=${unrelatedKey.id}`,
    });
    expect(unrelatedResponse.statusCode).toBe(200);
    expect(unrelatedResponse.json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
  });
});
