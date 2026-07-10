// Differential guard on the cl100k parity contract: the native fused counts
// (tiktoken-rs) must equal the JS `tiktoken` tokenizer over the exact strings
// each adapter compares — the golden corpus plus adversarial unicode /
// whitespace / reserved-marker inputs. A tiktoken-rs bump that shifts a single
// token here changes recorded compression stats, so this pins native == JS
// directly rather than only through the per-adapter number pins.

import { expect, test } from "@/test";
import { allGoldenEntries, describeNative } from "@/test/toon-golden";
import { getTokenizer } from "@/tokenizers";
import { toonEncodeToolResults } from "./toon-native";

const countJs = (content: string) =>
  getTokenizer("openai").countTokens([{ role: "user", content }]);

const ADVERSARIAL = [
  "",
  "   \n\t\r  ",
  "café résumé naïve Ångström",
  "日本語 中文 한국어 emoji 🚀🔥✨🎉",
  "<|endoftext|> reserved <|fim_prefix|> markers <|fim_suffix|>",
  "a".repeat(5000),
  JSON.stringify({
    rows: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `row ${i}` })),
  }),
];

describeNative("native cl100k counting matches the JS tokenizer", () => {
  test("golden corpus + adversarial inputs count identically to JS", async () => {
    const inputs = [
      ...allGoldenEntries().map((entry) => ({
        rawContent: entry.rawContent,
        unwrap: entry.unwrap,
      })),
      ...ADVERSARIAL.map((rawContent) => ({ rawContent, unwrap: false })),
    ];

    const results = await toonEncodeToolResults(
      inputs.map((input, i) => ({ id: `p${i}`, ...input })),
      "normalized",
    );
    expect(results).not.toBeNull();
    if (results === null) return;
    expect(results).toHaveLength(inputs.length);

    for (const result of results) {
      if (result.encoded === null) {
        // Unencodable items are never tokenized.
        expect(result.beforeTokens).toBeNull();
        expect(result.encodedTokens).toBeNull();
        continue;
      }
      // Counts are taken on the exact post-transform strings the adapter uses,
      // so any boundary normalization applies equally to both sides.
      expect(result.beforeTokens).toBe(countJs(result.normalized));
      expect(result.encodedTokens).toBe(countJs(result.encoded));
    }
  });

  test("the Raw baseline counts the original pre-unwrap serialization", async () => {
    // A wrapped payload: Raw counts the whole wrapper (what Gemini tokenizes),
    // not the unwrapped inner text that Normalized would.
    const inner = JSON.stringify({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const wrapped = JSON.stringify([{ type: "text", text: inner }]);

    const results = await toonEncodeToolResults(
      [{ id: "w", rawContent: wrapped, unwrap: true }],
      "raw",
    );
    expect(results).not.toBeNull();
    if (results === null) return;

    const [result] = results;
    expect(result.encoded).not.toBeNull();
    expect(result.beforeTokens).toBe(countJs(wrapped));
    // Sanity: the raw wrapper is larger than the unwrapped inner text.
    expect(countJs(wrapped)).toBeGreaterThan(countJs(inner));
  });
});
