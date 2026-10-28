import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { accessGrants, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./model-router";

// biome-ignore lint/correctness/useHookAtTopLevel: lifecycle helper
const server = useMswServer();
const marker = { type: "ephemeral" };
const breakpoint = { mode: "explicit" };
const tool = {
  name: "lookup",
  parameters: {
    type: "object",
    properties: { cache_control: { type: "string" } },
  },
};

for (const api of ["chat", "responses"] as const) {
  for (const stream of [false, true]) {
    for (const withAgent of [false, true]) {
      test(`Cohere ${api}, stream=${stream}, agent=${withAgent}: reject unsupported cache extensions before HTTP`, async ({
        makeOrganization,
        makeAgent,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const origin = "https://cohere.cache.example.test";
        config.llm.cohere.baseUrl = origin;
        const org = await makeOrganization();
        const agent = await makeAgent({
          organizationId: org.id,
          agentType: "agent",
        });
        const model = await ModelModel.create({
          externalId: "cohere/command-r-plus-08-2024",
          provider: "cohere",
          modelId: "command-r-plus-08-2024",
          inputModalities: ["text"],
          outputModalities: ["text"],
        });
        const secret = await makeSecret({
          secret: { apiKey: "test-cache-key" },
        });
        const key = await makeLlmProviderApiKey(org.id, secret.id, {
          provider: "cohere",
          baseUrl: origin,
        });
        await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
          model.id,
        ]);
        const virtual = await VirtualApiKeyModel.create({
          organizationId: org.id,
          name: "Cache test",
          ...accessGrants("org"),
          providerApiKeys: [{ provider: "cohere", providerApiKeyId: key.id }],
        });
        let calls = 0;
        const respond = async (request: Request) => {
          expect(request.url).toBe(`${origin}/v2/chat`);
          await request.json();
          calls++;
          const usage = { tokens: { input_tokens: 10, output_tokens: 5 } };
          if (!stream)
            return HttpResponse.json({
              id: "cohere_cache_test",
              model: model.modelId,
              message: {
                role: "assistant",
                content: [{ type: "text", text: "answer" }],
              },
              finish_reason: "COMPLETE",
              usage,
            });
          return new HttpResponse(
            [
              { type: "message-start" },
              {
                type: "content-delta",
                delta: {
                  message: { content: { text: "answer" } },
                },
              },
              {
                type: "message-end",
                delta: { finish_reason: "COMPLETE", usage },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        };
        server.use(
          http.post(`${origin}/v2/chat`, ({ request }) => respond(request)),
        );
        if (stream)
          vi.stubGlobal(
            "fetch",
            (input: RequestInfo | URL, init?: RequestInit) =>
              respond(new Request(input, init)),
          );
        const inputField = api === "chat" ? "messages" : "input";
        const textType = api === "chat" ? "text" : "input_text";
        const message = (fields = {}, partFields = {}) => ({
          role: "user",
          ...fields,
          content: [{ type: textType, text: "question", ...partFields }],
        });
        const functionTool = (fields = {}, inner = {}) =>
          api === "responses"
            ? { type: "function", ...tool, ...fields }
            : { type: "function", function: { ...tool, ...inner }, ...fields };
        const payload = {
          model: "cohere:command-r-plus-08-2024",
          stream,
          [inputField]: [message()],
          tools: [functionTool()],
        };
        const url = `/v1/model-router${withAgent ? `/${agent.id}` : ""}/${api === "chat" ? "chat/completions" : "responses"}`;
        const app = createFastifyInstance();
        await app.register(modelRouterRoutes);
        const send = (changes: Record<string, unknown>) =>
          app.inject({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${virtual.value}` },
            payload: { ...payload, ...changes },
          });
        try {
          const valid = await send({});
          expect(valid.statusCode, valid.body).toBe(200);
          expect(valid.body).toContain("answer");
          expect(calls).toBe(1);
          const cases: Array<{
            field: string;
            changes: Record<string, unknown>;
          }> = [
            { field: "cache_control", changes: { cache_control: marker } },
            {
              field: "cachedContent",
              changes: { cachedContent: "cachedContents/unsupported" },
            },
            {
              field: "prompt_cache_key",
              changes: { prompt_cache_key: "prefix" },
            },
            {
              field: "prompt_cache_retention",
              changes: { prompt_cache_retention: "24h" },
            },
            {
              field: "prompt_cache_options",
              changes: { prompt_cache_options: { mode: "explicit" } },
            },
            {
              field: "cache_control",
              changes: { [inputField]: [message({ cache_control: marker })] },
            },
            {
              field: "cache_control",
              changes: {
                [inputField]: [message({}, { cache_control: marker })],
              },
            },
            {
              field: "prompt_cache_breakpoint",
              changes: {
                [inputField]: [
                  message({}, { prompt_cache_breakpoint: breakpoint }),
                ],
              },
            },
            {
              field: "cache_control",
              changes: { tools: [functionTool({ cache_control: marker })] },
            },
          ];
          if (api === "chat")
            cases.push({
              field: "cache_control",
              changes: { tools: [functionTool({}, { cache_control: marker })] },
            });
          else
            for (const [field, value] of [
              ["cache_control", marker],
              ["prompt_cache_breakpoint", breakpoint],
            ] as const)
              cases.push({
                field,
                changes: {
                  input: [
                    {
                      type: "function_call",
                      call_id: "call_cache",
                      name: tool.name,
                      arguments: "{}",
                    },
                    {
                      type: "function_call_output",
                      call_id: "call_cache",
                      output: [
                        { type: "input_text", text: "result", [field]: value },
                      ],
                    },
                  ],
                },
              });
          for (const { field, changes } of cases) {
            const invalid = await send(changes);
            expect(invalid.statusCode, invalid.body).toBe(400);
            expect(invalid.body).toContain(field);
            expect(calls).toBe(1);
          }
        } finally {
          await app.close();
        }
      });
    }
  }
}
