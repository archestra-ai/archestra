// Pins the addon-unavailable contract at the adapter level for every adapter
// cut over to the native TOON kernel: when the helper fails open (resolves to
// null), the adapter leaves the messages untouched — the same object, not
// just structurally equal — and reports the explicit `addon_unavailable` skip
// reason with zeroed totals, never stats fabricated from a transform that did
// not run. Each case also pins the batching contract: the helper is called
// EXACTLY once per request with the full candidate batch. (The OpenAI
// adapter's handler-level counterpart lives in
// routes/toon-addon-unavailable.test.ts.)

import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import type { ToolCompressionStats } from "@/types";
import { toonEncodeToolResults } from "../utils/toon-native";
import { anthropicAdapterFactory } from "./anthropic";
import { bedrockAdapterFactory } from "./bedrock";
import { cohereAdapterFactory } from "./cohere";
import { geminiAdapterFactory } from "./gemini";
import { minimaxAdapterFactory } from "./minimax";
import { zhipuaiAdapterFactory } from "./zhipuai";

// The native addon is unavailable: the helper fails open by resolving to null.
vi.mock("@/routes/proxy/utils/toon-native", () => ({
  toonEncodeToolResults: vi.fn(),
  initToonNative: vi.fn(),
}));

const TOOL_RESULT_JSON_A = JSON.stringify({
  files: [{ name: "README.md" }, { name: "src" }],
});
const TOOL_RESULT_JSON_B = JSON.stringify({ config: { debug: true } });

const EXPECTED_STATS: ToolCompressionStats = {
  tokensBefore: 0,
  tokensAfter: 0,
  costSavings: 0,
  wasEffective: false,
  hadToolResults: true,
  skipReason: "addon_unavailable",
};

function expectSingleBatchCall(
  expectedItems: { id: string; rawContent: string; unwrap: boolean }[],
  beforeSource?: "raw" | "normalized",
) {
  expect(vi.mocked(toonEncodeToolResults)).toHaveBeenCalledTimes(1);
  // Anthropic and Bedrock keep their own tokenizer and call with one argument;
  // the tiktoken-family adapters request native counting with a before-source.
  if (beforeSource === undefined) {
    expect(vi.mocked(toonEncodeToolResults)).toHaveBeenCalledWith(
      expectedItems,
    );
  } else {
    expect(vi.mocked(toonEncodeToolResults)).toHaveBeenCalledWith(
      expectedItems,
      beforeSource,
    );
  }
}

describe("adapters with the TOON addon unavailable", () => {
  beforeEach(() => {
    vi.mocked(toonEncodeToolResults).mockReset().mockResolvedValue(null);
  });

  test("anthropic: one batched call, same messages object, addon_unavailable stats", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "toolu_1",
            content: TOOL_RESULT_JSON_A,
          },
          {
            type: "tool_result" as const,
            tool_use_id: "toolu_2",
            content: [{ type: "text" as const, text: TOOL_RESULT_JSON_B }],
          },
        ],
      },
    ];
    const adapter = anthropicAdapterFactory.createRequestAdapter({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages,
    });
    const stats = await adapter.applyToonCompression("claude-sonnet-4-5");

    expectSingleBatchCall([
      { id: "toolu_1", rawContent: TOOL_RESULT_JSON_A, unwrap: true },
      { id: "toolu_2", rawContent: TOOL_RESULT_JSON_B, unwrap: true },
    ]);
    expect(stats).toStrictEqual(EXPECTED_STATS);
    expect(adapter.getProviderMessages()).toBe(messages);
  });

  test("gemini: one batched call, same contents object, addon_unavailable stats", async () => {
    const responseA = JSON.parse(TOOL_RESULT_JSON_A);
    const responseB = JSON.parse(TOOL_RESULT_JSON_B);
    const contents = [
      {
        role: "user",
        parts: [
          { functionResponse: { name: "list_files", response: responseA } },
          { functionResponse: { name: "read_config", response: responseB } },
        ],
      },
    ];
    const adapter = geminiAdapterFactory.createRequestAdapter({ contents });
    const stats = await adapter.applyToonCompression("gemini-2.0-flash");

    expectSingleBatchCall(
      [
        { id: "list_files", rawContent: TOOL_RESULT_JSON_A, unwrap: true },
        { id: "read_config", rawContent: TOOL_RESULT_JSON_B, unwrap: true },
      ],
      "raw",
    );
    expect(stats).toStrictEqual(EXPECTED_STATS);
    expect(adapter.getProviderMessages()).toBe(contents);
  });

  test("bedrock: one batched call, same messages object, addon_unavailable stats", async () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            toolResult: {
              toolUseId: "tooluse_1",
              content: [{ text: TOOL_RESULT_JSON_A }],
            },
          },
          {
            toolResult: {
              toolUseId: "tooluse_2",
              content: [{ json: JSON.parse(TOOL_RESULT_JSON_B) }],
            },
          },
        ],
      },
    ];
    const adapter = bedrockAdapterFactory.createRequestAdapter({
      modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      messages,
    });
    const stats = await adapter.applyToonCompression(
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
    );

    expectSingleBatchCall([
      { id: "tooluse_1", rawContent: TOOL_RESULT_JSON_A, unwrap: false },
      { id: "tooluse_2", rawContent: TOOL_RESULT_JSON_B, unwrap: false },
    ]);
    expect(stats).toStrictEqual(EXPECTED_STATS);
    expect(adapter.getProviderMessages()).toBe(messages);
  });

  test("zhipuai: one batched call, same messages object, addon_unavailable stats", async () => {
    const messages = [
      {
        role: "tool" as const,
        tool_call_id: "call_1",
        content: TOOL_RESULT_JSON_A,
      },
      {
        role: "tool" as const,
        tool_call_id: "call_2",
        content: TOOL_RESULT_JSON_B,
      },
    ];
    const adapter = zhipuaiAdapterFactory.createRequestAdapter({
      model: "glm-4.6",
      messages,
    });
    const stats = await adapter.applyToonCompression("glm-4.6");

    expectSingleBatchCall(
      [
        { id: "call_1", rawContent: TOOL_RESULT_JSON_A, unwrap: true },
        { id: "call_2", rawContent: TOOL_RESULT_JSON_B, unwrap: true },
      ],
      "normalized",
    );
    expect(stats).toStrictEqual(EXPECTED_STATS);
    expect(adapter.getProviderMessages()).toBe(messages);
  });

  test("minimax: one batched call, same messages object, addon_unavailable stats", async () => {
    const messages = [
      {
        role: "tool" as const,
        tool_call_id: "call_1",
        content: TOOL_RESULT_JSON_A,
      },
      {
        role: "tool" as const,
        tool_call_id: "call_2",
        content: TOOL_RESULT_JSON_B,
      },
    ];
    const adapter = minimaxAdapterFactory.createRequestAdapter({
      model: "MiniMax-M2",
      messages,
    });
    const stats = await adapter.applyToonCompression("MiniMax-M2");

    expectSingleBatchCall(
      [
        { id: "call_1", rawContent: TOOL_RESULT_JSON_A, unwrap: true },
        { id: "call_2", rawContent: TOOL_RESULT_JSON_B, unwrap: true },
      ],
      "normalized",
    );
    expect(stats).toStrictEqual(EXPECTED_STATS);
    expect(adapter.getProviderMessages()).toBe(messages);
  });

  test("cohere: one batched call, same messages object, addon_unavailable stats", async () => {
    const messages = [
      {
        role: "tool" as const,
        tool_call_id: "call_1",
        content: TOOL_RESULT_JSON_A,
      },
      {
        role: "tool" as const,
        tool_call_id: "call_2",
        content: TOOL_RESULT_JSON_B,
      },
    ];
    const adapter = cohereAdapterFactory.createRequestAdapter({
      model: "command-r-plus",
      messages,
    });
    const stats = await adapter.applyToonCompression("command-r-plus");

    expectSingleBatchCall(
      [
        { id: "call_1", rawContent: TOOL_RESULT_JSON_A, unwrap: true },
        { id: "call_2", rawContent: TOOL_RESULT_JSON_B, unwrap: true },
      ],
      "normalized",
    );
    expect(stats).toStrictEqual(EXPECTED_STATS);
    expect(adapter.getProviderMessages()).toBe(messages);
  });
});
