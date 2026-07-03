import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { InternalMcpCatalogModel, McpToolCallModel } from "@/models";
import { afterEach, beforeEach, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth");

const mockHasPermission = hasPermission as Mock;

type UsageRow = {
  catalogId: string;
  toolCallCount: number;
  lastToolCallAt: string | null;
};

let app: FastifyInstance;
let organizationId: string;
let user: User;
let agentId: string;

beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
  vi.clearAllMocks();
  mockHasPermission.mockResolvedValue({ success: true, error: null });

  const organization = await makeOrganization();
  organizationId = organization.id;
  user = await makeUser();
  await makeMember(user.id, organizationId, { role: "admin" });
  const agent = await makeAgent({ organizationId });
  agentId = agent.id;

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
    (request as typeof request & { user: User; organizationId: string }).user =
      user;
    (
      request as typeof request & { user: User; organizationId: string }
    ).organizationId = organizationId;
  });
  await app.register(internalMcpCatalogRoutes);
});

afterEach(async () => {
  await app.close();
});

async function getUsage(): Promise<UsageRow[]> {
  const response = await app.inject({
    method: "GET",
    url: "/api/internal_mcp_catalog/usage",
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

test("counts executed tool calls per catalog item, matching by slugified name", async () => {
  // Name needs slugifying (spaces + uppercase) — tool calls are recorded
  // under the slugified prefix of the full tool name.
  const used = await InternalMcpCatalogModel.create(
    {
      name: "GitHub Server",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    },
    { organizationId, authorId: user.id },
  );
  const unused = await InternalMcpCatalogModel.create(
    {
      name: "idle-server",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    },
    { organizationId, authorId: user.id },
  );

  await McpToolCallModel.create({
    agentId,
    mcpServerName: "github_server",
    method: "tools/call",
    toolCall: null,
    toolResult: null,
  });
  await McpToolCallModel.create({
    agentId,
    mcpServerName: "github_server",
    method: "tools/call",
    toolCall: null,
    toolResult: null,
  });

  const usage = await getUsage();
  const usedRow = usage.find((row) => row.catalogId === used.id);
  const unusedRow = usage.find((row) => row.catalogId === unused.id);

  expect(usedRow?.toolCallCount).toBe(2);
  expect(usedRow?.lastToolCallAt).toEqual(expect.any(String));
  expect(unusedRow).toEqual({
    catalogId: unused.id,
    toolCallCount: 0,
    lastToolCallAt: null,
  });
});

test("non-execution gateway traffic (tools/list, initialize) is not usage", async () => {
  const item = await InternalMcpCatalogModel.create(
    {
      name: "listed-only-server",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "org",
    },
    { organizationId, authorId: user.id },
  );

  for (const method of ["tools/list", "initialize"]) {
    await McpToolCallModel.create({
      agentId,
      mcpServerName: "listed-only-server",
      method,
      toolCall: null,
      toolResult: null,
    });
  }

  const usage = await getUsage();
  expect(usage.find((row) => row.catalogId === item.id)).toEqual({
    catalogId: item.id,
    toolCallCount: 0,
    lastToolCallAt: null,
  });
});

test("only catalog items visible to the caller are reported", async ({
  makeMember,
  makeUser,
}) => {
  const author = await makeUser();
  await makeMember(author.id, organizationId, { role: "member" });
  const personal = await InternalMcpCatalogModel.create(
    {
      name: "authors-personal-server",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      scope: "personal",
    },
    { organizationId, authorId: author.id },
  );

  // A different non-admin member must not see the author's personal item.
  const member = await makeUser();
  await makeMember(member.id, organizationId, { role: "member" });
  user = member;
  mockHasPermission.mockResolvedValue({ success: false, error: null });

  const usage = await getUsage();
  expect(usage.map((row) => row.catalogId)).not.toContain(personal.id);
});
