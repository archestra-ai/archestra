import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import OrganizationModel from "@/models/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

describe("PATCH /api/organization/security-settings", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });

    adminUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = adminUser;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organizationId;
    });

    registerAuditLogHook(app);
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
      url: "/api/organization/security-settings",
      payload,
    });

  test("LLM proxy requests need a platform credential until an admin opts out", async () => {
    expect(
      await OrganizationModel.allowsUnauthenticatedLlmProxyRequests(
        organizationId,
      ),
    ).toBe(false);

    const response = await patch({
      allowUnauthenticatedLlmProxyRequests: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().allowUnauthenticatedLlmProxyRequests).toBe(true);
    expect(
      await OrganizationModel.allowsUnauthenticatedLlmProxyRequests(
        organizationId,
      ),
    ).toBe(true);

    await vi.waitFor(async () => {
      const { data } = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "organization",
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        action: "organization.updated",
        outcome: "success",
        before: { allowUnauthenticatedLlmProxyRequests: false },
        after: { allowUnauthenticatedLlmProxyRequests: true },
      });
    });
  });
});
