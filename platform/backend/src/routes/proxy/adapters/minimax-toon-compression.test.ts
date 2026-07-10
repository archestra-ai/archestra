// Pins the MiniMax adapter's TOON compression cutover to the native addon:
// full transformed-request exact equality (TOON content from the committed v3
// golden corpus, everything else byte-equal) and the exact
// ToolCompressionStats accounting matrix. MiniMax-specific semantics pinned
// here: compression is applied UNCONDITIONALLY (no keep/reject — encoded
// tokens are always recorded, even when TOON is larger). Requires the built
// addon: mandatory in CI; locally it skips visibly — run `pnpm test:native`
// from platform/backend.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { getTokenizer } from "@/tokenizers";
import type { Minimax } from "@/types/llm-providers";
import { minimaxAdapterFactory } from "./minimax";

type MinimaxRequest = Minimax.Types.ChatCompletionsRequest;

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

// Corpus picks: a uniform array (TOON smaller), a wrapped [{type:"text",...}]
// payload (unwrapped, TOON smaller), malformed JSON (kept as-is), and a
// heterogeneous array whose TOON encoding is LARGER under the MiniMax
// tokenizer — MiniMax still applies it (unconditional apply).
const UNIFORM = corpusEntry("provider-matrix-tool-result");
const WRAPPED = corpusEntry("wrapped-single-text");
const MALFORMED = corpusEntry("malformed-prose");
const LARGER = corpusEntry("boundary-hetero-arr-1");

const tokenizer = getTokenizer("minimax");
const countTokens = (content: string) =>
  tokenizer.countTokens([{ role: "user", content }]);

// $1,000,000 per million input tokens = $1 per token, so expected costSavings
// equals tokens saved exactly.
async function upsertOneDollarPerTokenPricing() {
  await ModelModel.upsert({
    externalId: "minimax/MiniMax-M2",
    provider: "minimax",
    modelId: "MiniMax-M2",
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
    `[minimax-toon-compression.test] skipping: @archestra/proxy-transform-rs is not built (${String(
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

describeNative("MiniMax adapter TOON compression (native addon)", () => {
  test("transforms the full messages exactly (goldens for TOON, byte-equal elsewhere)", async () => {
    await upsertOneDollarPerTokenPricing();

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
    await upsertOneDollarPerTokenPricing();

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

  describe("exact ToolCompressionStats accounting matrix", () => {
    const rows: {
      row: string;
      entry: GoldenEntry;
      compressed: boolean;
      counted: boolean;
    }[] = [
      { row: "malformed", entry: MALFORMED, compressed: false, counted: false },
      {
        row: "unconditional apply (encoded larger, still applied and recorded)",
        entry: LARGER,
        compressed: true,
        counted: true,
      },
      { row: "effective", entry: UNIFORM, compressed: true, counted: true },
      {
        row: "wrapped-array",
        entry: WRAPPED,
        compressed: true,
        counted: true,
      },
    ];

    for (const { row, entry, compressed, counted } of rows) {
      test(row, async () => {
        await upsertOneDollarPerTokenPricing();

        const adapter = minimaxAdapterFactory.createRequestAdapter({
          model: "MiniMax-M2",
          messages: [
            { role: "user", content: "run the tool" },
            { role: "tool", tool_call_id: "call_1", content: entry.rawContent },
          ],
        });
        const stats = await adapter.applyToonCompression("MiniMax-M2");

        const tokensBefore = counted
          ? countTokens(entry.expected.normalized)
          : 0;
        const tokensAfter = compressed
          ? countTokens(entry.expected.encoded as string)
          : tokensBefore;
        expect(stats).toStrictEqual({
          tokensBefore,
          tokensAfter,
          costSavings: Math.max(0, tokensBefore - tokensAfter),
          wasEffective: tokensAfter < tokensBefore,
          hadToolResults: counted,
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
