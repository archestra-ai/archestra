import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

const mockHasPermission = hasPermission as Mock;

describe("GET /api/k8s/image-pull-secrets", () => {
  let app: FastifyInstance;
  let organizationId: string;
  let user: User;
  let listSecretsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    listSecretsSpy = vi
      .spyOn(mcpServerRuntimeManager, "listDockerRegistrySecrets")
      .mockResolvedValue([
        { name: "registry-creds", registryServers: ["registry.example.com"] },
      ]);

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { message: error.message, type: error.type },
        });
      }
      const err = error as Error & { statusCode?: number };
      const status = err.statusCode ?? 500;
      return reply.status(status).send({ error: { message: err.message } });
    });
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organization.id;
    });
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    listSecretsSpy.mockRestore();
    await app.close();
  });

  test("an admin lists secrets across the whole cluster", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/k8s/image-pull-secrets",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { name: "registry-creds", registryServers: ["registry.example.com"] },
    ]);
    expect(listSecretsSpy).toHaveBeenCalledWith({ isAdmin: true });
  });

  test("a non-admin lists secrets scoped to their team memberships", async ({
    makeTeam,
    makeUser,
    makeMember,
    makeTeamMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    const team = await makeTeam(organizationId, member.id, { name: "core" });
    await makeTeamMember(team.id, member.id);
    user = member;
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const response = await app.inject({
      method: "GET",
      url: "/api/k8s/image-pull-secrets",
    });

    expect(response.statusCode).toBe(200);
    expect(listSecretsSpy).toHaveBeenCalledWith({
      teamIds: expect.arrayContaining([team.id]),
    });
    const callArg = listSecretsSpy.mock.calls[0][0];
    expect(callArg).not.toHaveProperty("isAdmin");
  });
});
