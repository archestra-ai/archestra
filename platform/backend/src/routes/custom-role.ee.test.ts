import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { createOrgRoleMock } = vi.hoisted(() => ({
  createOrgRoleMock: vi.fn(),
}));

vi.mock("@/auth", () => ({
  betterAuth: {
    api: {
      createOrgRole: createOrgRoleMock,
    },
  },
}));

describe("custom role routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    user = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: unknown;
          organizationId: string;
        }
      ).user = user;
      (
        request as typeof request & {
          user: { id: string };
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: customRoleRoutes } = await import("./custom-role.ee");
    await app.register(customRoleRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("gracefully normalizes malformed permission JSON from the auth layer", async () => {
    createOrgRoleMock.mockResolvedValue({
      roleData: {
        id: "role-1",
        organizationId,
        role: "ops_admin",
        name: "Ops Admin",
        description: "Operations access",
        permission: "{not-json}",
        createdAt: new Date("2026-03-15T00:00:00.000Z"),
        updatedAt: new Date("2026-03-15T00:00:00.000Z"),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: {
        name: "Ops Admin",
        description: "Operations access",
        permission: {},
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "role-1",
      name: "Ops Admin",
      permission: {},
      predefined: false,
    });
  });
});
