import { ArchestraInternalErrorCode } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import modelRouterProxyRoutes from "./model-router";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper, not a React hook.
const server = useMswServer();
const BASE_URL = "https://gemini-errors.example.test";
const MODEL = "gemini-2.5-pro";
const dunningBody = {
  error: {
    code: 403,
    status: "PERMISSION_DENIED",
    message:
      "Lightning dunning decision is deny for project: projects/123456789012",
  },
};

for (const stream of [false, true]) {
  test.for([
    {
      label: "a JSON project denial",
      status: 403,
      contentType: "application/json",
      body: JSON.stringify(dunningBody),
      message: "Google denied access to the configured project",
      internalCode: undefined,
    },
    {
      label: "a project denial wrapped as text by an upstream proxy",
      status: 403,
      contentType: "text/plain",
      body: JSON.stringify(dunningBody),
      message: "Google denied access to the configured project",
      internalCode: undefined,
    },
    {
      label: "an ordinary permission denial",
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "Permission denied for the requested model.",
        },
      }),
      message: "Permission denied for the requested model.",
      internalCode: undefined,
    },
    {
      label: "context overflow",
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message:
            "The input token count (200) exceeds the maximum number of tokens allowed (100).",
        },
      }),
      message: "The input token count",
      internalCode: ArchestraInternalErrorCode.ContextLengthExceeded,
    },
  ])(`returns a readable error for $label (stream: ${stream})`, async ({
    status,
    contentType,
    body,
    message,
    internalCode,
  }, { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey }) => {
    const { agent, value } = await makeGeminiRouterKey({
      makeOrganization,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
    });

    let upstreamCalls = 0;
    server.use(
      http.post(`${BASE_URL}/v1beta/models/:operation`, () => {
        upstreamCalls++;
        return new HttpResponse(body, {
          status,
          headers: { "content-type": contentType },
        });
      }),
    );
    const app = createFastifyInstance();
    await app.register(modelRouterProxyRoutes);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/model-router/${agent.id}/responses`,
        headers: {
          authorization: `Bearer ${value}`,
          "user-agent": "test-client",
        },
        payload: { model: `gemini:${MODEL}`, input: "Hello", stream },
      });

      expect(response.statusCode, response.body).toBe(status);
      expect(response.json().error.message).toContain(message);
      expect(response.json().error.message).not.toContain('{"error"');
      expect(response.json().error.internal_code).toBe(internalCode);
      expect(upstreamCalls).toBe(1);
    } finally {
      await app.close();
    }
  });
}

test("a Responses stream that fails mid-way ends the response the client opened", async ({
  makeOrganization,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const { agent, value } = await makeGeminiRouterKey({
    makeOrganization,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  });
  server.use(
    // The connection drops after the first chunk.
    http.post(`${BASE_URL}/v1beta/models/:operation`, () => {
      let chunkSent = false;
      return new HttpResponse(
        new ReadableStream({
          async pull(controller) {
            if (chunkSent) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              controller.error(new Error("socket hang up"));
              return;
            }
            chunkSent = true;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  candidates: [
                    {
                      index: 0,
                      content: {
                        role: "model",
                        parts: [{ text: "Working on it" }],
                      },
                    },
                  ],
                })}\n\n`,
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const app = createFastifyInstance();
  await app.register(modelRouterProxyRoutes);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/model-router/${agent.id}/responses`,
      headers: {
        authorization: `Bearer ${value}`,
        "user-agent": "test-client",
      },
      payload: { model: `gemini:${MODEL}`, input: "Hello", stream: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    const events = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map(
        (line) =>
          JSON.parse(line.slice("data: ".length)) as {
            type: string;
            response?: { id: string; model?: string };
          },
      );
    const created = events.find((event) => event.type === "response.created");
    const failed = events.filter((event) => event.type === "response.failed");
    expect(created?.response?.id).toMatch(/^resp_/);
    // Clients match the terminal to the response they opened, not to the
    // provider's own chat id behind the translation.
    expect(failed).toHaveLength(1);
    expect(failed[0].response).toMatchObject({
      id: created?.response?.id,
      model: created?.response?.model,
    });
  } finally {
    await app.close();
  }
});

/** A Model Router virtual key for one Gemini model at the scripted upstream. */
async function makeGeminiRouterKey(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeAgent: (overrides: {
    organizationId: string;
    agentType: "llm_proxy";
  }) => Promise<{ id: string }>;
  makeSecret: (overrides: {
    secret: Record<string, string>;
  }) => Promise<{ id: string }>;
  makeLlmProviderApiKey: (
    organizationId: string,
    secretId: string,
    overrides: { provider: "gemini" },
  ) => Promise<{ id: string }>;
}) {
  config.llm.gemini.vertexAi.enabled = false;
  config.llm.gemini.baseUrl = BASE_URL;
  const organization = await fixtures.makeOrganization();
  const agent = await fixtures.makeAgent({
    organizationId: organization.id,
    agentType: "llm_proxy",
  });
  const model = await ModelModel.upsert({
    externalId: `gemini/${MODEL}`,
    provider: "gemini",
    modelId: MODEL,
    inputModalities: ["text"],
    outputModalities: ["text"],
    lastSyncedAt: new Date(),
  });
  const secret = await fixtures.makeSecret({
    secret: { apiKey: "test-gemini-key" },
  });
  const key = await fixtures.makeLlmProviderApiKey(organization.id, secret.id, {
    provider: "gemini",
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  const { value } = await VirtualApiKeyModel.create({
    organizationId: organization.id,
    name: "Gemini error test",
    providerApiKeys: [{ provider: "gemini", providerApiKeyId: key.id }],
  });
  return { agent, value };
}
