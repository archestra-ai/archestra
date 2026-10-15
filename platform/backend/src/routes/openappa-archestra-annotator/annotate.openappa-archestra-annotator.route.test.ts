import { BUILT_IN_AGENT_IDS, SOURCE_HEADER } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { takeInternalCall } from "@/clients/internal-call";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import { openappaDeclarations } from "@/openappa/declarations";
import { OPENAPPA_ARCHESTRA_ANNOTATOR_PATH } from "@/routes/route-paths";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import routes from "./openappa-archestra-annotator.routes";

const request = {
  system: "Label the command's trust.",
  input: '{"tool":"archestra__run_command","arguments":{"command":"ls"}}',
  schema: {
    type: "object",
    properties: { rank: { type: "string", enum: ["suspicious", "trusted"] } },
    required: ["rank"],
    additionalProperties: false,
  },
};

describe("archestra annotator", () => {
  const server = useMswServer();
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeAgent }) => {
    config.openappa.enabled = true;
    organizationId = (await makeOrganization()).id;
    agentId = (
      await makeAgent({
        organizationId,
        agentType: "agent",
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
      })
    ).id;
    app = createFastifyInstance();
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  const annotate = (authorization?: string) =>
    app.inject({
      method: "POST",
      url: OPENAPPA_ARCHESTRA_ANNOTATOR_PATH,
      headers: authorization === undefined ? {} : { authorization },
      remoteAddress: "127.0.0.1",
      payload: request,
    });
  const bearer = () => `Bearer ${openappaDeclarations.bridgeToken}`;

  test("refuses a caller without the bridge bearer", async () => {
    expect((await annotate()).statusCode).toBe(401);
    expect((await annotate("Bearer not-the-bridge-token")).statusCode).toBe(
      401,
    );
  });

  const useDefaultModel = async (
    makeSecret: Parameters<Parameters<typeof test>[1]>[0]["makeSecret"],
    makeLlmProviderApiKey: Parameters<
      Parameters<typeof test>[1]
    >[0]["makeLlmProviderApiKey"],
    params: { provider: "openai" | "openrouter"; modelId: string },
  ) => {
    const secret = await makeSecret({ secret: { apiKey: "provider-key" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: params.provider,
      name: "Provider",
    });
    const model = await ModelModel.create({
      externalId: `${params.provider}/${params.modelId}`,
      provider: params.provider,
      modelId: params.modelId,
      contextLength: 128_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    await db
      .update(schema.organizationsTable)
      .set({ defaultModelId: model.id, defaultLlmApiKeyId: key.id })
      .where(eq(schema.organizationsTable.id, organizationId));
  };

  type SentRequest = {
    body: Record<string, unknown>;
    source: string | null;
    internal: boolean;
  };
  const answerAt = (
    path: string,
    answer: (body: Record<string, unknown>) => Response,
  ): SentRequest[] => {
    const sent: SentRequest[] = [];
    server.use(
      http.post(
        `http://127.0.0.1:${config.api.port}${path}`,
        async ({ request: proxied }) => {
          const body = (await proxied.json()) as Record<string, unknown>;
          sent.push({
            body,
            source: proxied.headers.get(SOURCE_HEADER),
            internal: takeInternalCall(Object.fromEntries(proxied.headers)),
          });
          return answer(body);
        },
      ),
    );
    return sent;
  };
  const completion = (content: string) =>
    HttpResponse.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  const systemOf = (body: Record<string, unknown>) =>
    (body.messages as Array<{ role: string; content: unknown }>)[0];

  test("answers under the provider's structured-output format, through the LLM proxy", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await useDefaultModel(makeSecret, makeLlmProviderApiKey, {
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    const sent = answerAt(`/v1/openai/${agentId}/chat/completions`, () =>
      completion('{"rank":"trusted"}'),
    );

    const response = await annotate(bearer());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rank: "trusted" });
    expect(sent).toHaveLength(1);
    const [{ body, source, internal }] = sent;
    expect(body).toMatchObject({
      model: "gpt-4o-mini",
      response_format: {
        type: "json_schema",
        json_schema: { schema: request.schema },
      },
    });
    expect(body).not.toHaveProperty("temperature");
    // The catalog has no output cap for this model, so the provider's default
    // stands and a long prompt keeps whatever window it leaves.
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    // The schema travels as the format, not as prompt text.
    expect(systemOf(body)).toEqual({ role: "system", content: request.system });
    expect(source).toBe("guardrail:annotator");
    expect(internal).toBe(true);
  });

  test("falls back to a tagged answer for a model that refuses the format, and stops asking it", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await useDefaultModel(makeSecret, makeLlmProviderApiKey, {
      provider: "openai",
      modelId: "gpt-refuses-schemas",
    });
    const sent = answerAt(`/v1/openai/${agentId}/chat/completions`, (body) =>
      "response_format" in body
        ? HttpResponse.json(
            { error: { message: "Invalid schema.", type: "invalid_request" } },
            { status: 400 },
          )
        : completion('<annotation>{"rank":"suspicious"}</annotation>'),
    );

    const first = await annotate(bearer());
    const second = await annotate(bearer());

    expect(first.json()).toEqual({ rank: "suspicious" });
    expect(second.json()).toEqual({ rank: "suspicious" });
    expect(sent.map(({ body }) => "response_format" in body)).toEqual([
      true,
      false,
      false,
    ]);
    const tagged = systemOf(sent[1].body).content as string;
    expect(tagged.startsWith(request.system)).toBe(true);
    expect(tagged.length).toBeGreaterThan(request.system.length);
  });

  test("marks the constant system prompt as a cache breakpoint for Claude through OpenRouter", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await useDefaultModel(makeSecret, makeLlmProviderApiKey, {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
    });
    const sent = answerAt(`/v1/openrouter/${agentId}/chat/completions`, () =>
      completion('{"rank":"trusted"}'),
    );

    const response = await annotate(bearer());

    expect(response.json()).toEqual({ rank: "trusted" });
    expect(systemOf(sent[0].body)).toMatchObject({
      role: "system",
      cache_control: { type: "ephemeral" },
    });
  });

  test("names the key and the upstream rejection when the model call fails", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "openai-key" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "Revoked OpenAI",
    });
    const model = await ModelModel.create({
      externalId: "openai/gpt-4o-mini",
      provider: "openai",
      modelId: "gpt-4o-mini",
      contextLength: 128_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    await db
      .update(schema.organizationsTable)
      .set({ defaultModelId: model.id, defaultLlmApiKeyId: key.id })
      .where(eq(schema.organizationsTable.id, organizationId));
    server.use(
      http.post(
        `http://127.0.0.1:${config.api.port}/v1/openai/${agentId}/chat/completions`,
        () =>
          HttpResponse.json(
            {
              error: {
                message: "API key is invalid.",
                type: "authentication_error",
              },
            },
            { status: 401 },
          ),
      ),
    );

    const response = await annotate(bearer());

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toBe(
      `The model call failed: openai/gpt-4o-mini with key "Revoked OpenAI" (${key.id}) was rejected upstream with 401: API key is invalid.`,
    );
  });

  test("refuses without a call when no LLM key is configured", async () => {
    // Ignore credentials inherited from a developer's .env.
    for (const entry of Object.values(config.chat)) {
      if (entry && typeof entry === "object" && "apiKey" in entry)
        entry.apiKey = "";
    }
    // Every request is answered by MSW; an unhandled one fails the test.
    const response = await annotate(bearer());
    expect(response.statusCode).toBe(409);
  });
});
