import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

vi.mock("@/models", () => ({
  AgentModel: {
    findById: vi.fn(),
  },
}));

vi.mock("@/services/outgoing-email.service", () => ({
  isOutgoingEmailEnabled: vi.fn(),
  sendOutgoingEmail: vi.fn(),
}));

import { hasPermission } from "@/auth";
import { AgentModel } from "@/models";
import {
  isOutgoingEmailEnabled,
  sendOutgoingEmail,
} from "@/services/outgoing-email.service";
import outgoingEmailRoutes from "./outgoing-email";

describe("Outgoing email route", () => {
  let app: FastifyInstance;

  const routeUrl =
    "/api/agents/11111111-1111-4111-8111-111111111111/outgoing-email";

  beforeEach(async () => {
    vi.resetAllMocks();

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest("user", {
      getter() {
        return (this as { _testUser?: { id: string } })._testUser;
      },
      setter(value: unknown) {
        (this as { _testUser?: unknown })._testUser = value;
      },
    } as never);
    app.setErrorHandler(
      (error: { message: string; statusCode?: number }, _request, reply) => {
        const statusCode =
          typeof error.statusCode === "number" ? error.statusCode : 500;

        const errorTypeByStatusCode: Record<number, string> = {
          400: "api_validation_error",
          401: "api_authentication_error",
          403: "api_authorization_error",
          404: "api_not_found_error",
          409: "api_conflict_error",
          500: "api_internal_server_error",
        };

        reply.code(statusCode).send({
          error: {
            message: error.message,
            type:
              errorTypeByStatusCode[statusCode] || errorTypeByStatusCode[500],
          },
        });
      },
    );

    app.addHook("onRequest", async (request) => {
      (request as { user: { id: string } }).user = {
        id: "22222222-2222-4222-8222-222222222222",
      };
    });

    await app.register(outgoingEmailRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns 400 when payload validation fails", async () => {
    vi.mocked(isOutgoingEmailEnabled).mockReturnValue(true);

    const response = await app.inject({
      method: "POST",
      url: routeUrl,
      payload: {
        to: "not-an-email",
        subject: "Hi",
        text: "Body",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(vi.mocked(sendOutgoingEmail)).not.toHaveBeenCalled();
  });

  test("returns 400 when outgoing email is not configured", async () => {
    vi.mocked(isOutgoingEmailEnabled).mockReturnValue(false);

    const response = await app.inject({
      method: "POST",
      url: routeUrl,
      payload: {
        to: "user@example.com",
        subject: "Hi",
        text: "Body",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message:
          "Outgoing email is not configured. Enable Gmail API env vars first.",
      },
    });
    expect(vi.mocked(hasPermission)).not.toHaveBeenCalled();
  });

  test("checks authorization and returns 404 when agent does not exist", async () => {
    vi.mocked(isOutgoingEmailEnabled).mockReturnValue(true);
    vi.mocked(hasPermission).mockResolvedValue({ success: false, error: null });
    vi.mocked(AgentModel.findById).mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: routeUrl,
      headers: {
        authorization: "Bearer archestra_test_key",
      },
      payload: {
        to: "user@example.com",
        subject: "Hi",
        text: "Body",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(vi.mocked(hasPermission)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hasPermission)).toHaveBeenCalledWith(
      { profile: ["admin"] },
      expect.objectContaining({
        authorization: "Bearer archestra_test_key",
      }),
    );
    expect(vi.mocked(AgentModel.findById)).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      false,
    );
  });
});
