import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { uuidv7 } from "@/utils/uuid";

describe("POST /api/chat message validation", () => {
  let app: FastifyInstanceWithZod;
  let validatedBody: unknown;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    validatedBody = undefined;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organization.id;
    });
    app.addHook("preHandler", async (request) => {
      validatedBody = request.body;
    });
    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test.each([
    { role: "user", content: "Hello" },
    { role: "assistant" },
    { role: "user", parts: null },
    { role: "user", parts: "Hello" },
    { role: "user", parts: [null] },
    { role: "user", parts: [{ text: "Hello" }] },
    null,
  ])("rejects malformed message %j before running the handler", async (message) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { id: uuidv7(), messages: [message] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("messages");
    expect(validatedBody).toBeUndefined();
  });

  test("preserves UI message content, tool results, and custom data parts", async () => {
    const payload = {
      id: uuidv7(),
      messages: [
        {
          id: "user-message",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
          metadata: { custom: "retained" },
        },
        {
          id: "assistant-message",
          role: "assistant",
          parts: [
            { type: "step-start" },
            {
              type: "tool-example",
              toolCallId: "call-example",
              state: "output-available",
              input: { query: "example" },
              output: { result: "example" },
            },
            { type: "data-example", data: { value: "retained" } },
          ],
        },
      ],
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload,
    });

    // A well-formed request reaches the handler's conversation lookup.
    expect(response.statusCode).toBe(404);
    expect(validatedBody).toEqual(payload);
  });
});
