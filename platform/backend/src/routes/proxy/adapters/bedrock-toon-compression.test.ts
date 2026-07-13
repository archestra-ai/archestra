// Pins the Bedrock adapter's TOON compression cutover to the native addon:
// full transformed-request exact equality (TOON content from the committed v3
// golden corpus, everything else byte-equal). Bedrock-specific semantics
// pinned here: compression is applied UNCONDITIONALLY (no keep/reject —
// encoded tokens are always recorded, even when TOON is larger), NEITHER
// branch unwraps client wrappers, only content[0] of a toolResult is read, a
// compressed result replaces the WHOLE content array with one text item (the
// json branch is rewritten to text too), and error-status results are skipped
// entirely. Requires the built addon: mandatory in CI; locally it skips
// visibly — run `pnpm test:native` from platform/backend.

import { expect, test } from "@/test";
import {
  corpusEntry,
  describeNative,
  makeCountTokens,
  upsertOneDollarPerTokenPricing,
} from "@/test/toon-golden";
import type { Bedrock } from "@/types";
import { bedrockAdapterFactory } from "./bedrock";

type BedrockRequest = Bedrock.Types.ConverseRequest;

// Corpus picks: a uniform array (TOON smaller), malformed JSON (kept as-is),
// a json-branch twin of the uniform array, and a wrapped [{type:"text",...}]
// payload encoded WITHOUT unwrapping (its TOON is the wrapper array itself
// and is LARGER than the original under the Anthropic tokenizer — Bedrock
// still applies it).
const UNIFORM = corpusEntry("provider-matrix-tool-result");
const MALFORMED = corpusEntry("malformed-prose");
const JSON_BRANCH = corpusEntry("bedrock-json-branch");
const WRAPPED_NO_UNWRAP = corpusEntry("wrapped-but-unwrap-false");
// A json-branch object whose TOON encoding is LARGER under the Anthropic
// tokenizer — Bedrock still applies it (unconditional apply on both branches).
const JSON_LARGER = corpusEntry("boundary-obj-3");

// Bedrock accounting uses the Anthropic tokenizer as an approximation.
const countTokens = makeCountTokens("anthropic");
// The json branch tokenizes the adapter's own serialization of the json
// value — recompute it here instead of trusting the corpus rawContent.
const jsonBranchSerialized = JSON.stringify(JSON.parse(JSON_BRANCH.rawContent));

const BEDROCK_MODEL = "anthropic.claude-sonnet-4-5-20250929-v1:0";

const upsertPricing = () =>
  upsertOneDollarPerTokenPricing({
    provider: "bedrock",
    modelId: BEDROCK_MODEL,
  });

describeNative("Bedrock adapter TOON compression (native addon)", () => {
  test("transforms the full provider request exactly (goldens for TOON, byte-equal elsewhere)", async () => {
    await upsertPricing();

    const makeRequest = (): BedrockRequest => ({
      modelId: BEDROCK_MODEL,
      inferenceConfig: { temperature: 0.25 },
      messages: [
        {
          role: "user",
          content: [{ text: "What files are in the current directory?" }],
        },
        {
          role: "assistant",
          content: [
            {
              toolUse: {
                toolUseId: "tooluse_list",
                name: "list_files",
                input: { directory: "." },
              },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "tooluse_text",
                content: [{ text: UNIFORM.rawContent }],
                status: "success",
              },
            },
            {
              toolResult: {
                toolUseId: "tooluse_json",
                content: [{ json: JSON.parse(JSON_BRANCH.rawContent) }],
              },
            },
            {
              toolResult: {
                toolUseId: "tooluse_malformed",
                content: [{ text: MALFORMED.rawContent }],
              },
            },
          ],
        },
      ],
    });

    const adapter = bedrockAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression(BEDROCK_MODEL);

    // Both the text and json branches are rewritten to a single text item
    // (the whole content array is replaced and toolResult fields like
    // `status` are preserved by the spread); malformed content is kept.
    const expectedRequest = makeRequest();
    // biome-ignore lint/style/noNonNullAssertion: fixture shape is static
    expectedRequest.messages![2].content = [
      {
        toolResult: {
          toolUseId: "tooluse_text",
          content: [{ text: UNIFORM.expected.encoded as string }],
          status: "success",
        },
      },
      {
        toolResult: {
          toolUseId: "tooluse_json",
          content: [{ text: JSON_BRANCH.expected.encoded as string }],
        },
      },
      {
        toolResult: {
          toolUseId: "tooluse_malformed",
          content: [{ text: MALFORMED.rawContent }],
        },
      },
    ];
    expect(adapter.toProviderRequest()).toStrictEqual(expectedRequest);

    // Unconditional accounting: both branches count original serialization
    // vs encoded; malformed content is not counted at all.
    const tokensBefore =
      countTokens(UNIFORM.rawContent) + countTokens(jsonBranchSerialized);
    const tokensAfter =
      countTokens(UNIFORM.expected.encoded as string) +
      countTokens(JSON_BRANCH.expected.encoded as string);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: tokensBefore - tokensAfter,
      wasEffective: true,
      hadToolResults: true,
    });
  });

  test("applies native results to the right blocks when non-candidate blocks are interleaved", async () => {
    await upsertPricing();

    // Non-candidates between candidates: a plain text block, an error-status
    // toolResult (whose content WOULD compress if wrongly collected), an
    // empty-content toolResult, and a non-user assistant turn. The winning
    // candidate sits at native index 1, message index 2, block index 0 — all
    // three DIFFER, so applying the native result by any wrong index
    // (candidate-as-message, candidate-as-block, ...) compresses the wrong
    // block and fails the equality below.
    const makeRequest = (): BedrockRequest => ({
      modelId: BEDROCK_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { text: "status update" },
            {
              toolResult: {
                toolUseId: "tooluse_error",
                content: [{ text: UNIFORM.rawContent }],
                status: "error",
              },
            },
            {
              toolResult: {
                toolUseId: "tooluse_empty",
                content: [],
              },
            },
            {
              // native index 0 — malformed, kept as-is
              toolResult: {
                toolUseId: "tooluse_malformed",
                content: [{ text: MALFORMED.rawContent }],
              },
            },
          ],
        },
        { role: "assistant", content: [{ text: "Let me check." }] },
        {
          role: "user",
          content: [
            {
              // native index 1 — the winner
              toolResult: {
                toolUseId: "tooluse_ok",
                content: [{ text: UNIFORM.rawContent }],
              },
            },
          ],
        },
      ],
    });

    const adapter = bedrockAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression(BEDROCK_MODEL);

    const expectedRequest = makeRequest();
    // biome-ignore lint/style/noNonNullAssertion: fixture shape is static
    expectedRequest.messages![2].content[0] = {
      toolResult: {
        toolUseId: "tooluse_ok",
        content: [{ text: UNIFORM.expected.encoded as string }],
      },
    };
    expect(adapter.toProviderRequest()).toStrictEqual(expectedRequest);

    const tokensBefore = countTokens(UNIFORM.rawContent);
    const tokensAfter = countTokens(UNIFORM.expected.encoded as string);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: tokensBefore - tokensAfter,
      wasEffective: true,
      hadToolResults: true,
    });
  });

  test("reads only content[0] and replaces the whole content array (multi-item content)", async () => {
    await upsertPricing();

    const makeRequest = (): BedrockRequest => ({
      modelId: BEDROCK_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "tooluse_multi",
                content: [
                  { text: UNIFORM.rawContent },
                  { text: "a second item that is silently dropped" },
                ],
              },
            },
            {
              toolResult: {
                toolUseId: "tooluse_first_malformed",
                content: [
                  { text: MALFORMED.rawContent },
                  // Compressible, but never looked at: content[0] decides.
                  { json: JSON.parse(JSON_BRANCH.rawContent) },
                ],
              },
            },
          ],
        },
      ],
    });

    const adapter = bedrockAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression(BEDROCK_MODEL);

    const expectedRequest = makeRequest();
    // biome-ignore lint/style/noNonNullAssertion: fixture shape is static
    expectedRequest.messages![0].content[0] = {
      toolResult: {
        toolUseId: "tooluse_multi",
        // The whole multi-item content collapses to one text item.
        content: [{ text: UNIFORM.expected.encoded as string }],
      },
    };
    expect(adapter.toProviderRequest()).toStrictEqual(expectedRequest);

    const tokensBefore = countTokens(UNIFORM.rawContent);
    const tokensAfter = countTokens(UNIFORM.expected.encoded as string);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: tokensBefore - tokensAfter,
      wasEffective: true,
      hadToolResults: true,
    });
  });

  // Cases the combined request cannot isolate: hadToolResults is true even
  // for malformed-only content (Bedrock counts every non-error toolResult),
  // there is no reject rule on either branch, and error-status results are
  // skipped entirely.
  test("a lone malformed result: zeroed totals but hadToolResults=true, message untouched", async () => {
    await upsertPricing();

    const makeRequest = (): BedrockRequest => ({
      modelId: BEDROCK_MODEL,
      messages: [
        { role: "user", content: [{ text: "run the tool" }] },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "tooluse_1",
                content: [{ text: MALFORMED.rawContent }],
              },
            },
          ],
        },
      ],
    });

    const adapter = bedrockAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression(BEDROCK_MODEL);

    expect(stats).toStrictEqual({
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: true,
    });
    expect(adapter.toProviderRequest()).toStrictEqual(makeRequest());
  });

  test("text branch unconditional apply (encoded larger, no unwrap, still applied)", async () => {
    await upsertPricing();

    const adapter = bedrockAdapterFactory.createRequestAdapter({
      modelId: BEDROCK_MODEL,
      messages: [
        { role: "user", content: [{ text: "run the tool" }] },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "tooluse_1",
                content: [{ text: WRAPPED_NO_UNWRAP.rawContent }],
              },
            },
          ],
        },
      ],
    });
    const stats = await adapter.applyToonCompression(BEDROCK_MODEL);

    const tokensBefore = countTokens(WRAPPED_NO_UNWRAP.rawContent);
    const tokensAfter = countTokens(
      WRAPPED_NO_UNWRAP.expected.encoded as string,
    );
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
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "tooluse_1",
            content: [{ text: WRAPPED_NO_UNWRAP.expected.encoded as string }],
          },
        },
      ],
    });
  });

  test("json branch unconditional apply (encoded larger, still applied)", async () => {
    await upsertPricing();

    const jsonLargerSerialized = JSON.stringify(
      JSON.parse(JSON_LARGER.rawContent),
    );
    const adapter = bedrockAdapterFactory.createRequestAdapter({
      modelId: BEDROCK_MODEL,
      messages: [
        { role: "user", content: [{ text: "run the tool" }] },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "tooluse_json_larger",
                content: [{ json: JSON.parse(JSON_LARGER.rawContent) }],
              },
            },
          ],
        },
      ],
    });
    const stats = await adapter.applyToonCompression(BEDROCK_MODEL);

    const tokensBefore = countTokens(jsonLargerSerialized);
    const tokensAfter = countTokens(JSON_LARGER.expected.encoded as string);
    expect(tokensAfter).toBeGreaterThan(tokensBefore);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: true,
    });

    // Still applied despite being larger — no keep/reject on this branch.
    const [, toolMessage] = adapter.getProviderMessages();
    expect(toolMessage).toStrictEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "tooluse_json_larger",
            content: [{ text: JSON_LARGER.expected.encoded as string }],
          },
        },
      ],
    });
  });

  test("error-status result is skipped entirely (not counted as a tool result)", async () => {
    await upsertPricing();

    const makeRequest = (): BedrockRequest => ({
      modelId: BEDROCK_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "tooluse_error",
                content: [{ text: UNIFORM.rawContent }],
                status: "error",
              },
            },
          ],
        },
      ],
    });

    const adapter = bedrockAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression(BEDROCK_MODEL);

    expect(adapter.toProviderRequest()).toStrictEqual(makeRequest());
    expect(stats).toStrictEqual({
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: false,
    });
  });
});
