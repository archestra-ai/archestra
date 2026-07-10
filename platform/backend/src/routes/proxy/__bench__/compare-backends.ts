/**
 * One-off sanity script (not a permanent test): runs the TS reference backend
 * and the native backend over the full benchmark corpora and classifies every
 * output divergence. Expected: `normalized` byte-equal everywhere; `encoded`
 * either byte-equal or a representation-only difference (both encodings decode
 * to the same value via the npm decoder — e.g. the Rust v3 encoder quotes
 * hyphenated scalars like `SKU-123` that npm 2.1.0 leaves bare, per the known
 * npm→v3 migration delta established at T1). Anything that decodes differently
 * is a real mismatch and fails the script.
 *
 * Run from platform/backend:
 *   pnpm exec tsx src/routes/proxy/__bench__/compare-backends.ts
 */
import "./bench-env";
import assert from "node:assert/strict";
import { decode as toonDecode } from "@toon-format/toon";
import { buildBatch, buildJumboBatch, CORPUS_SPECS } from "./corpus";
import {
  encodeToolResultsReference,
  type ToonKernelItem,
} from "./toon-kernel-reference";

const MAX_PRINTED_DIFFS = 10;

type DivergenceKind =
  | "normalized" // normalized strings differ (must never happen)
  | "encodability" // one side encoded, the other returned null
  | "representation" // byte-different encodings decoding to the same value
  | "semantic"; // encodings decode to different values

interface Divergence {
  corpus: string;
  index: number;
  kind: DivergenceKind;
  detail: string;
}

async function main(): Promise<void> {
  const divergences: Divergence[] = [];
  let total = 0;
  let encodable = 0;
  for (const spec of CORPUS_SPECS) {
    const r = await compareCorpus(spec.name, buildBatch(spec, 42), divergences);
    total += r.total;
    encodable += r.encodable;
  }
  const jumbo = await compareCorpus("70MB", buildJumboBatch(4242), divergences);
  total += jumbo.total;
  encodable += jumbo.encodable;

  const byKind = new Map<DivergenceKind, Divergence[]>();
  for (const d of divergences) {
    const bucket = byKind.get(d.kind) ?? [];
    bucket.push(d);
    byKind.set(d.kind, bucket);
  }
  console.info(
    `compare-backends: ${total} items (${encodable} encodable), ${divergences.length} byte-divergence(s)`,
  );
  for (const [kind, bucket] of byKind) {
    console.info(`  ${kind}: ${bucket.length}`);
    for (const d of bucket.slice(0, MAX_PRINTED_DIFFS)) {
      console.info(`    ${d.corpus}[${d.index}] ${d.detail}`);
    }
    if (bucket.length > MAX_PRINTED_DIFFS) {
      console.info(`    ... ${bucket.length - MAX_PRINTED_DIFFS} more`);
    }
  }

  const broken = divergences.filter((d) => d.kind !== "representation");
  process.exitCode = broken.length === 0 ? 0 : 1;
}

// =============================================================================
// INTERNALS
// =============================================================================

async function compareCorpus(
  name: string,
  items: ToonKernelItem[],
  divergences: Divergence[],
): Promise<{ total: number; encodable: number }> {
  const { toonEncodeToolResults } = await import("../utils/toon-native");
  const tsResults = encodeToolResultsReference(items);
  const nativeResults = await toonEncodeToolResults(
    items.map(({ rawContent, unwrap }, i) => ({
      id: `cmp_${i}`,
      rawContent,
      unwrap,
    })),
  );
  if (nativeResults === null) {
    throw new Error("native backend unavailable");
  }
  let encodable = 0;
  items.forEach((_, i) => {
    const ts = tsResults[i];
    const native = nativeResults[i];
    if (ts.normalized !== native.normalized) {
      divergences.push({
        corpus: name,
        index: i,
        kind: "normalized",
        detail: firstDiff(ts.normalized, native.normalized),
      });
    }
    if (ts.encoded !== null || native.encoded !== null) {
      encodable++;
    }
    if (ts.encoded === native.encoded) {
      return;
    }
    if (ts.encoded === null || native.encoded === null) {
      divergences.push({
        corpus: name,
        index: i,
        kind: "encodability",
        detail: `ts=${ts.encoded === null ? "<null>" : "encoded"} native=${
          native.encoded === null ? "<null>" : "encoded"
        }`,
      });
      return;
    }
    divergences.push({
      corpus: name,
      index: i,
      kind: classifyEncodedDiff(ts.encoded, native.encoded),
      detail: firstDiff(ts.encoded, native.encoded),
    });
  });
  return { total: items.length, encodable };
}

function classifyEncodedDiff(ts: string, native: string): DivergenceKind {
  try {
    assert.deepEqual(toonDecode(native), toonDecode(ts));
    return "representation";
  } catch {
    return "semantic";
  }
}

function firstDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) {
    i++;
  }
  const ctx = (s: string) =>
    JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  return `at byte ${i}: ts=${ctx(a)} native=${ctx(b)}`;
}

main();
