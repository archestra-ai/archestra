import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CorpusDocument,
  CorpusDocumentSchema,
  type GoldenQuery,
  GoldenQuerySchema,
} from "./schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceFixturesDir = path.join(__dirname, "fixtures");
// tsx executes this module in its source directory; tsdown bundles it into
// dist/standalone-scripts while copying assets to dist/fixtures.
const FIXTURES_DIR = fs.existsSync(sourceFixturesDir)
  ? sourceFixturesDir
  : path.join(__dirname, "..", "fixtures");
const ASSETS_DIR = path.join(FIXTURES_DIR, "assets");

export const DEFAULT_CORPUS_PATH = path.join(FIXTURES_DIR, "corpus.jsonl");
export const DEFAULT_GOLDEN_PATH = path.join(FIXTURES_DIR, "golden.jsonl");

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

export function loadCorpus(filePath = DEFAULT_CORPUS_PATH): CorpusDocument[] {
  const docs = parseJsonl(filePath, (raw, line) => {
    const parsed = CorpusDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new FixtureError(
        `${filePath}:${line}: invalid corpus document: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  });
  assertUnique(
    docs.map((document) => document.id),
    filePath,
    "document id",
  );
  return docs;
}

export function loadGolden(filePath = DEFAULT_GOLDEN_PATH): GoldenQuery[] {
  const queries = parseJsonl(filePath, (raw, line) => {
    const parsed = GoldenQuerySchema.safeParse(raw);
    if (!parsed.success) {
      throw new FixtureError(
        `${filePath}:${line}: invalid golden query: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  });
  assertUnique(
    queries.map((query) => query.id),
    filePath,
    "query id",
  );
  return queries;
}

/** Expand the fixed, checked-in multi-chunk fixture deterministically. */
export function materializeCorpusContent(document: CorpusDocument): string {
  const content = document.content ?? "";
  if (!document.repeat) return content;
  if (!content.includes(document.repeat.marker)) {
    throw new FixtureError(
      `${document.id}: repeat marker ${JSON.stringify(document.repeat.marker)} is absent from content`,
    );
  }
  return content.replaceAll(
    document.repeat.marker,
    `${document.repeat.value} `.repeat(document.repeat.count).trim(),
  );
}

/** Resolve a committed fixture asset without permitting an arbitrary pod path. */
export function resolveAssetPath(document: CorpusDocument): string {
  if (!document.asset) {
    throw new FixtureError(`${document.id}: no asset is configured`);
  }
  if (path.basename(document.asset) !== document.asset) {
    throw new FixtureError(
      `${document.id}: asset must be a basename under fixtures/assets`,
    );
  }
  const resolved = path.join(ASSETS_DIR, document.asset);
  if (!fs.existsSync(resolved)) {
    throw new FixtureError(`${document.id}: asset not found: ${resolved}`);
  }
  return resolved;
}

/**
 * Golden rows must point at real fixture documents. A query must also require
 * every capability its expected document requires; otherwise the query could
 * run while its answer was deliberately not seeded.
 */
export function assertGoldenMatchesCorpus(
  golden: GoldenQuery[],
  corpus: CorpusDocument[],
): void {
  const byId = new Map(corpus.map((document) => [document.id, document]));
  const failures: string[] = [];
  for (const query of golden) {
    const referenced = new Set([
      ...query.expected.map((expected) => expected.doc),
      ...(query.judgments ?? []).map((judgment) => judgment.doc),
      ...(query.forbidden ?? []),
    ]);
    for (const documentId of referenced) {
      const document = byId.get(documentId);
      if (!document) {
        failures.push(`${query.id} -> missing document ${documentId}`);
        continue;
      }
      const missingRequirements = document.requires.filter(
        (requirement) => !query.requires.includes(requirement),
      );
      if (missingRequirements.length > 0) {
        failures.push(
          `${query.id} -> ${documentId} requires ${missingRequirements.join(", ")}`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new FixtureError(
      `golden set does not match the corpus:\n  ${failures.join("\n  ")}`,
    );
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestFile(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

// ===== Internal helpers =====

function parseJsonl<T>(
  filePath: string,
  parse: (raw: unknown, line: number) => T,
): T[] {
  const text = fs.readFileSync(filePath, "utf8");
  const items: T[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new FixtureError(
        `${filePath}:${index + 1}: invalid JSON (${(error as Error).message})`,
      );
    }
    items.push(parse(raw, index + 1));
  });
  return items;
}

function assertUnique(values: string[], filePath: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new FixtureError(`${filePath}: duplicate ${label} "${value}"`);
    }
    seen.add(value);
  }
}
