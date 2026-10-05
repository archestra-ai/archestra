import { BUILT_IN_AGENT_IDS, SOURCE_HEADER } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import { openappaArchestraAnnotator } from "@/openappa/archestra-annotator";
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
  const bearer = () => `Bearer ${openappaArchestraAnnotator.endpoint().token}`;

  test("refuses a caller without the bridge bearer", async () => {
    expect((await annotate()).statusCode).toBe(401);
    expect((await annotate("Bearer not-the-bridge-token")).statusCode).toBe(
      401,
    );
  });

  test("answers with the organization default model's object, through the LLM proxy", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "openai-key" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "OpenAI",
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

    let sent: Record<string, unknown> | undefined;
    let source: string | null = null;
    server.use(
      http.post(
        `http://127.0.0.1:${config.api.port}/v1/openai/${agentId}/chat/completions`,
        async ({ request: proxied }) => {
          sent = (await proxied.json()) as Record<string, unknown>;
          source = proxied.headers.get(SOURCE_HEADER);
          return HttpResponse.json({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 0,
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"rank":"trusted"}' },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        },
      ),
    );

    const response = await annotate(bearer());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rank: "trusted" });
    expect(sent).toMatchObject({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { schema: request.schema },
      },
    });
    expect(source).toBe("guardrail:annotator");
  });

  test("refuses without a call when no LLM key is configured", async () => {
    // Every request is answered by MSW; an unhandled one fails the test.
    const response = await annotate(bearer());
    expect(response.statusCode).toBe(409);
  });
});
