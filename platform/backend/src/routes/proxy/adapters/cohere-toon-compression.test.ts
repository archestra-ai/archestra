// Pins the Cohere adapter's TOON compression cutover to the native addon:
// full transformed-messages exact equality (TOON content from the committed
// v3 golden corpus, everything else byte-equal) and the exact
// ToolCompressionStats accounting matrix. Cohere-specific semantics pinned
// here: totals are updated ONLY on wins — a rejected (not smaller) payload
// contributes nothing to either total, so hadToolResults (totalTokensBefore >
// 0) is false when no result compresses. Requires the built addon: mandatory
// in CI; locally it skips visibly — run `pnpm test:native` from
// platform/backend.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { getTokenizer } from "@/tokenizers";
import type { Cohere } from "@/types";
import { cohereAdapterFactory } from "./cohere";

type CohereRequest = Cohere.Types.ChatRequest;

type GoldenEntry = {
  name: string;
  rawContent: string;
  unwrap: boolean;
  expected: { normalized: string; encoded: string | null };
};

const CORPUS_PATH = path.resolve(
  import.meta.dirname,
  "../../../../../archestra-rs/proxy-transform-core/tests/fixtures/golden-corpus.json",
);
const corpus: GoldenEntry[] = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
function corpusEntry(name: string): GoldenEntry {
  const entry = corpus.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`golden corpus entry not found: ${name}`);
  return entry;
}

// Corpus picks: a uniform array (compression wins), a wrapped
// [{type:"text",...}] payload (unwrapped, compression wins), malformed JSON
// (kept as-is), and a near-boundary object whose TOON encoding does not save
// tokens under the Cohere tokenizer (rejected — and, per the wins-only rule,
// not counted at all).
const UNIFORM = corpusEntry("provider-matrix-tool-result");
const WRAPPED = corpusEntry("wrapped-single-text");
const MALFORMED = corpusEntry("malformed-prose");
const NEAR_BOUNDARY = corpusEntry("boundary-obj-1");

const tokenizer = getTokenizer("cohere");
const countTokens = (content: string) =>
  tokenizer.countTokens([{ role: "user", content }]);

// $1,000,000 per million input tokens = $1 per token, so expected costSavings
// equals tokens saved exactly.
async function upsertOneDollarPerTokenPricing() {
  await ModelModel.upsert({
    externalId: "cohere/command-r-plus",
    provider: "cohere",
    modelId: "command-r-plus",
    inputModalities: null,
    outputModalities: null,
    customPricePerMillionInput: "1000000.00",
    customPricePerMillionOutput: "1000000.00",
    lastSyncedAt: new Date(),
  });
}

const addonLoadError: unknown = await import(
  "@archestra/proxy-transform-rs"
).then(
  () => null,
  (error) => error,
);

// In CI the suite must FAIL (never skip) when the addon is missing.
const describeNative =
  addonLoadError === null || process.env.CI ? describe : describe.skip;
if (addonLoadError !== null && !process.env.CI) {
  console.warn(
    `[cohere-toon-compression.test] skipping: @archestra/proxy-transform-rs is not built (${String(
      addonLoadError,
    )}). Run \`pnpm test:native\` from platform/backend.`,
  );
}

function makeToolCall(id: string, name: string) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: '{"directory":"."}' },
  };
}

describeNative("Cohere adapter TOON compression (native addon)", () => {
  test("transforms the full messages exactly (goldens for TOON, byte-equal elsewhere)", async () => {
    await upsertOneDollarPerTokenPricing();

    const makeRequest = (): CohereRequest => ({
      model: "command-r-plus",
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

    const adapter = cohereAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("command-r-plus");

    const expectedMessages = makeRequest().messages;
    // Compression wins for the uniform array and the wrapped payload; the
    // malformed and near-boundary results keep their original content.
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
    expect(adapter.getProviderMessages()).toStrictEqual(expectedMessages);

    // Wins-only accounting: the rejected near-boundary payload contributes
    // NOTHING to either total (unlike the OpenAI-family rule); malformed
    // content is not counted either.
    const tokensBefore =
      countTokens(UNIFORM.expected.normalized) +
      countTokens(WRAPPED.expected.normalized);
    const tokensAfter =
      countTokens(UNIFORM.expected.encoded as string) +
      countTokens(WRAPPED.expected.encoded as string);
    expect(stats).toStrictEqual({
      tokensBefore,
      tokensAfter,
      costSavings: tokensBefore - tokensAfter,
      wasEffective: true,
      hadToolResults: true,
    });
  });

  test("applies native results to the right candidates when non-candidate messages are interleaved", async () => {
    await upsertOneDollarPerTokenPricing();

    // Cohere tool messages are string-only, so non-candidates here are
    // assistant/user messages between tool messages: the native result index
    // diverges from the message index — off-by-one positional application
    // would compress the wrong message and fail the equality below.
    const makeRequest = (): CohereRequest => ({
      model: "command-r-plus",
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

    const adapter = cohereAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("command-r-plus");

    // Only B compresses; A is rejected (near-boundary), C is malformed.
    const expectedMessages = makeRequest().messages;
    expectedMessages[5] = {
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

  describe("exact ToolCompressionStats accounting matrix", () => {
    // Wins-only accounting: rejected and malformed rows contribute nothing,
    // so hadToolResults (totalTokensBefore > 0) is false for both.
    const rows: {
      row: string;
      entry: GoldenEntry;
      compressed: boolean;
    }[] = [
      { row: "malformed", entry: MALFORMED, compressed: false },
      {
        row: "ineffective (rejected: counted in NEITHER total)",
        entry: NEAR_BOUNDARY,
        compressed: false,
      },
      { row: "effective", entry: UNIFORM, compressed: true },
      { row: "wrapped-array", entry: WRAPPED, compressed: true },
    ];

    for (const { row, entry, compressed } of rows) {
      test(row, async () => {
        await upsertOneDollarPerTokenPricing();

        const adapter = cohereAdapterFactory.createRequestAdapter({
          model: "command-r-plus",
          messages: [
            { role: "user", content: "run the tool" },
            { role: "tool", tool_call_id: "call_1", content: entry.rawContent },
          ],
        });
        const stats = await adapter.applyToonCompression("command-r-plus");

        const tokensBefore = compressed
          ? countTokens(entry.expected.normalized)
          : 0;
        const tokensAfter = compressed
          ? countTokens(entry.expected.encoded as string)
          : 0;
        expect(stats).toStrictEqual({
          tokensBefore,
          tokensAfter,
          costSavings: tokensBefore - tokensAfter,
          wasEffective: compressed,
          hadToolResults: compressed,
        });

        const [, toolMessage] = adapter.getProviderMessages();
        expect(toolMessage).toStrictEqual({
          role: "tool",
          tool_call_id: "call_1",
          content: compressed
            ? (entry.expected.encoded as string)
            : entry.rawContent,
        });
      });
    }
  });
});
