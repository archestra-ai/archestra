import {
  type archestraApiTypes,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
  type SupportedProvider,
} from "@archestra/shared";
import { formatCompactNumber } from "@/lib/utils/format-compact-number";

// Pure formatting for the LLM logs table cells. Nothing here renders; the cell
// components in this folder do.

/** One row of the LLM logs table: a session, or a lone interaction. */
export type LogSession =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];

// ============================================================================
// Models
// ============================================================================

/**
 * Where a model's logo and second-line name come from.
 *
 * - `maker`: the model id names who made it (Claude → Anthropic), whichever
 *   provider served it.
 * - `aggregator`: the id is not recognisable, but the request went through a
 *   provider that serves other vendors' models (OpenRouter, Bedrock, …), so
 *   that provider is the honest answer. Its name is the organization's label
 *   for the provider, which the caller resolves.
 * - `unknown`: neither; `name` is a best guess at the vendor, never
 *   "Unknown provider".
 */
type ModelOrigin =
  | { kind: "maker"; provider: SupportedProvider; name: string }
  | { kind: "aggregator"; provider: SupportedProvider }
  | { kind: "unknown"; name: string };

export function describeModelOrigin(params: {
  model: string;
  interactionType: string | null | undefined;
}): ModelOrigin {
  const maker = makerProviderForModel(params.model);
  if (maker) {
    return { kind: "maker", provider: maker, name: MODEL_MAKER_NAMES[maker] };
  }
  const servedBy = params.interactionType?.split(":")[0];
  const aggregator = AGGREGATOR_PROVIDERS.find(
    (provider) => provider === servedBy,
  );
  if (aggregator) {
    return { kind: "aggregator", provider: aggregator };
  }
  return { kind: "unknown", name: unrecognisedVendorName(params.model) };
}

/**
 * A model id as people say it: `claude-opus-4-1-20250805` → `Opus 4.1`,
 * `meta-llama/llama-3.3-70b-instruct:free` → `Llama 3.3 70B`. The raw id stays
 * one hover away, so this only has to be readable, not reversible.
 */
export function shortModelName(model: string): string {
  let id = model.split("/").pop() || model;
  const [base, tag] = id.split(":");
  id = base
    // Bedrock ids carry a region and vendor prefix: `us.anthropic.claude-…`.
    .replace(/^(?:(?:us|eu|apac|global)\.)?[a-z0-9-]+\.(?=[a-z])/, "")
    .replace(/-v\d+$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  // An Ollama-style size tag (`qwen2.5:7b`) is part of the name; other tags
  // (`:free`, Bedrock's `:0`) are not.
  const size = tag && SIZE_PATTERN.test(tag) ? ` ${tag.toUpperCase()}` : "";

  const modern = id.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/);
  if (modern) {
    return `${capitalize(modern[1])} ${version(modern[2], modern[3])}`;
  }
  const legacy = id.match(/^claude-(\d+)(?:[-.](\d+))?-(opus|sonnet|haiku)/);
  if (legacy) {
    return `${capitalize(legacy[3])} ${version(legacy[1], legacy[2])}`;
  }
  const embedding = id.match(/^text-embedding-(.+)$/);
  if (embedding) {
    return `Embedding ${embedding[1].split("-").map(formatWord).join(" ")}`;
  }

  id = id.replace(/-(instruct|chat|it)$/, "");
  if (/^gpt-/.test(id)) {
    const [, gptVersion, ...rest] = id.split("-");
    return [`GPT-${gptVersion}`, ...rest.map(formatWord)].join(" ") + size;
  }
  return (
    id
      .split("-")
      .filter(Boolean)
      .map((part, index) => (index === 0 ? capitalize(part) : formatWord(part)))
      .join(" ") + size
  );
}

/** OpenRouter marks its free variants with a `:free` suffix. */
export function isFreeTierModel(model: string): boolean {
  return model.endsWith(":free");
}

// ============================================================================
// Usage and time
// ============================================================================

/** Dollars at a glance; the exact figure lives in the cell's tooltip. */
export function formatUsageCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${formatCompactNumber(value)}`;
}

/**
 * One request's dollars. A single request routinely costs a fraction of a
 * cent, where {@link formatUsageCost}'s "<$0.01" would make every row look
 * the same, so small amounts keep two significant figures ($0.005, $0.061)
 * instead of the six decimals of the exact figure.
 */
export function formatRequestCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.0001) return "<$0.0001";
  if (value < 0.1) return `$${Number(value.toPrecision(2))}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${formatCompactNumber(value)}`;
}

export { formatCompactNumber };

/** Wall-clock span between a session's first and last request. */
export function formatSessionSpan(
  start: Date | string,
  end: Date | string,
): string {
  const diffMs = Math.max(
    0,
    new Date(end).getTime() - new Date(start).getTime(),
  );
  if (diffMs < 1000) return `${diffMs}ms`;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

// ============================================================================
// People, agents, sources
// ============================================================================

/** Up to two initials, e.g. "Priya Raman" → "PR", "ci-runner" → "CR". */
export function initialsOf(name: string): string {
  return (
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

/**
 * The same seed always lands on the same one of 12 evenly spaced hues. Twelve
 * read as distinct at avatar size; a continuous wheel puts neighbours on
 * colours nobody can tell apart.
 */
export function identiconHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return 18 + (Math.abs(hash) % 12) * 30;
}

export function sourceLabel(source: InteractionSource): string {
  return INTERACTION_SOURCE_DISPLAY[source]?.label ?? source;
}

/** Each source that wrote to a session, once. */
export function uniqueSources(session: {
  sources?: (InteractionSource | null)[] | null;
}): InteractionSource[] {
  return Array.from(
    new Set(
      (session.sources ?? []).filter((source): source is InteractionSource =>
        Boolean(source),
      ),
    ),
  );
}

export function isKnowledgeSource(
  source: InteractionSource | null | undefined,
): source is KnowledgeSource {
  return Boolean(source?.startsWith("knowledge:"));
}

/**
 * A knowledge-base row has no prompt to show, so its title says what the call
 * did. The row already says "Knowledge base" elsewhere; repeating
 * "Knowledge - Embedding" as its title said it twice.
 */
export function knowledgeTaskTitle(source: KnowledgeSource): string {
  return KNOWLEDGE_TASK_TITLES[source];
}

// ============================================================================
// Internal helpers
// ============================================================================

type KnowledgeSource = Extract<InteractionSource, `knowledge:${string}`>;

const KNOWLEDGE_TASK_TITLES: Record<KnowledgeSource, string> = {
  "knowledge:embedding": "Embedding documents",
  "knowledge:reranker": "Reranking search results",
  "knowledge:query-expansion": "Expanding a search query",
  "knowledge:contextual-retrieval": "Adding context to chunks",
  "knowledge:ocr": "Reading scanned pages",
};

const SIZE_PATTERN = /^\d+(\.\d+)?[bmk]$/i;

/**
 * Who made a model, by provider id. These name the vendor of the weights, not
 * the provider integration a request went through, so they deliberately do not
 * follow an organization's provider renames (that is what the `aggregator`
 * origin and the provider catalog are for).
 */
const MODEL_MAKER_NAMES = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google",
  mistral: "Mistral",
  cohere: "Cohere",
  xai: "xAI",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  kimi: "Moonshot",
  zhipuai: "Zhipu",
  minimax: "MiniMax",
  voyage: "Voyage",
} as const satisfies Partial<Record<SupportedProvider, string>>;

type ModelMakerProvider = keyof typeof MODEL_MAKER_NAMES;

/** Providers that serve other vendors' models. */
const AGGREGATOR_PROVIDERS: readonly SupportedProvider[] = [
  "openrouter",
  "bedrock",
  "azure",
  "groq",
  "cerebras",
  "vllm",
  "ollama",
  "ollama-native",
  "github-copilot",
];

function makerProviderForModel(model: string): ModelMakerProvider | null {
  const id = model.toLowerCase();
  const base = id.split("/").pop() || id;
  if (id.includes("claude")) return "anthropic";
  if (/^(gpt|o\d|chatgpt|text-embedding|codex|davinci|whisper)/.test(base)) {
    return "openai";
  }
  if (/^(gemini|gemma|embedding-0)/.test(base)) return "gemini";
  if (
    /^(mistral|mixtral|codestral|magistral|ministral|pixtral|devstral)/.test(
      base,
    )
  ) {
    return "mistral";
  }
  if (/^(command|embed-|rerank-v)/.test(base)) return "cohere";
  if (base.startsWith("grok")) return "xai";
  if (base.startsWith("deepseek")) return "deepseek";
  if (base.startsWith("sonar")) return "perplexity";
  if (/^(kimi|moonshot)/.test(base)) return "kimi";
  if (base.startsWith("glm")) return "zhipuai";
  if (/^(minimax|abab)/.test(base)) return "minimax";
  if (base.startsWith("voyage")) return "voyage";
  return null;
}

function unrecognisedVendorName(model: string): string {
  const id = model.toLowerCase();
  const prefix = id.includes("/") ? id.split("/")[0] : null;
  const base = id.split("/").pop() || id;
  for (const [pattern, name] of OPEN_WEIGHT_VENDORS) {
    if ((prefix && pattern.test(prefix)) || pattern.test(base)) return name;
  }
  if (prefix) return capitalize(prefix.replace(/-.*$/, ""));
  return "Self-hosted";
}

const OPEN_WEIGHT_VENDORS: ReadonlyArray<[RegExp, string]> = [
  [/^(meta|llama)/, "Meta"],
  [/^qwen/, "Qwen"],
  [/^(microsoft|phi)/, "Microsoft"],
  [/^(nvidia|nemotron)/, "NVIDIA"],
  [/^(ibm|granite)/, "IBM"],
];

function version(major: string, minor: string | undefined): string {
  return minor ? `${major}.${minor}` : major;
}

function formatWord(part: string): string {
  if (SIZE_PATTERN.test(part)) return part.toUpperCase();
  if (/^(mini|nano|preview|large|small|medium|turbo)$/.test(part)) {
    return part;
  }
  return /^[a-z]/.test(part) ? capitalize(part) : part;
}

function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}
