import { generateText } from "ai";
import { onTestFinished, vi } from "vitest";
import config from "@/config";
import {
  collectDelegationMarkers,
  mintDelegationMarker,
  stripDelegationMarkers,
} from "@/openappa/delegation";
import { requireDelegatedChildSession } from "@/proxy/plugins/appa-plugin-archestra/adapters/in-process-executor";
import { beforeEach, expect, test } from "@/test";
import { createLLMModelForAgent } from "./llm-client";

beforeEach(() => {
  const previous = config.openappa.offerSigningSecret;
  onTestFinished(() => {
    config.openappa.offerSigningSecret = previous;
  });
});

test.for([
  "anthropic",
  "openai",
  "ollama",
  "perplexity",
] as const)("%s repair preserves its original user turn without repeating the delegated task", async (provider, {
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const agent = await makeAgent({ organizationId: org.id });
  const secret = await makeSecret({ secret: { apiKey: "test-provider-key" } });
  const key = await makeLlmProviderApiKey(org.id, secret.id, {
    provider,
    access: "org",
  });
  config.openappa.offerSigningSecret =
    "repair-spawn-proof-test-secret-0123456789";
  const callerId = `user:${user.id}`;
  const parentId = "parent-session";
  const spawnCallId = "delegation-call";
  const delegatedTask = "Do the original delegated task exactly once.";
  const exactChildText = " \n<think>admitted text</think> result \n";
  const marker = mintDelegationMarker({
    organizationId: org.id,
    callerId,
    parentId,
    spawnerNativeId: parentId,
    spawnCallId,
    prompt: delegatedTask,
  });
  if (!marker) throw new Error("expected opening spawn marker");
  const requests: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const family =
        provider === "anthropic"
          ? "anthropic:messages"
          : url.endsWith("/responses")
            ? "openai:responses"
            : "openai:chatCompletions";
      const body = JSON.parse(String(init?.body));
      const markers = collectDelegationMarkers({ family, body });
      expect(markers).toHaveLength(1);
      expect(
        requireDelegatedChildSession({
          organizationId: org.id,
          callerId,
          markers,
          receipts: [],
          claimedSessionId: `${parentId}:${spawnCallId}`,
          claimedParentId: parentId,
        }),
      ).toEqual({ sessionId: `${parentId}:${spawnCallId}`, parentId });
      stripDelegationMarkers({ family, body });
      requests.push(body);
      if (provider === "anthropic")
        return Response.json({
          id: "msg_repair",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "repaired" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      if (family === "openai:responses")
        return Response.json({
          id: "resp_repair",
          object: "response",
          created_at: 1,
          model: "gpt-4o",
          status: "completed",
          output: [
            {
              id: "msg_repair",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "repaired", annotations: [] },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      return Response.json({
        id: "chat_repair",
        object: "chat.completion",
        created: 1,
        model: "repair-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: provider === "perplexity" ? exactChildText : "repaired",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }),
  );
  const result = await createLLMModelForAgent({
    organizationId: org.id,
    userId: user.id,
    agentId: agent.id,
    provider,
    model:
      provider === "anthropic"
        ? "claude-sonnet-4-5"
        : provider === "openai"
          ? "gpt-4o"
          : provider === "perplexity"
            ? "sonar-reasoning-pro"
            : "llama3.2",
    agentLlmApiKeyId: key.id,
    appaParentId: parentId,
    appaSessionId: `${parentId}:${spawnCallId}`,
    delegationProof: `${delegatedTask}\n\n${marker}`,
    source: "a2a:tool_call_repair",
  });
  const repairText = "Repair only the malformed tool arguments.";
  expect(
    (
      await generateText({
        model: result.model,
        messages: [{ role: "user", content: repairText }],
        maxRetries: 0,
      })
    ).text,
  ).toBe(provider === "perplexity" ? exactChildText : "repaired");
  expect(requests).toHaveLength(1);
  const request = requests[0] as { messages?: unknown[]; input?: unknown[] };
  expect(request.messages ?? request.input).toHaveLength(1);
  expect(JSON.stringify(request)).toContain(repairText);
  expect(JSON.stringify(request)).not.toContain(delegatedTask);
  expect(JSON.stringify(request)).not.toContain("[appa]");
});

test("a repair cannot rebind a spawn proof from another caller", async ({
  makeOrganization,
  makeUser,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id });
  config.openappa.offerSigningSecret =
    "repair-spawn-proof-test-secret-0123456789";
  const marker = mintDelegationMarker({
    organizationId: org.id,
    callerId: "user:other",
    parentId: "parent",
    spawnerNativeId: "parent",
    spawnCallId: "spawn",
    prompt: "task",
  });
  await expect(
    createLLMModelForAgent({
      organizationId: org.id,
      userId: user.id,
      agentId: agent.id,
      provider: "ollama",
      model: "llama3.2",
      appaParentId: "parent",
      appaSessionId: "parent:spawn",
      delegationProof: `task\n\n${marker}`,
    }),
  ).rejects.toThrow("verified spawn proof");
});
