/**
 * Catalog rules for the Gemini provider family (`gemini-*` and `gemma-*`, both
 * served through the Gemini provider). Pure functions of the model id, shared by
 * the backend model fetcher (to filter the catalog) and the frontend model
 * selector (to badge older generations) so both stay in sync.
 *
 * `GET /v1beta/models` returns many models that advertise `generateContent` but
 * are not usable as chat (text-to-speech, image generation, audio/live), plus
 * deprecated and non-Gemini families. We keep only text-output Gemini-family chat
 * models at or above a minimum generation, plus first-class Gemini embeddings.
 */

/** Output-modality families that are not usable for text chat. */
const NON_TEXT_GEMINI_PATTERNS = ["tts", "image", "audio", "live"];

/** Lowest Gemini-family generation kept in the catalog. */
const GEMINI_FAMILY_MIN_VERSION: GeminiVersion = [2, 5];

/**
 * Generations at or below this are labelled "old" in the model selector. Bump
 * this (and {@link GEMINI_FAMILY_MIN_VERSION} if needed) when a new generation
 * ships and the previous one becomes legacy.
 */
const GEMINI_FAMILY_LEGACY_MAX_VERSION: GeminiVersion = [3, 0];

const GEMINI_EMBEDDING_PREFIX = "gemini-embedding-";

/**
 * True when the model should appear in the selectable catalog: first-class
 * Gemini embeddings, or a text-output `gemini-`/`gemma-` chat model at or above
 * {@link GEMINI_FAMILY_MIN_VERSION}. Drops TTS/image/audio/live variants and
 * unbranded families (learnlm, aqa, *-bison, legacy embedding-001/text-embedding-*).
 */
export function isUsableGeminiCatalogModel(modelId: string): boolean {
  const id = modelId.toLowerCase();

  if (id.startsWith(GEMINI_EMBEDDING_PREFIX)) {
    return true;
  }
  if (NON_TEXT_GEMINI_PATTERNS.some((pattern) => id.includes(pattern))) {
    return false;
  }

  const version = parseGeminiFamilyVersion(id);
  return (
    version !== null && compareVersion(version, GEMINI_FAMILY_MIN_VERSION) >= 0
  );
}

/**
 * Highest-quality Gemini chat model, computed from the id so new releases rank
 * correctly with no hardcoded list to maintain. Best = highest tier (Pro >
 * Flash > Flash-lite), then newest generation, then GA over -preview, then the
 * shortest/lowest id. Null when the account has no rankable Gemini chat model.
 */
export function pickBestGeminiModelId(modelIds: string[]): string | null {
  return (
    modelIds
      .filter((id) => geminiChatScore(id) !== null)
      .sort(
        (a, b) =>
          geminiChatScore(b)! - geminiChatScore(a)! || a.localeCompare(b),
      )[0] ?? null
  );
}

/**
 * True when a Gemini-family chat model is an older generation
 * (≤ {@link GEMINI_FAMILY_LEGACY_MAX_VERSION}) and should carry an "old" badge.
 * Embeddings are never badged.
 */
export function isLegacyGeminiModel(modelId: string): boolean {
  const id = modelId.toLowerCase();

  if (id.startsWith(GEMINI_EMBEDDING_PREFIX)) {
    return false;
  }

  const version = parseGeminiFamilyVersion(id);
  return (
    version !== null &&
    compareVersion(version, GEMINI_FAMILY_LEGACY_MAX_VERSION) <= 0
  );
}

// ===========================================================================
// Internal helpers
// ===========================================================================

type GeminiVersion = readonly [major: number, minor: number];

const GEMINI_FAMILY_VERSION_RE = /^(?:gemini|gemma)-(\d+)(?:\.(\d+))?/;

/**
 * Extracts the leading generation from a `gemini-`/`gemma-` id as a
 * [major, minor] tuple (minor defaults to 0). Returns null for unbranded ids or
 * ids without a numeric generation (e.g. bare `gemini-pro`, `gemini-exp-1206`).
 * Tuple form avoids the `parseFloat` pitfall where `gemini-2.10` < `gemini-2.5`.
 */
function parseGeminiFamilyVersion(lowerId: string): GeminiVersion | null {
  const match = GEMINI_FAMILY_VERSION_RE.exec(lowerId);
  if (!match) {
    return null;
  }
  return [Number(match[1]), match[2] ? Number(match[2]) : 0];
}

function compareVersion(a: GeminiVersion, b: GeminiVersion): number {
  if (a[0] !== b[0]) {
    return a[0] - b[0];
  }
  return a[1] - b[1];
}

/** Tier -> quality rank, listed match-first so "flash-lite" wins over "flash". */
const GEMINI_TIER_RANKS: ReadonlyArray<readonly [string, number]> = [
  ["flash-lite", 1],
  ["flash", 2],
  ["pro", 3],
];

/**
 * Sortable quality score for a Gemini chat model, or null when it is not
 * rankable (embeddings, computer-use/robotics, unversioned `-latest` aliases,
 * or legacy/non-text families filtered by {@link isUsableGeminiCatalogModel}).
 * Digits, most significant first: tier, generation, GA-over-preview.
 */
function geminiChatScore(modelId: string): number | null {
  const id = modelId.toLowerCase();
  const tierRank = GEMINI_TIER_RANKS.find(([tier]) => id.includes(tier))?.[1];
  const version = parseGeminiFamilyVersion(id);
  if (
    tierRank === undefined ||
    version === null ||
    !isUsableGeminiCatalogModel(id) ||
    id.startsWith(GEMINI_EMBEDDING_PREFIX)
  ) {
    return null;
  }
  const [major, minor] = version;
  const isGA = id.includes("preview") ? 0 : 1;
  return ((tierRank * 100 + major) * 100 + minor) * 10 + isGA;
}
