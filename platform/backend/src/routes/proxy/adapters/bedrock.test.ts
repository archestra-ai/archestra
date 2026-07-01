import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { describe, expect, test } from "@/test";
import { Bedrock } from "@/types";
import { bedrockAdapterFactory, getCommandInput } from "./bedrock";

const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

function createConverseRequest(
  options?: Partial<Bedrock.Types.ConverseRequest>,
): Bedrock.Types.ConverseRequest {
  return {
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [{ role: "user", content: [{ text: "Hello" }] }],
    ...options,
  };
}

function decodeEventStreamJson(bytes: Uint8Array): {
  headers: Record<string, { value?: unknown }>;
  body: Record<string, unknown>;
} {
  const decoded = eventStreamCodec.decode(bytes);
  const bodyText =
    typeof decoded.body === "string" ? decoded.body : toUtf8(decoded.body);

  return {
    headers: decoded.headers as Record<string, { value?: unknown }>,
    body: JSON.parse(bodyText) as Record<string, unknown>,
  };
}

function asStreamChunk<T>(chunk: unknown): T {
  return chunk as T;
}

describe("Bedrock tool name encoding", () => {
  test("shortens provider-facing tool names that exceed the Bedrock limit", () => {
    const toolName =
      "splunk_olly_preprod_mcp__olly_get_apm_service_errors_and_requests";
    const request = createConverseRequest({
      messages: [
        { role: "user", content: [{ text: "Get service errors" }] },
        {
          role: "assistant",
          content: [
            {
              toolUse: {
                toolUseId: "tooluse_123",
                name: toolName,
                input: { service: "checkout" },
              },
            },
          ],
        },
      ],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: toolName,
              description: "Get APM service errors and requests",
              inputSchema: { json: { type: "object" } },
            },
          },
        ],
        toolChoice: { tool: { name: toolName } },
      },
    });

    const commandInput = getCommandInput(request);
    const providerToolName =
      commandInput.toolConfig?.tools?.[0]?.toolSpec?.name ?? "";
    const toolChoice = commandInput.toolConfig?.toolChoice as
      | { tool?: { name?: string } }
      | undefined;
    const providerToolChoiceName = toolChoice?.tool?.name ?? "";
    const providerHistoryToolName =
      commandInput.messages?.[1]?.content?.[0] &&
      "toolUse" in commandInput.messages[1].content[0]
        ? commandInput.messages[1].content[0].toolUse.name
        : "";

    expect(toolName.length).toBeGreaterThan(64);
    expect(providerToolName).toHaveLength(64);
    expect(providerToolName).not.toBe(toolName);
    expect(providerToolChoiceName).toBe(providerToolName);
    expect(providerHistoryToolName).toBe(providerToolName);
  });

  test("decodes shortened Bedrock tool call names back to the original name", async () => {
    const toolName =
      "splunk_olly_preprod_mcp__olly_get_apm_service_errors_and_requests";
    const request = createConverseRequest({
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: toolName,
              description: "Get APM service errors and requests",
              inputSchema: { json: { type: "object" } },
            },
          },
        ],
      },
    });
    const commandInput = getCommandInput(request);
    const providerToolName =
      commandInput.toolConfig?.tools?.[0]?.toolSpec?.name ?? "";
    const client = {
      converse: async () => ({
        $metadata: { requestId: "req_123" },
        output: {
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: "tooluse_123",
                  name: providerToolName,
                  input: { service: "checkout" },
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };

    const response = await bedrockAdapterFactory.execute(client, request);
    const adapter = bedrockAdapterFactory.createResponseAdapter(response);

    expect(adapter.getToolCalls()).toEqual([
      {
        id: "tooluse_123",
        name: toolName,
        arguments: { service: "checkout" },
      },
    ]);
  });

  test("continues to encode hyphens for Nova provider-facing tool names", () => {
    const request = createConverseRequest({
      modelId: "amazon.nova-lite-v1:0",
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "my-server__read-file",
              inputSchema: { json: { type: "object" } },
            },
          },
        ],
      },
    });

    const commandInput = getCommandInput(request);

    expect(commandInput.toolConfig?.tools?.[0]?.toolSpec?.name).toBe(
      "my_server__read_file",
    );
  });

  test("keeps Nova hyphen-normalized tool names unique", () => {
    const request = createConverseRequest({
      modelId: "amazon.nova-lite-v1:0",
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "server__read-file",
              inputSchema: { json: { type: "object" } },
            },
          },
          {
            toolSpec: {
              name: "server__read_file",
              inputSchema: { json: { type: "object" } },
            },
          },
        ],
      },
    });

    const commandInput = getCommandInput(request);
    const providerToolNames =
      commandInput.toolConfig?.tools?.map((tool) => tool.toolSpec?.name) ?? [];

    expect(providerToolNames).toHaveLength(2);
    expect(new Set(providerToolNames).size).toBe(2);
    expect(providerToolNames[0]).toBe("server__read_file");
    expect(providerToolNames[1]).toMatch(/^server__read_file_[a-f0-9]{8}$/);
  });

  test("sanitizes provider-facing document names for Bedrock validation", () => {
    const request = createConverseRequest({
      messages: [
        {
          role: "user",
          content: [
            {
              document: {
                format: "pdf",
                name: "customer_report.v2__final!!  copy.pdf",
                source: { bytes: "ZmFrZQ==" },
              },
            },
          ],
        },
      ],
    });

    const commandInput = getCommandInput(request);
    const documentBlock = commandInput.messages?.[0]?.content?.[0];
    const documentName =
      documentBlock && "document" in documentBlock
        ? documentBlock.document.name
        : "";

    expect(documentName).toBe("customer report v2 final copy pdf");
  });

  test("sanitizes document names nested in tool results", () => {
    const request = createConverseRequest({
      messages: [
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "tooluse_123",
                content: [
                  {
                    document: {
                      format: "txt",
                      name: "..__",
                      source: { bytes: "ZmFrZQ==" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const commandInput = getCommandInput(request);
    const toolResultBlock = commandInput.messages?.[0]?.content?.[0];
    const toolResultContent =
      toolResultBlock && "toolResult" in toolResultBlock
        ? toolResultBlock.toolResult.content
        : [];
    const documentBlock = toolResultContent?.[0];
    const documentName =
      documentBlock && "document" in documentBlock
        ? documentBlock.document.name
        : "";

    expect(documentName).toBe("Document");
  });

  test("re-encodes streamed tool call events with the original tool name", () => {
    const toolName =
      "splunk_olly_preprod_mcp__olly_get_apm_service_errors_and_requests";
    const request = createConverseRequest({
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: toolName,
              description: "Get APM service errors and requests",
              inputSchema: { json: { type: "object" } },
            },
          },
        ],
      },
    });
    const commandInput = getCommandInput(request);
    const providerToolName =
      commandInput.toolConfig?.tools?.[0]?.toolSpec?.name ?? "";
    const adapter = bedrockAdapterFactory.createStreamAdapter(request);

    adapter.processChunk(
      asStreamChunk<Parameters<typeof adapter.processChunk>[0]>({
        contentBlockStart: {
          contentBlockIndex: 0,
          start: {
            toolUse: {
              toolUseId: "tooluse_123",
              name: providerToolName,
            },
          },
        },
      }),
    );
    adapter.processChunk(
      asStreamChunk<Parameters<typeof adapter.processChunk>[0]>({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: {
            toolUse: {
              input: '{"service":"checkout"}',
            },
          },
        },
      }),
    );
    adapter.processChunk(
      asStreamChunk<Parameters<typeof adapter.processChunk>[0]>({
        contentBlockStop: {
          contentBlockIndex: 0,
        },
      }),
    );
    adapter.processChunk(
      asStreamChunk<Parameters<typeof adapter.processChunk>[0]>({
        messageStop: {
          stopReason: "tool_use",
        },
      }),
    );
    adapter.processChunk(
      asStreamChunk<Parameters<typeof adapter.processChunk>[0]>({
        metadata: {
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      }),
    );

    expect(adapter.state.toolCalls[0]).toEqual({
      id: "tooluse_123",
      name: toolName,
      arguments: '{"service":"checkout"}',
    });

    const rawEvents = adapter.getRawToolCallEvents();
    const decodedStartEvent = decodeEventStreamJson(rawEvents[0] as Uint8Array);

    expect(decodedStartEvent.headers[":event-type"]?.value).toBe(
      "contentBlockStart",
    );
    expect(decodedStartEvent.body).toMatchObject({
      contentBlockIndex: 0,
      start: {
        toolUse: {
          toolUseId: "tooluse_123",
          name: toolName,
        },
      },
    });
  });
});

describe("Bedrock client creation", () => {
  test("uses the custom base URL override", () => {
    const customBaseUrl =
      "https://bedrock-runtime.ap-southeast-1.amazonaws.com/custom-path";
    const client = bedrockAdapterFactory.createClient("test-key", {
      baseUrl: customBaseUrl,
      source: "chat",
    }) as unknown as {
      config: { baseUrl: string };
    };

    expect(client.config.baseUrl).toBe(customBaseUrl);
  });
});

describe("Bedrock getUsage", () => {
  test("sums the 1h portion from the cacheDetails per-TTL breakdown", () => {
    const response = {
      output: { message: { role: "assistant", content: [{ text: "hi" }] } },
      stopReason: "end_turn",
      usage: {
        inputTokens: 5,
        outputTokens: 10,
        cacheReadInputTokens: 2000,
        cacheWriteInputTokens: 1000,
        cacheDetails: [
          { ttl: "1h", inputTokens: 400 },
          { ttl: "5m", inputTokens: 600 },
        ],
      },
    } as unknown as Bedrock.Types.ConverseResponse;

    const adapter = bedrockAdapterFactory.createResponseAdapter(response);

    expect(adapter.getUsage()).toEqual({
      inputTokens: 5,
      outputTokens: 10,
      cacheReadTokens: 2000,
      cacheWriteTokens: 1000,
      cacheWrite1hTokens: 400,
    });
  });

  test("preserves cache usage through execute() on the non-streaming path", async () => {
    const client = {
      converse: async () => ({
        $metadata: { requestId: "r" },
        output: { message: { role: "assistant", content: [{ text: "hi" }] } },
        stopReason: "end_turn",
        usage: {
          inputTokens: 5,
          outputTokens: 10,
          cacheReadInputTokens: 2000,
          cacheWriteInputTokens: 1000,
          cacheDetails: [
            { ttl: "1h", inputTokens: 400 },
            { ttl: "5m", inputTokens: 600 },
          ],
        },
      }),
    };

    const response = await bedrockAdapterFactory.execute(
      client,
      createConverseRequest(),
    );
    const adapter = bedrockAdapterFactory.createResponseAdapter(response);

    expect(adapter.getUsage()).toEqual({
      inputTokens: 5,
      outputTokens: 10,
      cacheReadTokens: 2000,
      cacheWriteTokens: 1000,
      cacheWrite1hTokens: 400,
    });
  });
});

describe("Bedrock system content validation (issue #3406)", () => {
  // Exact body @ai-sdk/amazon-bedrock emits for a Claude request with prompt
  // caching (as used by OpenCode): a system cachePoint breakpoint follows the
  // system text, landing at system[1]. Older Archestra validation rejected this
  // with "body/system/1 Invalid input"; it must now validate and pass through.
  test("accepts a cachePoint breakpoint in the system array", () => {
    const result = Bedrock.API.ConverseRequestSchema.safeParse({
      modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
      system: [
        { text: "You are a helpful assistant." },
        { cachePoint: { type: "default" } },
      ],
      messages: [{ role: "user", content: [{ text: "hi" }] }],
    });

    expect(result.success).toBe(true);
  });

  test("forwards the system cachePoint to Bedrock unchanged", () => {
    const request = createConverseRequest({
      system: [
        { text: "You are a helpful assistant." },
        { cachePoint: { type: "default" } },
      ],
    });

    const commandInput = getCommandInput(request);

    expect(commandInput.system).toEqual([
      { text: "You are a helpful assistant." },
      { cachePoint: { type: "default" } },
    ]);
  });

  test("normalizes Anthropic-style { type: 'text' } system blocks", () => {
    const request = createConverseRequest({
      system: [{ type: "text", text: "You are a helpful assistant." }] as never,
    });

    const commandInput = getCommandInput(request);

    expect(commandInput.system).toEqual([
      { text: "You are a helpful assistant." },
    ]);
  });

  // Forward-compat: an unmodeled but object-shaped Bedrock-native system block
  // must not 400 the whole request — AWS is the authoritative validator, so we
  // accept it and forward it untouched instead of rejecting future block types.
  test("accepts and passes through an unknown system block shape", () => {
    const futureBlock = { somethingBedrockAddsLater: { foo: "bar" } };
    const request = createConverseRequest({
      system: [{ text: "sys" }, futureBlock] as never,
    });

    const parsed = Bedrock.API.ConverseRequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);

    const commandInput = getCommandInput(request);
    expect(commandInput.system).toEqual([{ text: "sys" }, futureBlock]);
  });
});

describe("Bedrock reasoningContent message blocks (issue #3406)", () => {
  // With Claude extended thinking, @ai-sdk/amazon-bedrock echoes the prior
  // assistant reasoning back on the next turn as a reasoningContent block in the
  // assistant message content. Older validation had no case for it and 400'd
  // with "body/messages/N/content/M Invalid input"; it must now validate and
  // pass through to Bedrock unchanged.
  const reasoningBlock = {
    reasoningContent: {
      reasoningText: { text: "2 + 2 is 4.", signature: "ErUBCk...sig==" },
    },
  };

  test("accepts a reasoningText block in an assistant message", () => {
    const result = Bedrock.API.ConverseRequestSchema.safeParse({
      modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
      messages: [
        { role: "user", content: [{ text: "What is 2+2?" }] },
        { role: "assistant", content: [reasoningBlock, { text: "4" }] },
        { role: "user", content: [{ text: "And 3+3?" }] },
      ],
    });

    expect(result.success).toBe(true);
  });

  test("accepts a redactedReasoning block in an assistant message", () => {
    const result = Bedrock.API.ConverseRequestSchema.safeParse({
      modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
      messages: [
        { role: "user", content: [{ text: "hi" }] },
        {
          role: "assistant",
          content: [
            { reasoningContent: { redactedReasoning: { data: "abc123==" } } },
            { text: "hello" },
          ],
        },
        { role: "user", content: [{ text: "again" }] },
      ],
    });

    expect(result.success).toBe(true);
  });

  test("forwards the reasoningContent block to Bedrock unchanged", () => {
    const request = createConverseRequest({
      messages: [
        { role: "user", content: [{ text: "What is 2+2?" }] },
        {
          role: "assistant",
          content: [reasoningBlock, { text: "4" }],
        } as never,
        { role: "user", content: [{ text: "And 3+3?" }] },
      ],
    });

    const commandInput = getCommandInput(request);

    expect(commandInput.messages?.[1]?.content?.[0]).toEqual(reasoningBlock);
  });
});
