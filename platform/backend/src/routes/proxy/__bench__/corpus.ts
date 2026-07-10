import type { ToonKernelItem } from "./toon-backend";

/**
 * Deterministic synthetic corpora for the TOON kernel benchmarks (T0).
 *
 * Every batch is fully reproducible from its seed. Item mix per 10 items:
 * 6 uniform JSON arrays of objects, 2 non-array JSON objects, 2 non-JSON
 * prose strings; 2 of the JSON items are wrapped in the n8n/Vercel-style
 * `[{"type":"text","text":...}]` wrapper (exercising the unwrap path),
 * and roughly 1 in 7 unwrapped items uses `unwrap: false` (Bedrock-style).
 */

export interface CorpusSpec {
  name: string;
  payloadBytes: number;
  count: number;
}

export const CORPUS_SPECS: CorpusSpec[] = [
  { name: "1KB", payloadBytes: 1 << 10, count: 256 },
  { name: "10KB", payloadBytes: 10 << 10, count: 128 },
  { name: "100KB", payloadBytes: 100 << 10, count: 64 },
  { name: "1MB", payloadBytes: 1 << 20, count: 16 },
  { name: "5MB", payloadBytes: 5 << 20, count: 8 },
];

export function buildBatch(spec: CorpusSpec, seed: number): ToonKernelItem[] {
  const rng = mulberry32(seed);
  const items: ToonKernelItem[] = [];
  for (let i = 0; i < spec.count; i++) {
    const r = i % 10;
    const kind: PayloadKind =
      r === 2 || r === 7 ? "object" : r === 4 || r === 9 ? "nonjson" : "array";
    const wrapped = kind !== "nonjson" && (r === 6 || r === 7);
    let payload = buildPayload(kind, spec.payloadBytes, rng);
    if (wrapped) {
      payload = JSON.stringify([{ type: "text", text: payload }]);
    }
    // Wrapped payloads must be unwrapped to reach the inner JSON; a slice of
    // plain payloads mimics the Bedrock branches, which never unwrap.
    const unwrap = wrapped ? true : i % 7 !== 3;
    items.push({ rawContent: payload, unwrap });
  }
  return items;
}

/** Mixed-size ~70MB batch approximating the proxy body limit. */
export function buildJumboBatch(seed: number): ToonKernelItem[] {
  const parts: CorpusSpec[] = [
    { name: "jumbo-5MB", payloadBytes: 5 << 20, count: 8 }, // ~40MB
    { name: "jumbo-1MB", payloadBytes: 1 << 20, count: 16 }, // ~16MB
    { name: "jumbo-100KB", payloadBytes: 100 << 10, count: 96 }, // ~9.4MB
    { name: "jumbo-10KB", payloadBytes: 10 << 10, count: 300 }, // ~2.9MB
    { name: "jumbo-1KB", payloadBytes: 1 << 10, count: 1024 }, // ~1MB
  ];
  return parts.flatMap((part, i) => buildBatch(part, seed + i * 101));
}

export function batchBytes(items: ToonKernelItem[]): number {
  return items.reduce((sum, item) => sum + item.rawContent.length, 0);
}

// =============================================================================
// INTERNALS
// =============================================================================

type PayloadKind = "array" | "object" | "nonjson";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "zulu",
];

const STATUSES = ["active", "pending", "archived", "failed"];

function pick<T>(rng: () => number, pool: T[]): T {
  return pool[Math.floor(rng() * pool.length)];
}

function makeRow(rng: () => number, id: number): Record<string, unknown> {
  return {
    id,
    sku: `SKU-${Math.floor(rng() * 1_000_000)}`,
    name: `${pick(rng, WORDS)} ${pick(rng, WORDS)}`,
    status: pick(rng, STATUSES),
    score: Math.round(rng() * 10_000) / 100,
    quantity: Math.floor(rng() * 500),
    active: rng() > 0.5,
    updatedAt: `2026-0${1 + Math.floor(rng() * 6)}-${String(1 + Math.floor(rng() * 28)).padStart(2, "0")}T12:00:00Z`,
  };
}

function buildPayload(
  kind: PayloadKind,
  targetBytes: number,
  rng: () => number,
): string {
  switch (kind) {
    case "array": {
      const rows: Record<string, unknown>[] = [];
      let size = 2; // brackets
      let id = 0;
      while (size < targetBytes) {
        const row = makeRow(rng, id++);
        size += JSON.stringify(row).length + 1;
        rows.push(row);
      }
      return JSON.stringify(rows);
    }
    case "object": {
      const entries: Record<string, unknown> = {};
      let size = 64;
      let id = 0;
      while (size < targetBytes) {
        const key = `entry_${id}`;
        const value = {
          ...makeRow(rng, id),
          nested: { tags: [pick(rng, WORDS), pick(rng, WORDS)], depth: 2 },
        };
        size += JSON.stringify(value).length + key.length + 4;
        entries[key] = value;
        id++;
      }
      return JSON.stringify({
        meta: { source: "bench", version: 3, total: id },
        entries,
      });
    }
    case "nonjson": {
      const parts: string[] = [`Tool run ${Math.floor(rng() * 1000)} output:`];
      let size = parts[0].length;
      while (size < targetBytes) {
        const word = pick(rng, WORDS);
        parts.push(word);
        size += word.length + 1;
      }
      return parts.join(" ");
    }
  }
}
