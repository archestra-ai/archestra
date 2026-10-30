import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import OrganizationModel from "@/models/organization";
import { organizationAgentRuntimeTiers } from "@/services/agent-runtime/runtime-tiers";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

describe("PATCH /api/organization/agent-settings: Agent Runtime tiers", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
    user = await makeAdmin();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const patch = (payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: "/api/organization/agent-settings",
      payload,
    });

  test("an administrator resizes a tier; runs and pools then get that size, and null restores the defaults", async () => {
    expect((await organizationAgentRuntimeTiers(organizationId)).L).toEqual({
      cpuRequest: "8",
      cpuLimit: null,
      memoryRequest: "16Gi",
      memoryLimit: "32Gi",
      warmPoolSize: 0,
    });

    const response = await patch({
      agentRuntimeTiers: {
        L: { cpuRequest: "12", memoryLimit: "48Gi", warmPoolSize: 1 },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agentRuntimeTiers).toEqual({
      L: { cpuRequest: "12", memoryLimit: "48Gi", warmPoolSize: 1 },
    });
    expect((await organizationAgentRuntimeTiers(organizationId)).L).toEqual({
      cpuRequest: "12",
      cpuLimit: null,
      memoryRequest: "16Gi",
      memoryLimit: "48Gi",
      warmPoolSize: 1,
    });

    expect((await patch({ agentRuntimeTiers: null })).statusCode).toBe(200);
    expect(
      (await OrganizationModel.getById(organizationId))?.agentRuntimeTiers,
    ).toBeNull();
  });

  test("refuses a limit below its request, tiers out of order, and values that are not Kubernetes quantities", async () => {
    const limitBelowRequest = await patch({
      agentRuntimeTiers: { M: { memoryLimit: "6Gi" } },
    });
    expect(limitBelowRequest.statusCode).toBe(400);
    expect(limitBelowRequest.json().error.message).toContain(
      "Tier M: the memory limit is below the memory request",
    );
    const outOfOrder = await patch({
      agentRuntimeTiers: { L: { cpuRequest: "1" } },
    });
    expect(outOfOrder.statusCode).toBe(400);
    expect(outOfOrder.json().error.message).toContain(
      "Tier L requests less than tier M",
    );
    expect(
      (await patch({ agentRuntimeTiers: { L: { cpuRequest: "4 cores" } } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await OrganizationModel.getById(organizationId))?.agentRuntimeTiers,
    ).toBeNull();
  });

  test("members who may update other agent settings cannot resize tiers", async ({
    makeUser,
    makeMember,
  }) => {
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });
    const response = await patch({
      agentRuntimeTiers: { S: { cpuRequest: "500m" } },
    });
    expect(response.statusCode).toBe(403);
    expect(
      (await OrganizationModel.getById(organizationId))?.agentRuntimeTiers,
    ).toBeNull();
  });
});
