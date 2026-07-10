// Shared harness for the per-adapter TOON golden suites
// (src/routes/proxy/adapters/*-toon-compression.test.ts): golden-corpus
// loading, the addon-required skip/fail gate, deterministic pricing, and
// per-provider token counting. Adapter-specific semantics stay in the suites.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupportedProvider } from "@archestra/shared";
import { ModelModel } from "@/models";
import { describe } from "@/test";
import { getTokenizer } from "@/tokenizers";

export type GoldenEntry = {
  name: string;
  rawContent: string;
  unwrap: boolean;
  expected: { normalized: string; encoded: string | null };
};

export function corpusEntry(name: string): GoldenEntry {
  const entry = corpus.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`golden corpus entry not found: ${name}`);
  return entry;
}

export function makeCountTokens(provider: SupportedProvider) {
  const tokenizer = getTokenizer(provider);
  return (content: string) =>
    tokenizer.countTokens([{ role: "user", content }]);
}

// $1,000,000 per million input tokens = $1 per token, so expected costSavings
// equals tokens saved exactly.
export async function upsertOneDollarPerTokenPricing(params: {
  provider: SupportedProvider;
  modelId: string;
}) {
  await ModelModel.upsert({
    externalId: `${params.provider}/${params.modelId}`,
    provider: params.provider,
    modelId: params.modelId,
    inputModalities: null,
    outputModalities: null,
    customPricePerMillionInput: "1000000.00",
    customPricePerMillionOutput: "1000000.00",
    lastSyncedAt: new Date(),
  });
}

export function makeToolCall(id: string, name: string) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: '{"directory":"."}' },
  };
}

const CORPUS_PATH = path.resolve(
  import.meta.dirname,
  "../../../archestra-rs/proxy-transform-core/tests/fixtures/golden-corpus.json",
);
const corpus: GoldenEntry[] = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));

const addonLoadError: unknown = await import(
  "@archestra/proxy-transform-rs"
).then(
  () => null,
  (error) => error,
);

// In CI the golden suites must FAIL (never skip) when the addon is missing.
export const describeNative =
  addonLoadError === null || process.env.CI ? describe : describe.skip;
if (addonLoadError !== null && !process.env.CI) {
  console.warn(
    `[toon golden suites] skipping: @archestra/proxy-transform-rs is not built (${String(
      addonLoadError,
    )}). Run \`pnpm test:native\` from platform/backend.`,
  );
}
