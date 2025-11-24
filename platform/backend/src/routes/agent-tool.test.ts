import { vi } from "vitest";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn().mockResolvedValue({ success: true }),
}));

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, describe, expect, test } from "@/test";
import { AgentToolModel, OrganizationModel } from "@/models";
import agentToolRoutes from "./agent-tool";

describe("agent-tool routes", () => {
  let app: ReturnType<typeof Fastify.withTypeProvider<ZodTypeProvider>> | null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  test("GET /api/agent-tools filters assignments by toolId", async ({
    makeAgent,
    makeTool,
  }) => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const organization = await OrganizationModel.getOrCreateDefaultOrganization();
    const user = {
      id: crypto.randomUUID(),
      name: "Test User",
      email: "user@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: "admin",
      image: null,
      banned: false,
      banReason: null,
      banExpires: null,
      twoFactorEnabled: false,
    } as const;

    app.addHook("preHandler", async (request) => {
      request.user = user;
      request.organizationId = organization.id;
    });

    await app.register(agentToolRoutes);

    const agent = await makeAgent();
    const targetTool = await makeTool();
    const otherTool = await makeTool();

    await AgentToolModel.create(agent.id, targetTool.id);
    await AgentToolModel.create(agent.id, otherTool.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/agent-tools?toolId=${targetTool.id}&limit=10&offset=0`,
      headers: { authorization: "Bearer test-key" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].tool.id).toBe(targetTool.id);
  });
});
