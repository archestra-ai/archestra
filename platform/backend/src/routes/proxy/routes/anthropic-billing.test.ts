import { sql } from "drizzle-orm";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import db from "@/database";
import LimitModel from "@/models/limit";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import anthropicProxyRoutes from "./anthropic";

// biome-ignore lint/correctness/useHookAtTopLevel: Registers Vitest HTTP-boundary lifecycle hooks.
const server = useMswServer();
const executor = "claude-haiku-4-5-20251001";
const advisor = "claude-opus-4-8";
const finalUsage = {
  input_tokens: 1760,
  output_tokens: 531,
  cache_read_input_tokens: 412,
  cache_creation_input_tokens: 0,
  iterations: [
    { type: "message", input_tokens: 412, output_tokens: 89 },
    {
      type: "advisor_message",
      model: advisor,
      input_tokens: 100_000,
      output_tokens: 100_000,
    },
    {
      type: "message",
      input_tokens: 1348,
      output_tokens: 442,
      cache_read_input_tokens: 412,
    },
  ],
};
const providerResponse = {
  id: "msg_advisory_review",
  type: "message",
  role: "assistant",
  model: executor,
  content: [{ type: "text", text: "Reviewed." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: finalUsage,
};

for (const [stream, large, truncated, settlementFails] of [
  [false, false, false, false],
  [true, false, false, false],
  [false, true, false, false],
  [true, false, true, false],
  [false, true, true, false],
  [true, false, false, true],
  [true, false, true, true],
]) {
  test(`settles advisor usage before completing and blocks next request (stream=${stream}, large=${large}, truncated=${truncated}, settlementFails=${settlementFails})`, async ({
    makeOrganization,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    config.llmProxy.usageAccountingMode = "enforce";
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const secret = await makeSecret({ secret: { apiKey: "sk-review-test" } });
    const parent = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
    });
    const { virtualKey, value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Advisory review",
      providerApiKeys: [{ provider: "anthropic", providerApiKeyId: parent.id }],
    });
    for (const model of [executor, advisor]) {
      await ModelModel.create({
        externalId: `anthropic/${model}`,
        provider: "anthropic",
        modelId: model,
        inputModalities: ["text"],
        outputModalities: ["text"],
        customPricePerMillionInput: model === advisor ? "5" : "1",
        customPricePerMillionOutput: model === advisor ? "25" : "5",
      });
    }
    const limit = await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: truncated ? 100 : 1,
      model: null,
      lastCleanup: new Date(),
    });
    let upstreamCalls = 0;
    const respond = async ({ request }: { request: Request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(JSON.stringify(body.tools)).toContain("advisor_20260301");
      expect(request.headers.get("anthropic-beta")).toContain(
        "advisor-tool-2026-03-01",
      );
      upstreamCalls++;
      // Configuration changes after admission cannot change this request's mode.
      config.llmProxy.usageAccountingMode = "off";
      if (!stream && !large) return HttpResponse.json(providerResponse);
      const events = [
        {
          type: "message_start",
          message: {
            ...providerResponse,
            content: [],
            usage: { input_tokens: 412, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Reviewed." },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: finalUsage,
        },
        { type: "message_stop" },
      ];
      if (truncated) events.pop();
      return new HttpResponse(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    server.use(http.post("https://api.anthropic.com/v1/messages", respond));
    if (stream || large)
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
        respond({ request: new Request(input, init) }),
      );
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(anthropicProxyRoutes);
    if (settlementFails)
      await db.execute(
        sql`ALTER TABLE interaction_billing ADD CONSTRAINT reject_test_settlement CHECK (false)`,
      );
    try {
      const send = () =>
        app.inject({
          method: "POST",
          url: `/v1/anthropic/${agent.id}/v1/messages`,
          headers: {
            authorization: `Bearer ${value}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "advisor-tool-2026-03-01",
          },
          payload: {
            model: executor,
            max_tokens: large ? 32_000 : 4096,
            stream,
            messages: [{ role: "user", content: "Review the plan." }],
            tools: [
              { type: "advisor_20260301", name: "advisor", model: advisor },
            ],
          },
        });
      const first = await send();
      if (settlementFails) {
        expect(first.statusCode).toBe(200);
        expect(first.body).toContain("event: error");
        expect(first.body).toContain("Unable to settle LLM usage");
        expect(first.body).not.toContain("event: message_stop");
        expect(
          (await LimitModel.getModelUsageBreakdowns([limit.id])).get(limit.id),
        ).toEqual([]);
        return;
      }
      expect(first.statusCode, first.body).toBe(truncated && large ? 502 : 200);
      if (truncated && stream) {
        expect(first.body).toContain("event: error");
        expect(first.body).not.toContain("event: message_stop");
      }
      const rows =
        (await LimitModel.getModelUsageBreakdowns([limit.id])).get(limit.id) ??
        [];
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.model === advisor)?.cost).toBe(3);
      expect(rows.find((row) => row.model === executor)?.tokensIn).toBe(1760);
      const second = await send();
      expect(second.statusCode, second.body).toBe(402);
      expect(upstreamCalls).toBe(1);
      await drainBackgroundWork();
    } finally {
      if (settlementFails)
        await db.execute(
          sql`ALTER TABLE interaction_billing DROP CONSTRAINT reject_test_settlement`,
        );
      await app.close();
    }
  });
}
