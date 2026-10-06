import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { ModelModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { formatSessionReceipt } from "@/openappa/session-token";
import { stampToolCallId } from "@/openappa/trajectory-stamp";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { type Agent, ApiError } from "@/types";
import { openaiAdapterFactory } from "./adapters";
import openAiProxyRoutes from "./routes/openai";

const MARKER =
  "[appa] delegated trajectory appa-0123456789abcdef0123456789abcdef01234567 — child of parent-1.";
const EXTERNAL = "203.0.113.8";

describe("inactive OpenAPPA carrier strips", () => {
  let app: FastifyInstance;
  let agent: Agent;
  const providerRequests: unknown[] = [];

  beforeEach(async ({ makeAgent }) => {
    providerRequests.length = 0;
    await GuardrailsDeploymentModel.setEnabled(false);
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError && typeof error.shouldRetry === "boolean") {
        reply.header("x-should-retry", String(error.shouldRetry));
      }
      const statusCode = error instanceof ApiError ? error.statusCode : 500;
      return reply.status(statusCode).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type:
            error instanceof ApiError
              ? error.type
              : "api_internal_server_error",
        },
      });
    });
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      const client = createOpenAiTestClient();
      const create = client.chat.completions.create.bind(
        client.chat.completions,
      );
      client.chat.completions.create = (async (params: unknown) => {
        providerRequests.push(structuredClone(params));
        return create(params as never);
      }) as typeof client.chat.completions.create;
      return client as never;
    });
    agent = await makeAgent({ name: "Inactive carrier agent" });
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    await app.register(openAiProxyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await GuardrailsDeploymentModel.setEnabled(false);
  });

  test("refuses echoed marked spawn arguments before the provider", async () => {
    const argumentsText = JSON.stringify({
      prompt: `task\n\n${MARKER}`,
    });
    const response = await post(chat([assistant([taskCall(argumentsText)])]));

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.message).toContain("enforcement is off");
    expect(response.headers["x-should-retry"]).toBe("false");
    expect(providerRequests).toEqual([]);
  });

  test("refuses spaced arguments and a marker-only text block", async () => {
    const argumentsText = `\n{ "prompt" : "task\\n\\n${MARKER}" }\n`;
    const response = await post(
      chat([
        assistant(
          [taskCall(argumentsText)],
          [{ type: "text", text: `\n\n${MARKER}` }],
        ),
      ]),
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(providerRequests).toEqual([]);
  });

  test("refuses a trajectory stamp that the decoder would restore", async () => {
    const id = stampToolCallId({
      callId: "call_plain",
      sessionId: "session-1",
      organizationId: "org",
      callerId: "caller",
      secret: "stamp-secret",
    });
    const response = await post(
      chat([
        assistant([
          {
            id,
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
          taskCall("{}"),
        ]),
      ]),
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(providerRequests).toEqual([]);
  });

  test("refuses a receipt whose surrounding newline would be eaten", async () => {
    const response = await post(
      chat([
        {
          role: "user",
          content: `hello\n${formatSessionReceipt("ABC-DEFG")}`,
        },
      ]),
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(providerRequests).toEqual([]);
  });

  test("forwards an unmarked request unchanged", async () => {
    const messages = [{ role: "user", content: "Hello" }];
    const response = await post(chat(messages));

    expect(response.statusCode, response.body).toBe(200);
    expect(providerRequests).toEqual([expect.objectContaining({ messages })]);
  });

  test("forwards inert appa text that the decoders do not change", async () => {
    const messages = [
      {
        role: "user",
        content:
          "appa is not a carrier. [appa] delegated trajectory not-a-token — child of parent.",
      },
    ];
    const response = await post(chat(messages));

    expect(response.statusCode, response.body).toBe(200);
    expect(providerRequests).toEqual([expect.objectContaining({ messages })]);
  });

  test("does not reveal the carrier refusal before authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: EXTERNAL,
      headers: {
        "content-type": "application/json",
        authorization: "",
      },
      payload: chat([
        assistant([taskCall(JSON.stringify({ prompt: `task\n\n${MARKER}` }))]),
      ]),
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(response.body).not.toContain("enforcement is off");
    expect(providerRequests).toEqual([]);
  });

  function chat(messages: unknown[]) {
    return {
      model: "gpt-4o",
      messages,
      stream: false,
    };
  }

  function assistant(
    toolCalls: ReturnType<typeof taskCall>[],
    content?: unknown,
  ) {
    return {
      role: "assistant" as const,
      ...(content === undefined ? {} : { content }),
      tool_calls: toolCalls,
    };
  }

  function taskCall(argumentsText: string) {
    return {
      id: "call_task",
      type: "function" as const,
      function: { name: "Task", arguments: argumentsText },
    };
  }

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: EXTERNAL,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      payload,
    });
  }
});
