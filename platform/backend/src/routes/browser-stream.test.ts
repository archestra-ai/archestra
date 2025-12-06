import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { BrowserStreamService } from "@/services/browser-stream";
import { beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";
import browserStreamRoutes from "./browser-stream";

const buildAppWithUser = async (user: User, organizationId: string) => {
  const app = Fastify({ logger: false })
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler);

  app.decorateRequest("user");
  app.decorateRequest("organizationId");
  app.addHook("preHandler", async (request) => {
    request.user = user;
    request.organizationId = organizationId;
  });

  await app.register(browserStreamRoutes);
  await app.ready();
  return app;
};

describe("browser-stream routes authorization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("denies access to conversations not owned by the caller", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id, {
      userId: owner.id,
      organizationId: org.id,
    });

    const app = await buildAppWithUser(otherUser as User, org.id);
    const availabilitySpy = vi.spyOn(
      BrowserStreamService.prototype,
      "checkAvailability",
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/browser-stream/${conversation.id}/available`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      error: "Conversation not found",
    });
    expect(availabilitySpy).not.toHaveBeenCalled();

    await app.close();
  });

  test("allows owners to access their conversation browser stream", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = (await makeUser()) as User;
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id, {
      userId: owner.id,
      organizationId: org.id,
    });

    const app = await buildAppWithUser(owner, org.id);
    const availabilitySpy = vi
      .spyOn(BrowserStreamService.prototype, "checkAvailability")
      .mockResolvedValue({
        available: true,
        tools: ["browser_navigate"],
      });

    const response = await app.inject({
      method: "GET",
      url: `/api/browser-stream/${conversation.id}/available`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: true,
      tools: ["browser_navigate"],
    });
    expect(availabilitySpy).toHaveBeenCalledWith(agent.id);

    await app.close();
  });
});
