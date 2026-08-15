/**
 * Reranker verification against a real (MSW-backed) OpenAI-compatible endpoint,
 * exercising `createDirectLLMModel` + `generateObject` end to end rather than
 * mocking them — these are the cases where a self-hosted chat model answers
 * with something other than the bare JSON object.
 */
import { HttpResponse, http } from "msw";
import { LlmProviderApiKeyModel } from "@/models";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { knowledgeSettingsService } from "./knowledge-settings";

const BASE_URL = "https://vllm.test/v1";
const MODEL = "qwen3-27b";

describe("validateRerankerConfig structured output", () => {
  const server = useMswServer();

  /** Bodies the endpoint received, so the request shape can be asserted. */
  let requests: Array<Record<string, unknown>>;

  const serveContent = (content: string) => {
    requests = [];
    server.use(
      http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
        requests.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }),
    );
  };

  const makeKeylessVllmKey = async (organizationId: string) =>
    // vLLM deployments usually run without auth, so the key carries no secret.
    LlmProviderApiKeyModel.create({
      organizationId,
      name: "vLLM",
      provider: "vllm",
      baseUrl: BASE_URL,
      scope: "org",
      userId: null,
    });

  test("verifies a model whose reply wraps the object in reasoning tokens and a markdown fence", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = await makeKeylessVllmKey(org.id);
    // A Qwen3-class model on an endpoint started without a reasoning parser:
    // the chain of thought stays in `content`, and the object arrives fenced.
    serveContent(
      "<think>\nThe passage restates the query, so it scores high.\n</think>\n\n" +
        'Here are the scores:\n\n```json\n{"scores": [{"index": 0, "score": 9}]}\n```',
    );

    const result = await knowledgeSettingsService.validateRerankerConfig({
      keyId: key.id,
      model: MODEL,
      organizationId: org.id,
    });

    expect(result).toEqual({ ok: true });
  });

  test("asks the endpoint to constrain decoding to the score schema", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = await makeKeylessVllmKey(org.id);
    serveContent('{"scores":[{"index":0,"score":9}]}');

    await knowledgeSettingsService.validateRerankerConfig({
      keyId: key.id,
      model: MODEL,
      organizationId: org.id,
    });

    // A schema-less `json_object` leaves the model to guess the shape; vLLM
    // compiles `json_schema` into a decoding grammar instead.
    expect(requests[0]?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        schema: { properties: { scores: { type: "array" } } },
      },
    });
    // The prompt states the shape too, for endpoints that ignore the schema.
    const messages = requests[0]?.messages as Array<{ content: string }>;
    expect(messages[0]?.content).toContain(
      '{"scores":[{"index":0,"score":7}]}',
    );
  });

  test("explains an unparsable reply instead of surfacing the raw SDK error", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = await makeKeylessVllmKey(org.id);
    serveContent("I need more context before I can score these passages.");

    const result = await knowledgeSettingsService.validateRerankerConfig({
      keyId: key.id,
      model: MODEL,
      organizationId: org.id,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("guided/structured decoding");
    expect(result.error).not.toContain("No object generated");
    // The reply itself is quoted so the cause is diagnosable from the UI.
    expect(result.error).toContain("I need more context");
  });
});
