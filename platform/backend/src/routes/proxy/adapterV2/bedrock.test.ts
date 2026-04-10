import { describe, expect, test } from "@/test";
import type { Bedrock } from "@/types";
import { bedrockAdapterFactory, getCommandInput } from "./bedrock";

function createConverseRequest(
  options?: Partial<Bedrock.Types.ConverseRequest>,
): Bedrock.Types.ConverseRequest {
  return {
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [{ role: "user", content: [{ text: "Hello" }] }],
    ...options,
  };
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
});
