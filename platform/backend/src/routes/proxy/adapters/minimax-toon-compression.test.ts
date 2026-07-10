// Pins the MiniMax adapter's TOON compression cutover to the native addon:
// full transformed-messages exact equality (TOON content from the committed
// v3 golden corpus, everything else byte-equal). MiniMax-specific semantics
// pinned here: compression is applied UNCONDITIONALLY (no keep/reject —
// encoded tokens are always recorded, even when TOON is larger). Requires the
// built addon: mandatory in CI; locally it skips visibly — run
// `pnpm test:native` from platform/backend.

import { expect, test } from "@/test";
import {
  corpusEntry,
  describeNative,
  makeCountTokens,
  makeToolCall,
  upsertOneDollarPerTokenPricing,
} from "@/test/toon-golden";
import type { Minimax } from "@/types/llm-providers";
import { minimaxAdapterFactory } from "./minimax";

type MinimaxRequest = Minimax.Types.ChatCompletionsRequest;

// Corpus picks: a uniform array (TOON smaller), a wrapped [{type:"text",...}]
// payload (unwrapped, TOON smaller), malformed JSON (kept as-is), and a
// heterogeneous array whose TOON encoding is LARGER under the MiniMax
// tokenizer — MiniMax still applies it (unconditional apply).
const UNIFORM = corpusEntry("provider-matrix-tool-result");
const WRAPPED = corpusEntry("wrapped-single-text");
const MALFORMED = corpusEntry("malformed-prose");
const LARGER = corpusEntry("boundary-hetero-arr-1");

const countTokens = makeCountTokens("minimax");
const upsertPricing = () =>
  upsertOneDollarPerTokenPricing({
    provider: "minimax",
    modelId: "MiniMax-M2",
  });

describeNative("MiniMax adapter TOON compression (native addon)", () => {
  test("transforms the full messages exactly (goldens for TOON, byte-equal elsewhere)", async () => {
    await upsertPricing();

    const makeRequest = (): MinimaxRequest => ({
      model: "MiniMax-M2",
      temperature: 0.25,
      messages: [
        { role: "system", content: "You are a filesystem assistant." },
        { role: "user", content: "What files are in the current directory?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            makeToolCall("call_uniform", "list_files"),
            makeToolCall("call_wrapped", "read_wrapped"),
            makeToolCall("call_malformed", "read_notes"),
            makeToolCall("call_larger", "read_config"),
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_uniform",
          content: UNIFORM.rawContent,
        },
        {
          role: "tool",
          tool_call_id: "call_wrapped",
          content: WRAPPED.rawContent,
        },
        {
          role: "tool",
          tool_call_id: "call_malformed",
          content: MALFORMED.rawContent,
        },
        {
          role: "tool",
          tool_call_id: "call_larger",
          content: LARGER.rawContent,
        },
      ],
    });

    const adapter = minimaxAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("MiniMax-M2");

    // UNCONDITIONAL apply: every parseable result is replaced — including
    // the one whose TOON encoding is larger. Only malformed content is kept.
    const expectedMessages = makeRequest().messages;
    expectedMessages[3] = {
      role: "tool",
      tool_call_id: "call_uniform",
      content: UNIFORM.expected.encoded as string,
    };
    expectedMessages[4] = {
      role: "tool",
      tool_call_id: "call_wrapped",
      content: WRAPPED.expected.encoded as string,
    };
    expectedMessages[6] = {
      role: "tool",
      tool_call_id: "call_larger",
      content: LARGER.expected.encoded as string,
    };
    expect(adapter.getProviderMessages()).toStrictEqual(expectedMessages);

    // Encoded tokens are always recorded, larger or not; malformed content
    // is not counted at all.
    const tokensBefore =
      countTokens(UNIFORM.expected.normalized) +
      countTokens(WRAPPED.expected.normalized) +
      countTokens(LARGER.expected.normalized);
    const tokensAfter =
      countTokens(UNIFORM.expected.encoded as string) +
      countTokens(WRAPPED.expected.encoded as string) +
      countTokens(LARGER.expected.encoded as string);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: Math.max(0, tokensBefore - tokensAfter),
      wasEffective: tokensAfter < tokensBefore,
      hadToolResults: true,
    });
  });

  test("applies native results to the right candidates when non-string tool messages are interleaved", async () => {
    await upsertPricing();

    // Non-string (array-content) tool messages are NOT candidates for the
    // native batch: the native result index diverges from both the message
    // index and the tool-message index — off-by-one positional application
    // would compress the wrong message and fail the equality below.
    const makeRequest = (): MinimaxRequest => ({
      model: "MiniMax-M2",
      messages: [
        { role: "user", content: "Inspect the workspace." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            makeToolCall("call_a", "read_notes"),
            makeToolCall("call_block", "read_chunks"),
            makeToolCall("call_b", "list_files"),
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_a",
          content: MALFORMED.rawContent,
        },
        {
          role: "tool",
          tool_call_id: "call_block",
          content: [{ type: "text", text: "chunk one" }],
        },
        {
          role: "tool",
          tool_call_id: "call_b",
          content: UNIFORM.rawContent,
        },
      ],
    });

    const adapter = minimaxAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("MiniMax-M2");

    // Only B compresses; A is malformed and the array-content message is
    // untouched.
    const expectedMessages = makeRequest().messages;
    expectedMessages[4] = {
      role: "tool",
      tool_call_id: "call_b",
      content: UNIFORM.expected.encoded as string,
    };
    expect(adapter.getProviderMessages()).toStrictEqual(expectedMessages);

    const tokensBefore = countTokens(UNIFORM.expected.normalized);
    const tokensAfter = countTokens(UNIFORM.expected.encoded as string);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: tokensBefore - tokensAfter,
      wasEffective: true,
      hadToolResults: true,
    });
  });

  // The two cases the combined request cannot isolate.
  test("a lone malformed result: zeroed stats (hadToolResults=false), message untouched", async () => {
    await upsertPricing();

    const adapter = minimaxAdapterFactory.createRequestAdapter({
      model: "MiniMax-M2",
      messages: [
        { role: "user", content: "run the tool" },
        { role: "tool", tool_call_id: "call_1", content: MALFORMED.rawContent },
      ],
    });
    const stats = await adapter.applyToonCompression("MiniMax-M2");

    expect(stats).toStrictEqual({
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: false,
    });
    const [, toolMessage] = adapter.getProviderMessages();
    expect(toolMessage).toStrictEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: MALFORMED.rawContent,
    });
  });

  test("unconditional apply: a lone larger encoding is still applied, wasEffective=false", async () => {
    await upsertPricing();

    const adapter = minimaxAdapterFactory.createRequestAdapter({
      model: "MiniMax-M2",
      messages: [
        { role: "user", content: "run the tool" },
        { role: "tool", tool_call_id: "call_1", content: LARGER.rawContent },
      ],
    });
    const stats = await adapter.applyToonCompression("MiniMax-M2");

    const tokensBefore = countTokens(LARGER.expected.normalized);
    const tokensAfter = countTokens(LARGER.expected.encoded as string);
    expect(tokensAfter).toBeGreaterThan(tokensBefore);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: true,
    });
    const [, toolMessage] = adapter.getProviderMessages();
    expect(toolMessage).toStrictEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: LARGER.expected.encoded as string,
    });
  });
});
