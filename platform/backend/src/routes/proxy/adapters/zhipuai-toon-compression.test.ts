// Pins the ZhipuAI adapter's TOON compression cutover to the native addon:
// full transformed-request exact equality (TOON content from the committed v3
// golden corpus, everything else byte-equal) plus the accounting semantics
// the combined request cannot isolate (hadToolResults=false when nothing was
// parseable; a lone rejected payload counted in BOTH totals — the
// OpenAI-family rule). Requires the built addon: mandatory in CI; locally it
// skips visibly — run `pnpm test:native` from platform/backend.

import { expect, test } from "@/test";
import {
  corpusEntry,
  describeNative,
  makeCountTokens,
  makeToolCall,
  upsertOneDollarPerTokenPricing,
} from "@/test/toon-golden";
import type { Zhipuai } from "@/types";
import { zhipuaiAdapterFactory } from "./zhipuai";

type ZhipuaiRequest = Zhipuai.Types.ChatCompletionsRequest;

// Corpus picks: a uniform array (compression wins), a wrapped
// [{type:"text",...}] payload (unwrapped, compression wins), malformed JSON
// (kept as-is), and a near-boundary object whose TOON encoding does not save
// tokens under the ZhipuAI tokenizer (rejected).
const UNIFORM = corpusEntry("provider-matrix-tool-result");
const WRAPPED = corpusEntry("wrapped-single-text");
const MALFORMED = corpusEntry("malformed-prose");
const NEAR_BOUNDARY = corpusEntry("boundary-obj-1");

const countTokens = makeCountTokens("zhipuai");
const upsertPricing = () =>
  upsertOneDollarPerTokenPricing({ provider: "zhipuai", modelId: "glm-4.6" });

describeNative("ZhipuAI adapter TOON compression (native addon)", () => {
  test("transforms the full provider request exactly (goldens for TOON, byte-equal elsewhere)", async () => {
    await upsertPricing();

    const makeRequest = (): ZhipuaiRequest => ({
      model: "glm-4.6",
      temperature: 0.25,
      messages: [
        { role: "system", content: "You are a filesystem assistant." },
        { role: "user", content: "What files are in the current directory?" },
        {
          role: "assistant",
          tool_calls: [
            makeToolCall("call_uniform", "list_files"),
            makeToolCall("call_wrapped", "read_wrapped"),
            makeToolCall("call_malformed", "read_notes"),
            makeToolCall("call_boundary", "read_config"),
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
          tool_call_id: "call_boundary",
          content: NEAR_BOUNDARY.rawContent,
        },
      ],
    });

    const adapter = zhipuaiAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("glm-4.6");

    const expectedRequest = makeRequest();
    // Compression wins for the uniform array and the wrapped payload; the
    // malformed and near-boundary results keep their original content.
    expectedRequest.messages[3] = {
      role: "tool",
      tool_call_id: "call_uniform",
      content: UNIFORM.expected.encoded as string,
    };
    expectedRequest.messages[4] = {
      role: "tool",
      tool_call_id: "call_wrapped",
      content: WRAPPED.expected.encoded as string,
    };
    expect(adapter.toProviderRequest()).toStrictEqual(expectedRequest);

    // Rejected payloads count their original tokens in BOTH totals; malformed
    // content is not counted at all.
    const boundaryTokens = countTokens(NEAR_BOUNDARY.expected.normalized);
    const tokensBefore =
      countTokens(UNIFORM.expected.normalized) +
      countTokens(WRAPPED.expected.normalized) +
      boundaryTokens;
    const tokensAfter =
      countTokens(UNIFORM.expected.encoded as string) +
      countTokens(WRAPPED.expected.encoded as string) +
      boundaryTokens;
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: tokensBefore - tokensAfter,
      wasEffective: true,
      hadToolResults: true,
    });
  });

  test("applies native results to the right candidates when non-candidate messages are interleaved", async () => {
    await upsertPricing();

    // ZhipuAI tool messages are string-only, so non-candidates here are
    // assistant/user messages between tool messages: the native result index
    // diverges from the message index — off-by-one positional application
    // would compress the wrong message and fail the equality below.
    const makeRequest = (): ZhipuaiRequest => ({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "Inspect the workspace." },
        {
          role: "assistant",
          tool_calls: [makeToolCall("call_a", "read_config")],
        },
        {
          role: "tool",
          tool_call_id: "call_a",
          content: NEAR_BOUNDARY.rawContent,
        },
        { role: "assistant", content: "Let me look further." },
        {
          role: "assistant",
          tool_calls: [
            makeToolCall("call_b", "list_files"),
            makeToolCall("call_c", "read_notes"),
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_b",
          content: UNIFORM.rawContent,
        },
        {
          role: "tool",
          tool_call_id: "call_c",
          content: MALFORMED.rawContent,
        },
      ],
    });

    const adapter = zhipuaiAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("glm-4.6");

    // Only B compresses; A is rejected (near-boundary), C is malformed.
    const expectedRequest = makeRequest();
    expectedRequest.messages[5] = {
      role: "tool",
      tool_call_id: "call_b",
      content: UNIFORM.expected.encoded as string,
    };
    expect(adapter.toProviderRequest()).toStrictEqual(expectedRequest);

    const boundaryTokens = countTokens(NEAR_BOUNDARY.expected.normalized);
    const tokensBefore =
      boundaryTokens + countTokens(UNIFORM.expected.normalized);
    const tokensAfter =
      boundaryTokens + countTokens(UNIFORM.expected.encoded as string);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: tokensBefore - tokensAfter,
      wasEffective: true,
      hadToolResults: true,
    });
  });

  // The two accounting cases the combined request above cannot isolate.
  test("a lone malformed result: zeroed stats (hadToolResults=false), message untouched", async () => {
    await upsertPricing();

    const adapter = zhipuaiAdapterFactory.createRequestAdapter({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "run the tool" },
        { role: "tool", tool_call_id: "call_1", content: MALFORMED.rawContent },
      ],
    });
    const stats = await adapter.applyToonCompression("glm-4.6");

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

  test("a lone rejected result: original counted in both totals, wasEffective=false", async () => {
    await upsertPricing();

    const adapter = zhipuaiAdapterFactory.createRequestAdapter({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "run the tool" },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: NEAR_BOUNDARY.rawContent,
        },
      ],
    });
    const stats = await adapter.applyToonCompression("glm-4.6");

    const boundaryTokens = countTokens(NEAR_BOUNDARY.expected.normalized);
    expect(stats).toStrictEqual({
      tokensBefore: boundaryTokens,
      tokensAfter: boundaryTokens,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: true,
    });
    const [, toolMessage] = adapter.getProviderMessages();
    expect(toolMessage).toStrictEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: NEAR_BOUNDARY.rawContent,
    });
  });
});
