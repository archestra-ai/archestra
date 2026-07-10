// Pins the Anthropic adapter's TOON compression cutover to the native addon:
// full transformed-request exact equality (TOON content from the committed v3
// golden corpus, everything else byte-equal) and the exact
// ToolCompressionStats accounting matrix. Anthropic-specific semantics pinned
// here: candidates come from BOTH tool_result content shapes (string content
// and every text sub-block of array content — several blocks can share one
// tool_use_id), each text block is counted individually, rejected payloads
// count their original tokens in both totals, and hadToolResults reflects
// every non-error tool_result block (even unparseable ones). Requires the
// built addon: mandatory in CI; locally it skips visibly — run
// `pnpm test:native` from platform/backend.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { getTokenizer } from "@/tokenizers";
import type { Anthropic } from "@/types";
import { anthropicAdapterFactory } from "./anthropic";

type AnthropicRequest = Anthropic.Types.MessagesRequest;

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
// tokens under the Anthropic tokenizer (rejected).
const UNIFORM = corpusEntry("provider-matrix-tool-result");
const WRAPPED = corpusEntry("wrapped-single-text");
const MALFORMED = corpusEntry("malformed-prose");
const NEAR_BOUNDARY = corpusEntry("boundary-obj-1");

const tokenizer = getTokenizer("anthropic");
const countTokens = (content: string) =>
  tokenizer.countTokens([{ role: "user", content }]);

// $1,000,000 per million input tokens = $1 per token, so expected costSavings
// equals tokens saved exactly.
async function upsertOneDollarPerTokenPricing() {
  await ModelModel.upsert({
    externalId: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
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
    `[anthropic-toon-compression.test] skipping: @archestra/proxy-transform-rs is not built (${String(
      addonLoadError,
    )}). Run \`pnpm test:native\` from platform/backend.`,
  );
}

describeNative("Anthropic adapter TOON compression (native addon)", () => {
  test("transforms the full provider request exactly (goldens for TOON, byte-equal elsewhere)", async () => {
    await upsertOneDollarPerTokenPricing();

    const makeRequest = (): AnthropicRequest => ({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      temperature: 0.25,
      messages: [
        { role: "user", content: "What files are in the current directory?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_list",
              name: "list_files",
              input: { directory: "." },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_uniform",
              content: UNIFORM.rawContent,
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_wrapped",
              content: WRAPPED.rawContent,
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_malformed",
              content: MALFORMED.rawContent,
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_boundary",
              content: NEAR_BOUNDARY.rawContent,
            },
          ],
        },
      ],
    });

    const adapter = anthropicAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("claude-sonnet-4-5");

    const expectedRequest = makeRequest();
    // Compression wins for the uniform array and the wrapped payload; the
    // malformed and near-boundary results keep their original content.
    expectedRequest.messages[2].content = [
      {
        type: "tool_result",
        tool_use_id: "toolu_uniform",
        content: UNIFORM.expected.encoded as string,
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_wrapped",
        content: WRAPPED.expected.encoded as string,
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_malformed",
        content: MALFORMED.rawContent,
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_boundary",
        content: NEAR_BOUNDARY.rawContent,
      },
    ];
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

  test("compresses every text block of a multi-block tool_result sharing one tool_use_id", async () => {
    await upsertOneDollarPerTokenPricing();

    // One tool_result carries three text blocks under a single tool_use_id:
    // positional (locator-based) application must compress the first and
    // second independently while keeping the malformed third — matching by
    // id would misapply results.
    const makeRequest = (): AnthropicRequest => ({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Fetch the data." },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_multi",
              content: [
                { type: "text", text: UNIFORM.rawContent },
                { type: "text", text: WRAPPED.rawContent },
                { type: "text", text: MALFORMED.rawContent },
              ],
            },
          ],
        },
      ],
    });

    const adapter = anthropicAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("claude-sonnet-4-5");

    const expectedRequest = makeRequest();
    expectedRequest.messages[1].content = [
      {
        type: "tool_result",
        tool_use_id: "toolu_multi",
        content: [
          { type: "text", text: UNIFORM.expected.encoded as string },
          { type: "text", text: WRAPPED.expected.encoded as string },
          { type: "text", text: MALFORMED.rawContent },
        ],
      },
    ];
    expect(adapter.toProviderRequest()).toStrictEqual(expectedRequest);

    // Each text block is counted individually.
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

  test("applies native results to the right blocks when non-candidate blocks are interleaved", async () => {
    await upsertOneDollarPerTokenPricing();

    // Non-candidates between candidates: a plain text block, an is_error
    // tool_result (whose content WOULD compress if wrongly collected), and a
    // malformed text block inside an array tool_result. The native result
    // index diverges from every structural index — off-by-one positional
    // application would compress the wrong block and fail the equality below.
    const makeRequest = (): AnthropicRequest => ({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Inspect the workspace." },
        {
          role: "user",
          content: [
            { type: "text", text: "status update" },
            {
              type: "tool_result",
              tool_use_id: "toolu_error",
              is_error: true,
              content: UNIFORM.rawContent,
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_boundary",
              content: NEAR_BOUNDARY.rawContent,
            },
          ],
        },
        { role: "assistant", content: "Checking the results." },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_mixed",
              content: [
                { type: "text", text: MALFORMED.rawContent },
                { type: "text", text: UNIFORM.rawContent },
              ],
            },
          ],
        },
      ],
    });

    const adapter = anthropicAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("claude-sonnet-4-5");

    // Only the uniform text block compresses; the error result, the
    // near-boundary result, and the malformed block are untouched.
    const expectedRequest = makeRequest();
    expectedRequest.messages[3].content = [
      {
        type: "tool_result",
        tool_use_id: "toolu_mixed",
        content: [
          { type: "text", text: MALFORMED.rawContent },
          { type: "text", text: UNIFORM.expected.encoded as string },
        ],
      },
    ];
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

  describe("exact ToolCompressionStats accounting matrix", () => {
    // Unlike the OpenAI family, hadToolResults is true even for malformed
    // content: Anthropic counts every non-error tool_result block it sees.
    const rows: {
      row: string;
      entry: GoldenEntry;
      compressed: boolean;
      counted: boolean;
    }[] = [
      { row: "malformed", entry: MALFORMED, compressed: false, counted: false },
      {
        row: "ineffective (rejected: original counted in both totals)",
        entry: NEAR_BOUNDARY,
        compressed: false,
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

        const adapter = anthropicAdapterFactory.createRequestAdapter({
          model: "claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [
            { role: "user", content: "run the tool" },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  content: entry.rawContent,
                },
              ],
            },
          ],
        });
        const stats = await adapter.applyToonCompression("claude-sonnet-4-5");

        const tokensBefore = counted
          ? countTokens(entry.expected.normalized)
          : 0;
        const tokensAfter = compressed
          ? countTokens(entry.expected.encoded as string)
          : tokensBefore;
        expect(stats).toStrictEqual({
          tokensBefore,
          tokensAfter,
          costSavings: tokensBefore - tokensAfter,
          wasEffective: compressed,
          hadToolResults: true,
        });

        const [, toolMessage] = adapter.getProviderMessages();
        expect(toolMessage).toStrictEqual({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: compressed
                ? (entry.expected.encoded as string)
                : entry.rawContent,
            },
          ],
        });
      });
    }
  });
});
