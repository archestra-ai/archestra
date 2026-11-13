import { createServer, type Server } from "node:http";
import type { ModelMessage } from "ai";
import { createLLMModel } from "@/clients/llm-client";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ModelModel from "@/models/model";
import bedrockProxyRoutes from "@/routes/proxy/routes/bedrock";
import { afterEach, expect, test } from "@/test";
import { promptCacheUpstreamResponse } from "@/test/llm-prompt-cache-upstream";
import { runAgentStream } from "./agent-run-stream";

let app: FastifyInstanceWithZod | undefined;
let upstream: Server | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await new Promise<void>((resolve, reject) => {
    if (!upstream) return resolve();
    upstream.close((error) => (error ? reject(error) : resolve()));
  });
  upstream = undefined;
});

// Fault injection is limited to the provider socket. The stream recovery,
// AI SDK serialization, running HTTP proxy and Bedrock adapter stay real.
for (const scenario of [
  {
    direction: "GPT to Claude",
    target: "anthropic.test-claude",
    reasoning: {
      text: "",
      providerOptions: { bedrock: { redactedContent: "cnNuX3N5bnRoZXRpYw==" } },
    },
    error:
      "The model returned the following errors: messages.1.content.0: Invalid `data` in `redacted_thinking` block",
    expectedReasoning: { redactedContent: "cnNuX3N5bnRoZXRpYw==" },
  },
  {
    direction: "Claude to GPT",
    target: "openai.test-gpt",
    reasoning: {
      text: "thinking",
      providerOptions: { bedrock: { signature: "synthetic-signature" } },
    },
    error:
      "This model doesn't support the reasoningContent.reasoningText.text field for assistant messages. Remove reasoningContent.reasoningText.text and try again.",
    expectedReasoning: {
      reasoningText: { text: "thinking", signature: "synthetic-signature" },
    },
  },
]) {
  for (const rejectReasoning of [true, false]) {
    test(`${scenario.direction}: ${rejectReasoning ? "rejected reasoning recovers" : "accepted reasoning is preserved"} through the running proxy`, async ({
      makeAgent,
      makeUser,
      makeMember,
    }) => {
      const user = await makeUser();
      const agent = await makeAgent({ authorId: user.id });
      await makeMember(user.id, agent.organizationId, { role: "admin" });
      await ModelModel.upsert({
        externalId: `bedrock/${scenario.target}`,
        provider: "bedrock",
        modelId: scenario.target,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });
      const requests: Array<{
        messages: Array<{
          role: string;
          content: Array<Record<string, unknown>>;
        }>;
      }> = [];
      upstream = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        requests.push(payload);
        if (
          rejectReasoning &&
          payload.messages.some(
            (message: { content: Array<Record<string, unknown>> }) =>
              message.content.some((part) => part.reasoningContent),
          )
        ) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: scenario.error }));
          return;
        }
        const success = promptCacheUpstreamResponse({
          provider: "bedrock",
          api: "converse",
          model: scenario.target,
          stream: true,
          reads: 0,
          writes: 0,
        });
        response.writeHead(200, {
          "content-type": "application/vnd.amazon.eventstream",
        });
        response.end(Buffer.from(await success.arrayBuffer()));
      });
      await new Promise<void>((resolve) =>
        upstream?.listen(0, "127.0.0.1", resolve),
      );
      const upstreamAddress = upstream.address();
      if (!upstreamAddress || typeof upstreamAddress === "string")
        throw new Error("Missing upstream port");
      app = createFastifyInstance();
      await app.register(bedrockProxyRoutes);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing app port");
      config.api.port = address.port;
      const model = createLLMModel({
        provider: "bedrock",
        modelName: scenario.target,
        agentId: agent.id,
        userId: user.id,
        apiKey: "synthetic-bedrock-key",
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      });
      const messages: ModelMessage[] = [
        { role: "user", content: "Remember the color blue." },
        {
          role: "assistant",
          content: [
            { type: "reasoning", ...scenario.reasoning },
            { type: "text", text: "Blue remembered." },
          ],
        },
        { role: "user", content: "Continue." },
      ];
      const originalMessages = structuredClone(messages);
      const { result, getCapturedStreamError } = await runAgentStream({
        config: { model, messages, maxOutputTokens: 64, maxRetries: 0 },
      });
      await result.consumeStream();
      expect(requests).toHaveLength(rejectReasoning ? 2 : 1);
      expect(requests[0].messages[1].content[0]).toEqual({
        reasoningContent: scenario.expectedReasoning,
      });
      if (rejectReasoning)
        expect(requests[1]).toEqual({
          ...requests[0],
          messages: requests[0].messages.map((message) => ({
            ...message,
            content: message.content.filter((part) => !part.reasoningContent),
          })),
        });
      expect(await result.text).toBe("answer");
      expect(getCapturedStreamError()).toBeUndefined();
      expect(messages).toEqual(originalMessages);
    });
  }
}
