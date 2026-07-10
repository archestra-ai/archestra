/**
 * One-off assertion script (not a permanent test): validates that the bench
 * harness's TS reference backend produces byte-identical transformed content
 * to the real adapter path (convertToolResultsToToon in ../adapters/openai.ts)
 * on a set of fixtures, including the tokenizer keep/reject decision.
 *
 * Run from platform/backend:
 *   pnpm exec tsx src/routes/proxy/__bench__/validate-reference.ts
 */
import "./bench-env";
import assert from "node:assert/strict";
import { ModelModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type { OpenAi } from "@/types";
import { convertToolResultsToToon } from "../adapters/openai";
import { encodeToolResultsReference } from "./toon-kernel-reference";

// True process boundary (Postgres). Pricing lookup is irrelevant to the
// transformation output being validated, and this throwaway script runs
// without a database.
ModelModel.calculateCostSavings = async () => 0;

const uniformArray = JSON.stringify(
  Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    status: i % 2 === 0 ? "active" : "archived",
    score: i * 1.5,
  })),
);

const FIXTURES: string[] = [
  // Uniform array of objects — TOON compression expected to win.
  uniformArray,
  // n8n/Vercel-style text-block wrapper around JSON.
  JSON.stringify([{ type: "text", text: uniformArray }]),
  // Multi-element wrapper — pins the first-text-element-only behavior.
  JSON.stringify([
    { type: "text", text: uniformArray },
    { type: "text", text: '{"ignored":true}' },
  ]),
  // Non-array JSON object root.
  JSON.stringify({
    meta: { total: 3, source: "db" },
    rows: [
      { id: 1, value: "a" },
      { id: 2, value: "b" },
      { id: 3, value: "c" },
    ],
  }),
  // Non-JSON prose — adapter must keep it untouched.
  "Command failed: ENOENT no such file or directory, open '/tmp/x'",
  // Escaping / unicode / nesting / boundary-ish numbers.
  JSON.stringify({
    text: 'line1\nline2\t"quoted" \\ back',
    emoji: "héllo wörld ✓ 日本語",
    nested: { deep: { deeper: [1, 2, { x: null }] } },
    numbers: [0, -0, 1e21, 9007199254740991, 0.1],
  }),
  // Tiny payload where compression may or may not win — decision replicated.
  '{"a":1}',
];

async function main(): Promise<void> {
  const tokenizer = getTokenizer("openai");
  const messages: OpenAi.Types.ChatCompletionsRequest["messages"] = [
    { role: "user", content: "run the tools" },
    ...FIXTURES.map(
      (content, i) =>
        ({
          role: "tool",
          tool_call_id: `call_${i}`,
          content,
        }) as const,
    ),
  ];

  const { messages: transformed, stats } = await convertToolResultsToToon(
    messages,
    "gpt-4o",
    "openai",
  );

  let compressedCount = 0;
  FIXTURES.forEach((raw, i) => {
    const actual = transformed[i + 1];
    assert.equal(actual.role, "tool");

    // Reference backend, then the adapter's tokenizer keep/reject decision
    // replicated on top of it (openai.ts:1292-1305).
    const [ref] = encodeToolResultsReference([
      { rawContent: raw, unwrap: true },
    ]);
    let expected = raw;
    if (ref.encoded !== null) {
      const tokensBefore = tokenizer.countTokens([
        { role: "user", content: ref.normalized },
      ]);
      const tokensAfter = tokenizer.countTokens([
        { role: "user", content: ref.encoded },
      ]);
      if (tokensAfter < tokensBefore) {
        expected = ref.encoded;
        compressedCount++;
      }
    }
    assert.equal(
      actual.content,
      expected,
      `fixture ${i}: adapter output differs from reference backend`,
    );
  });

  // Guard against a vacuous pass: the encode path must actually fire.
  assert.ok(
    compressedCount >= 3,
    `expected >=3 fixtures to compress, got ${compressedCount}`,
  );
  assert.ok(stats.hadToolResults);
  assert.ok(stats.wasEffective);

  console.info(
    `validate-reference: OK (${FIXTURES.length} fixtures, ${compressedCount} compressed, ` +
      `tokensBefore=${stats.tokensBefore}, tokensAfter=${stats.tokensAfter})`,
  );
}

main();
