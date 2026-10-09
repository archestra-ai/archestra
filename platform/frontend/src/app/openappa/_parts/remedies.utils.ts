import type {
  Authority,
  BlockCoverage,
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
export type GapLine = {
  key: string;
  label: string;
  text: string;
  covered: boolean;
};

const BLOCK_LABEL: Record<BlockCoverage["kind"], string> = {
  trust: "Trust",
  audience: "Audience",
  effects: "Effects",
  approvals: "Approvals",
};

const names = (list: string[]) => list.join(", ");
const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** The runtime's reserved sanitizer: it raises trust for subagent returns only. */
const ATTEST_SCHEMA = "attest-schema";

/**
 * The lines the Gaps panel shows: every trust rank and audience data can be
 * labelled with, and whether a blocked call can get past it; effects and
 * approval marks when some rule uses them; then the wiring check when an
 * authority or sanitizer is declared but not wired. Gaps come first, so the
 * number above them is explained before what is covered.
 */
export function gapLines(view: RemediesView): GapLine[] {
  const lines = view.blocks.map((block): GapLine => {
    const key = block.level ? `${block.kind}:${block.level}` : block.kind;
    const by = [...block.approvers, ...block.cleaners];
    if (block.kind === "approvals")
      return block.covered
        ? {
            key,
            label: BLOCK_LABEL.approvals,
            text: "every mark has an approver",
            covered: true,
          }
        : {
            key,
            label: BLOCK_LABEL.approvals,
            text: `${plural(block.unservedMarks.length, "mark", "marks")} nobody gives: ${names(block.unservedMarks)}`,
            covered: false,
          };
    if (block.kind === "effects")
      return {
        key,
        label: BLOCK_LABEL.effects,
        text: block.covered
          ? `can run after an excluded effect (${names(by)})`
          : "can't run after an excluded effect",
        covered: block.covered,
      };
    const label = `${block.level} data`;
    if (block.kind === "trust") {
      const onlySubagents =
        block.approvers.length === 0 &&
        block.cleaners.length > 0 &&
        block.cleaners.every((name) => name === ATTEST_SCHEMA);
      return {
        key,
        label,
        text: !block.covered
          ? "can't be made trusted"
          : onlySubagents
            ? `only subagent returns can be made trusted (${names(by)})`
            : `can be made trusted (${names(by)})`,
        covered: block.covered,
      };
    }
    return {
      key,
      label,
      text: block.covered
        ? `can be shared wider (${names(by)})`
        : "can't be shared wider",
      covered: block.covered,
    };
  });
  const unwired = [...view.authorities, ...view.sanitizers].filter(
    (remedy) => !isWired(remedy),
  );
  if (unwired.length > 0)
    lines.push({
      key: "wiring",
      label: "Wiring",
      text: `${unwired.length} declared but not wired: ${names(unwired.map((each) => each.name))}`,
      covered: false,
    });
  return [
    ...lines.filter((line) => !line.covered),
    ...lines.filter((line) => line.covered),
  ];
}

/** How many Gaps lines are not covered: the panel's number. */
export function gapCount(view: RemediesView): number {
  return gapLines(view).filter((line) => !line.covered).length;
}
