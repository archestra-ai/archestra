import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";
import customRoleRoutes from "./custom-role.ee";

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
  let app: FastifyInstance;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    user = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

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
