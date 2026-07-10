// Pins the Gemini adapter's TOON compression cutover to the native addon:
// full transformed-contents exact equality (TOON content from the committed
// v3 golden corpus, everything else byte-equal). Gemini-specific semantics
// pinned here: the adapter serializes functionResponse.response itself and
// tokenizes that ORIGINAL serialization (not the unwrapped string) while
// parsing goes through the unwrap path, a winning part is replaced with
// { functionResponse: { ..., response: { tool_result: "<TOON>" } } }, rejected
// payloads count their original tokens in both totals, and hadToolResults
// reflects every functionResponse part (even unparseable ones). Requires the
// built addon: mandatory in CI; locally it skips visibly — run
// `pnpm test:native` from platform/backend.

import { expect, test } from "@/test";
import {
  corpusEntry,
  describeNative,
  type GoldenEntry,
  makeCountTokens,
  upsertOneDollarPerTokenPricing,
} from "@/test/toon-golden";
import type { Gemini } from "@/types";
import { geminiAdapterFactory } from "./gemini";

type GeminiRequest = Gemini.Types.GenerateContentRequest;

// Corpus picks: a uniform array (compression wins), a wrapped
// [{type:"text",...}] payload (unwrapped for parsing, compression wins), a
// wrapper whose inner text is NOT JSON (the "cannot be compressed" path — a
// response object always serializes to valid JSON, so this is Gemini's only
// unparseable case), and a near-boundary object whose TOON encoding does not
// save tokens under the Gemini tokenizer (rejected).
const UNIFORM = corpusEntry("provider-matrix-tool-result");
const WRAPPED = corpusEntry("wrapped-single-text");
const UNPARSEABLE = corpusEntry("wrapped-text-not-json");
const NEAR_BOUNDARY = corpusEntry("boundary-obj-1");

const countTokens = makeCountTokens("gemini");
// Gemini accounting uses the adapter's own serialization of the response
// object — recompute it here instead of trusting the corpus rawContent.
const serialized = (entry: GoldenEntry) =>
  JSON.stringify(JSON.parse(entry.rawContent));

const upsertPricing = () =>
  upsertOneDollarPerTokenPricing({
    provider: "gemini",
    modelId: "gemini-2.0-flash",
  });

describeNative("Gemini adapter TOON compression (native addon)", () => {
  test("transforms the full contents exactly (goldens for TOON, byte-equal elsewhere)", async () => {
    await upsertPricing();

    const makeRequest = (): GeminiRequest => ({
      contents: [
        {
          role: "user",
          parts: [{ text: "What files are in the current directory?" }],
        },
        { role: "model", parts: [{ text: "Calling the tools now." }] },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "fc_uniform",
                name: "list_files",
                response: JSON.parse(UNIFORM.rawContent),
              },
            },
            {
              functionResponse: {
                name: "read_wrapped",
                response: JSON.parse(WRAPPED.rawContent),
              },
            },
            {
              functionResponse: {
                name: "read_notes",
                response: JSON.parse(UNPARSEABLE.rawContent),
              },
            },
            {
              functionResponse: {
                name: "read_config",
                response: JSON.parse(NEAR_BOUNDARY.rawContent),
              },
            },
          ],
        },
      ],
    });

    const adapter = geminiAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("gemini-2.0-flash");

    // Compression wins for the uniform array and the wrapped payload (the
    // functionResponse spread keeps `id`); the unparseable and near-boundary
    // responses keep their original parts.
    const expectedContents = makeRequest().contents;
    expectedContents[2].parts[0] = {
      functionResponse: {
        id: "fc_uniform",
        name: "list_files",
        response: { tool_result: UNIFORM.expected.encoded as string },
      },
    };
    expectedContents[2].parts[1] = {
      functionResponse: {
        name: "read_wrapped",
        response: { tool_result: WRAPPED.expected.encoded as string },
      },
    };
    expect(adapter.getProviderMessages()).toStrictEqual(expectedContents);

    // Token accounting uses the ORIGINAL serialization of each response —
    // for the wrapped payload that is the whole wrapper array, not the
    // unwrapped inner text (which would count fewer tokens). Rejected
    // payloads count their original tokens in both totals; the unparseable
    // response is not counted at all.
    const boundaryTokens = countTokens(serialized(NEAR_BOUNDARY));
    const tokensBefore =
      countTokens(serialized(UNIFORM)) +
      countTokens(serialized(WRAPPED)) +
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

  test("applies native results to the right parts when non-candidate parts are interleaved", async () => {
    await upsertPricing();

    // Text parts and a model turn between functionResponse parts: the
    // winning candidate sits at native index 2, content index 3, part index
    // 1 — all three DIFFER, so applying the native result by any wrong index
    // (candidate-as-part, candidate-as-content, ...) compresses the wrong
    // part and fails the equality below.
    const makeRequest = (): GeminiRequest => ({
      contents: [
        { role: "user", parts: [{ text: "Inspect the workspace." }] },
        {
          role: "user",
          parts: [
            { text: "intermediate status" },
            {
              // native index 0
              functionResponse: {
                name: "read_config",
                response: JSON.parse(NEAR_BOUNDARY.rawContent),
              },
            },
            {
              // native index 1
              functionResponse: {
                name: "read_notes",
                response: JSON.parse(UNPARSEABLE.rawContent),
              },
            },
          ],
        },
        { role: "model", parts: [{ text: "Let me look further." }] },
        {
          role: "user",
          parts: [
            { text: "more status" },
            {
              // native index 2 — the winner
              functionResponse: {
                name: "list_files",
                response: JSON.parse(UNIFORM.rawContent),
              },
            },
          ],
        },
      ],
    });

    const adapter = geminiAdapterFactory.createRequestAdapter(makeRequest());
    const stats = await adapter.applyToonCompression("gemini-2.0-flash");

    // Only the uniform response compresses; the near-boundary and
    // unparseable responses and the text parts are untouched.
    const expectedContents = makeRequest().contents;
    expectedContents[3].parts[1] = {
      functionResponse: {
        name: "list_files",
        response: { tool_result: UNIFORM.expected.encoded as string },
      },
    };
    expect(adapter.getProviderMessages()).toStrictEqual(expectedContents);

    const boundaryTokens = countTokens(serialized(NEAR_BOUNDARY));
    const tokensBefore = boundaryTokens + countTokens(serialized(UNIFORM));
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

  // The case the combined request cannot isolate: hadToolResults is true even
  // when the only functionResponse is unparseable after unwrap — Gemini
  // counts every functionResponse part it sees.
  test("a lone unparseable response: zeroed totals but hadToolResults=true, contents untouched", async () => {
    await upsertPricing();

    const makeContents = (): GeminiRequest["contents"] => [
      { role: "user", parts: [{ text: "run the tool" }] },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "the_tool",
              response: JSON.parse(UNPARSEABLE.rawContent),
            },
          },
        ],
      },
    ];

    const adapter = geminiAdapterFactory.createRequestAdapter({
      contents: makeContents(),
    });
    const stats = await adapter.applyToonCompression("gemini-2.0-flash");

    expect(stats).toStrictEqual({
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: true,
    });
    expect(adapter.getProviderMessages()).toStrictEqual(makeContents());
  });

  test("a lone rejected response: original counted in both totals, wasEffective=false", async () => {
    await upsertPricing();

    const makeContents = (): GeminiRequest["contents"] => [
      { role: "user", parts: [{ text: "run the tool" }] },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "the_tool",
              response: JSON.parse(NEAR_BOUNDARY.rawContent),
            },
          },
        ],
      },
    ];

    const adapter = geminiAdapterFactory.createRequestAdapter({
      contents: makeContents(),
    });
    const stats = await adapter.applyToonCompression("gemini-2.0-flash");

    const boundaryTokens = countTokens(serialized(NEAR_BOUNDARY));
    expect(stats).toStrictEqual({
      tokensBefore: boundaryTokens,
      tokensAfter: boundaryTokens,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: true,
    });
    expect(adapter.getProviderMessages()).toStrictEqual(makeContents());
  });
});
