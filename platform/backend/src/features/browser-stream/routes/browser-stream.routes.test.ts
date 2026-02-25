import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { BrowserStreamService } from "@/features/browser-stream/services/browser-stream.service";
import AgentModel from "@/models/agent";
import { beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

// Mock config to ENABLE the feature for these tests
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      features: {
        ...actual.default.features,
        browserStreamingEnabled: true, // Feature is enabled for these tests
      },
    },
  };
});

// Import routes AFTER mocking config (dynamic import needed because of the mock)
const { default: browserStreamRoutes } = await import(
  "./browser-stream.routes"
);
const { default: chatRoutes } = await import("@/routes/chat/routes.chat");

const buildAppWithUser = async (user: User, organizationId: string) => {
  const app = Fastify({ logger: false })
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler)
    .setErrorHandler<ApiError | Error>((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { message: error.message, type: error.type },
        });
      }
      return reply.status(500).send({
        error: { message: error.message, type: "api_internal_server_error" },
      });
    });

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
    // Mock Playwright tools as assigned so browser stream tests can proceed
    vi.spyOn(AgentModel, "hasPlaywrightToolsAssigned").mockResolvedValue(true);
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

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: expect.objectContaining({
        message: "Conversation not found",
      }),
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

const buildAppWithChatRoutes = async (user: User, organizationId: string) => {
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

  await app.register(chatRoutes);
  await app.ready();
  return app;
};

describe("browser tab cleanup on conversation deletion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("closes browser tab when conversation is deleted via API", async ({
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

    // Mock the closeTab method to track if it's called
    const closeTabSpy = vi
      .spyOn(BrowserStreamService.prototype, "closeTab")
      .mockResolvedValue({ success: true });

    // Build app with chat routes and delete the conversation via API
    const app = await buildAppWithChatRoutes(owner, org.id);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/chat/conversations/${conversation.id}`,
    });

    expect(response.statusCode).toBe(200);

    // Verify closeTab was called with the correct arguments
    expect(closeTabSpy).toHaveBeenCalledWith(
      agent.id,
      conversation.id,
      expect.objectContaining({ userId: owner.id }),
    );

    await app.close();
  });
});
