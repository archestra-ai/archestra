import type {
  Authority,
  RemediesView,
  Remedy,
  Sanitizer,
} from "@/lib/openappa-remedies.query";

/** Who answers a consult, as the table phrases it; null when no `[externals.*]` entry wires it. */
export function runsAs(remedy: Remedy): string | null {
  switch (remedy.implementation?.kind) {
    case "hitl":
      return "a person reviews";
    case "url":
      return "an HTTP service";
    case "llm":
    case "claude_code":
      return "a model decides";
    case "command":
    case "module":
      return "a local program";
    case "approve":
    case "builtin":
      return "built in";
    default:
      return null;
  }
}

/** One kind of block an authority or sanitizer lifts, as `Lock · value`. */
export type CoverChip = {
  lock: "Approvals" | "Audience" | "Trust" | "Effects";
  value: string;
  /** Whether the value is a policy spelling, shown in monospace. */
  code: boolean;
};

export function coverChips(remedy: Remedy): CoverChip[] {
  if (remedy.kind === "authority") return authorityChips(remedy);
  return sanitizerChips(remedy);
}

function authorityChips(authority: Authority): CoverChip[] {
  const { attention, audienceMissing, trustBelow, effectsContaining } =
    authority.permits;
  return [
    ...(attention.includes("*")
      ? [{ lock: "Approvals" as const, value: "any", code: false }]
      : attention.map((mark) => ({
          lock: "Approvals" as const,
          value: mark,
          code: true,
        }))),
    ...audienceMissing.map((audience) => ({
      lock: "Audience" as const,
      value: `up to ${audience}`,
      code: false,
    })),
    ...(trustBelow
      ? [{ lock: "Trust" as const, value: `up to ${trustBelow}`, code: false }]
      : []),
    ...effectsContaining.map((effect) => ({
      lock: "Effects" as const,
      value: effect,
      code: true,
    })),
  ];
}

function sanitizerChips(sanitizer: Sanitizer): CoverChip[] {
  const permits = sanitizer.permits;
  if (!permits) return [];
  if (permits.kind === "trust")
    return [
      { lock: "Trust", value: `${permits.from} → ${permits.to}`, code: true },
    ];
  return [
    {
      lock: "Audience",
      value: `${permits.from.join(", ")} → ${permits.to.join(", ")}`,
      code: true,
    },
  ];
}

/**
 * Which tools the remedy may act on, and for a sanitizer which part of a
 * call: the data-kind prefix, then the tags, or "any tool" when untagged.
 */
export function forTools(remedy: Remedy): {
  prefix: string | null;
  tags: string[];
} {
  const prefix =
    remedy.kind === "sanitizer"
      ? remedy.on.includes("tool_input")
        ? remedy.on.includes("tool_output")
          ? "results and arguments of"
          : "arguments of"
        : "results of"
      : null;
  return { prefix, tags: remedy.tags };
}

export function isWired(remedy: Remedy): boolean {
  return remedy.implementation !== null;
}

/** The remedies in one declaring file, the root first, then batteries in include order. */
export type RemedySourceGroup = {
  key: string;
  battery: string | null;
  entry: string | null;
  remedies: Remedy[];
};

export function groupBySource(view: RemediesView): RemedySourceGroup[] {
  const groups = new Map<string, RemedySourceGroup>();
  for (const remedy of [...view.authorities, ...view.sanitizers]) {
    const key = remedy.source.entry ?? "";
    const group = groups.get(key) ?? {
      key,
      battery: remedy.source.battery,
      entry: remedy.source.entry,
      remedies: [],
    };
    group.remedies.push(remedy);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.entry === null ? -1 : b.entry === null ? 1 : 0,
  );
}

/** One line of the Gaps panel: a level data can carry, a kind of block, or the wiring check. */
