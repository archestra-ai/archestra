import { onTestFinished, vi } from "vitest";
import config from "@/config";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import { mintDelegationMarker } from "@/openappa/delegation";
import { expect, test } from "@/test";
import { executeA2AMessage } from "./a2a-executor";

test("governed child text reaches the parent without thinking or whitespace rewriting after admission", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const previous = {
    enabled: config.openappa.enabled,
    secret: config.openappa.offerSigningSecret,
  };
  onTestFinished(() => {
    config.openappa.enabled = previous.enabled;
    config.openappa.offerSigningSecret = previous.secret;
  });
  config.openappa.enabled = true;
  config.openappa.offerSigningSecret =
    "exact-child-byte-fixture-signing-secret-0123456789";
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  const secret = await makeSecret({ secret: { apiKey: "fake-upstream-key" } });
  const key = await makeLlmProviderApiKey(org.id, secret.id, {
    provider: "openai",
  });
  const model = await ModelModel.create({
    externalId: "openai/exact-child",
    provider: "openai",
    modelId: "gpt-4o",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  const agent = await makeAgent({
    organizationId: org.id,
    agentType: "agent",
    authorId: user.id,
    modelId: model.id,
    llmApiKeyId: key.id,
  });
  const parentId = "parent";
  const callId = "child-call";
  const task = "Return the admitted text exactly.";
  const marker = mintDelegationMarker({
    organizationId: org.id,
    callerId: `user:${user.id}`,
    parentId,
    spawnerNativeId: parentId,
    spawnCallId: callId,
    prompt: task,
  });
  if (!marker) throw new Error("Expected opening proof");
  const exact =
    " \n<thinking>Text already admitted at ChildEnd</thinking> answer \n";
  // This is the proxy network boundary: its text was already admitted. No
  // model, executor, native helper, DB, or provider SDK implementation is mocked.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (request?.method) {
        if (request.id === undefined)
          return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  serverInfo: { name: "fixture-gateway", version: "1" },
                }
              : { tools: [], resources: [], prompts: [] },
        });
      }
      const chunk = {
        id: "exact-child",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        created: 1,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: exact },
            finish_reason: null,
          },
        ],
      };
      const finish = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const result = await executeA2AMessage({
    agentId: agent.id,
    organizationId: org.id,
    userId: user.id,
    message: `${task}\n\n${marker}`,
    sessionId: "logging-root",
    appaParentSessionId: parentId,
    parentDelegationChain: "parent-agent",
    delegationToolCallId: callId,
  });
  expect(result.text).toBe(exact);
  expect(
    result.responseUiMessage.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  ).toBe(exact);
});
