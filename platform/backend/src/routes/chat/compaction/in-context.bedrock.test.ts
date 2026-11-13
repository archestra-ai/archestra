import { createServer, type Server } from "node:http";
import { generateText, tool } from "ai";
import { z } from "zod";
import { createLLMModel } from "@/clients/llm-client";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ConversationCompactionModel from "@/models/conversation-compaction";
import ModelModel from "@/models/model";
import bedrockProxyRoutes from "@/routes/proxy/routes/bedrock";
import { afterEach, test as baseTest, expect, vi } from "@/test";
import type { TestFixtures } from "@/test/fixtures";
import type { ChatMessage } from "@/types";
import { buildModelMessages } from "../prepare-model-messages";
import { compactMessagesForChat } from "./compact-messages";
import { buildSummaryMessage } from "./history";
import { summarizeInContext } from "./in-context";

const MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const FACT = "The synthetic archive code is BLUE-731 and retention is 19 days.";
const HISTORY: ChatMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "Read the archive policy." }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "read_archive",
        toolCallId: "call-archive",
        state: "output-available",
        input: {},
        output: FACT,
      },
      { type: "step-start" },
      { type: "text", text: "I have the archive policy." },
    ],
  },
] as ChatMessage[];

type WireRequest = {
  system?: unknown;
  toolConfig?: unknown;
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
};
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

async function setup(
  fixtures: Pick<
    TestFixtures,
    | "makeAgent"
    | "makeUser"
    | "makeMember"
    | "makeSecret"
    | "makeLlmProviderApiKey"
    | "makeConversation"
  >,
) {
  const user = await fixtures.makeUser();
  const agent = await fixtures.makeAgent({ authorId: user.id });
  await fixtures.makeMember(user.id, agent.organizationId, { role: "admin" });
  const requests: WireRequest[] = [];
  const replies: Array<"summary" | "untagged" | "tool"> = [];
  upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body) as WireRequest;
    requests.push(payload);
    const reply = replies.shift() ?? "summary";
    const sawFact = JSON.stringify(payload.messages).includes(FACT);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        output: {
          message: {
            role: "assistant",
            content:
              reply === "tool"
                ? [
                    {
                      toolUse: {
                        toolUseId: "new-call",
                        name: "read_archive",
                        input: {},
                      },
                    },
                  ]
                : [
                    {
                      text:
                        reply === "untagged"
                          ? "No tags."
                          : `<summary>${sawFact ? FACT : "Missing archive facts."}</summary>`,
                    },
                  ],
          },
        },
        stopReason: reply === "tool" ? "tool_use" : "end_turn",
        usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream?.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw new Error("No upstream port");
  const baseUrl = `http://127.0.0.1:${upstreamAddress.port}`;
  const secret = await fixtures.makeSecret({
    secret: { apiKey: "synthetic-bedrock-key" },
  });
  const key = await fixtures.makeLlmProviderApiKey(
    agent.organizationId,
    secret.id,
    { provider: "bedrock", name: "Test Bedrock", baseUrl },
  );
  const modelRow = await ModelModel.create({
    externalId: `bedrock/${MODEL}`,
    provider: "bedrock",
    modelId: MODEL,
    contextLength: 200_000,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    ignored: false,
    lastSyncedAt: new Date(),
  });
  const conversation = await fixtures.makeConversation(agent.id, {
    userId: user.id,
    organizationId: agent.organizationId,
    modelId: modelRow.id,
    chatApiKeyId: key.id,
  });
  app = createFastifyInstance();
  await app.register(bedrockProxyRoutes);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No app port");
  config.api.port = address.port;
  const execute = vi.fn(async () => FACT);
  const onInputAvailable = vi.fn();
  const needsApproval = vi.fn(() => false);
  const tools = {
    read_archive: tool({
      description: "Read synthetic archive policy",
      inputSchema: z.object({}),
      execute,
      onInputAvailable,
      needsApproval,
    }),
  };
  const params = {
    conversationId: conversation.id,
    organizationId: agent.organizationId,
    userId: user.id,
    agentId: agent.id,
    provider: "bedrock" as const,
    selectedModel: MODEL,
    agentLlmApiKeyId: key.id,
    previousSummary: null as string | null,
    compactableMessages: HISTORY,
    systemPrompt: "Summarize synthetic archive facts accurately.",
    tools,
  };
  const model = createLLMModel({
    provider: "bedrock",
    modelName: MODEL,
    agentId: agent.id,
    userId: user.id,
    apiKey: "synthetic-bedrock-key",
    baseUrl,
    source: "chat",
  });
  return {
    params,
    model,
    requests,
    replies,
    execute,
    onInputAvailable,
    needsApproval,
    modelRow,
  };
}

const test = baseTest.extend<{ scenario: Awaited<ReturnType<typeof setup>> }>({
  scenario: async (
    {
      makeAgent,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeConversation,
    },
    use,
  ) => {
    await use(
      await setup({
        makeAgent,
        makeUser,
        makeMember,
        makeSecret,
        makeLlmProviderApiKey,
        makeConversation,
      }),
    );
  },
});

// This runs the real normalization, compactor, AI SDK and HTTP proxy. The
// upstream only observes wire requests and injects response shapes: it cannot
// establish real provider cache hits, which require separate live proof.
test("compaction retains ordinary chat's tool/history cache prefix, including a prior summary", async ({
  scenario: s,
}) => {
  for (const previousSummary of [null, "Keep the synthetic migration plan."]) {
    s.params.previousSummary = previousSummary;
    const history = [
      ...(previousSummary ? [buildSummaryMessage(previousSummary)] : []),
      ...HISTORY,
    ];
    const ordinary = await buildModelMessages({
      ...s.params,
      messages: history,
      disableCompaction: true,
      emit: () => {},
    });
    await generateText({
      model: s.model,
      tools: s.params.tools,
      system: s.params.systemPrompt,
      messages: ordinary.modelMessages,
    });
    const summary = await summarizeInContext(s.params);
    expect(summary).toBe(FACT);
    const [control, compact] = s.requests.slice(-2);
    expect(compact.toolConfig).toEqual(control.toolConfig);
    expect(compact.system).toEqual(control.system);
    expect(compact.messages.slice(0, control.messages.length)).toEqual(
      control.messages,
    );
    expect(JSON.stringify(compact.messages)).toContain("toolUse");
    expect(JSON.stringify(compact.messages)).toContain("toolResult");
    expect(JSON.stringify(compact.messages)).toContain(FACT);
    expect(control.messages.at(-1)?.content.at(-1)).toHaveProperty(
      "cachePoint",
    );
    expect(compact.messages.at(-1)?.content).not.toEqual(
      control.messages.at(-1)?.content,
    );
  }
  expect(s.execute).not.toHaveBeenCalled();
  expect(s.onInputAvailable).not.toHaveBeenCalled();
  expect(s.needsApproval).not.toHaveBeenCalled();
  expect(s.params.tools.read_archive.execute).toBe(s.execute);
});

test("compaction never executes tools or their callbacks even if the provider asks", async ({
  scenario: s,
}) => {
  s.replies.push("tool");
  expect(await summarizeInContext(s.params)).toBeNull();
  expect(s.requests).toHaveLength(1);
  expect(s.execute).not.toHaveBeenCalled();
  expect(s.onInputAvailable).not.toHaveBeenCalled();
  expect(s.needsApproval).not.toHaveBeenCalled();
});

test("an SDK warning about dropped tool history cannot produce a successful summary", async ({
  scenario: s,
}) => {
  expect(
    await summarizeInContext({ ...s.params, tools: undefined }),
  ).toBeNull();
  expect(s.requests).toHaveLength(1);
  expect(JSON.stringify(s.requests[0])).not.toContain(FACT);
});

test("correction retry preserves the same cached tool history", async ({
  scenario: s,
}) => {
  s.replies.push("untagged", "summary");
  expect(await summarizeInContext(s.params)).toBe(FACT);
  expect(s.requests).toHaveLength(2);
  expect(s.requests[1].toolConfig).toEqual(s.requests[0].toolConfig);
  expect(
    s.requests[1].messages.slice(0, s.requests[0].messages.length),
  ).toEqual(s.requests[0].messages);
  expect(s.execute).not.toHaveBeenCalled();
});

test("compaction does not expose provider-executed tools to the summarizer", async ({
  scenario: s,
}) => {
  expect(
    await summarizeInContext({
      ...s.params,
      tools: {
        hosted: {
          type: "provider",
          id: "test.hosted",
          args: {},
          inputSchema: z.object({}),
        },
      },
    }),
  ).toBeNull();
  expect(s.requests).toHaveLength(0);
});

test("automatic compaction persists tool facts and prepares a new cached history", async ({
  scenario: s,
}) => {
  await ModelModel.update(s.modelRow.id, { customContextLength: 2000 });
  const history: ChatMessage[] = [
    HISTORY[0],
    {
      ...HISTORY[1],
      parts: [
        {
          type: "dynamic-tool",
          toolName: "read_archive",
          toolCallId: "call-archive",
          state: "output-available",
          input: {},
          output: `${FACT} ${"Synthetic archive background. ".repeat(1500)}`,
        },
        { type: "step-start" },
        { type: "text", text: "The archive policy is available." },
      ],
    } as ChatMessage,
    {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "Continue with this policy." }],
    },
  ];
  const compacted = await compactMessagesForChat({
    ...s.params,
    modelId: s.modelRow.id,
    messages: history,
    trigger: "auto",
  });
  expect(compacted.status).toBe("created");
  expect(compacted.compaction?.summary).toBe(FACT);
  expect(s.requests).toHaveLength(1);
  expect(s.execute).not.toHaveBeenCalled();
  expect(
    (
      await ConversationCompactionModel.findLatestByConversation(
        s.params.conversationId,
      )
    )?.summary,
  ).toBe(FACT);
  const next = await buildModelMessages({
    ...s.params,
    messages: history,
    emit: () => {},
  });
  await generateText({
    model: s.model,
    tools: s.params.tools,
    system: s.params.systemPrompt,
    messages: next.modelMessages,
  });
  expect(JSON.stringify(s.requests.at(-1)?.messages)).toContain(FACT);
  expect(JSON.stringify(s.requests.at(-1)?.messages)).not.toContain(
    "Synthetic archive background.",
  );
  expect(JSON.stringify(s.requests.at(-1)?.messages)).toContain("cachePoint");
});

test("a trailing user turn retains its cache checkpoint before the merged summary instruction", async ({
  scenario: s,
}) => {
  const history: ChatMessage[] = [
    ...HISTORY,
    {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "Keep the archive code." }],
    },
  ];
  const ordinary = await buildModelMessages({
    ...s.params,
    messages: history,
    disableCompaction: true,
    emit: () => {},
  });
  await generateText({
    model: s.model,
    tools: s.params.tools,
    system: s.params.systemPrompt,
    messages: ordinary.modelMessages,
  });
  expect(
    await summarizeInContext({ ...s.params, compactableMessages: history }),
  ).toBe(FACT);
  const [control, compact] = s.requests;
  expect(compact.system).toEqual(control.system);
  expect(compact.toolConfig).toEqual(control.toolConfig);
  const prefix = control.messages.flatMap((message) => message.content);
  expect(
    compact.messages
      .flatMap((message) => message.content)
      .slice(0, prefix.length),
  ).toEqual(prefix);
  expect(prefix.at(-1)).toHaveProperty("cachePoint");
});
