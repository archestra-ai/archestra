import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { InternalMcpCatalogModel, McpCatalogLabelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

const mockHasPermission = hasPermission as Mock;

describe("internal MCP catalog label routes", () => {
  let app: FastifyInstance;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

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
    await app.close();
  });

  async function seedLabels() {
    const first = await InternalMcpCatalogModel.create(
      {
        name: "labelled-server-a",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      },
      { organizationId, authorId: user.id },
    );
    const second = await InternalMcpCatalogModel.create(
      {
        name: "labelled-server-b",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        scope: "org",
      },
      { organizationId, authorId: user.id },
    );
    await McpCatalogLabelModel.syncCatalogLabels(first.id, [
      { key: "env", value: "prod" },
      { key: "team", value: "core" },
    ]);
    await McpCatalogLabelModel.syncCatalogLabels(second.id, [
      { key: "env", value: "staging" },
    ]);
  }

  test("GET /labels/keys returns the distinct label keys in use", async () => {
    await seedLabels();

    const response = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog/labels/keys",
    });

    expect(response.statusCode).toBe(200);
    const keys = response.json();
    expect(keys).toContain("env");
    expect(keys).toContain("team");
  });

  test("GET /labels/values returns every value when no key filter is given", async () => {
    await seedLabels();

    const response = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog/labels/values",
    });

    expect(response.statusCode).toBe(200);
    const values = response.json();
    expect(values).toEqual(expect.arrayContaining(["prod", "core", "staging"]));
  });

  test("GET /labels/values?key=env narrows results to that key", async () => {
    await seedLabels();

    const response = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog/labels/values?key=env",
    });

    expect(response.statusCode).toBe(200);
    const values = response.json();
    expect(values).toEqual(expect.arrayContaining(["prod", "staging"]));
    expect(values).not.toContain("core");
  });
});
