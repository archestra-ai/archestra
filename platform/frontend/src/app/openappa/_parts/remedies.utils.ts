import type {
  Authority,
  BlockCoverage,
  RemediesView,
  Remedy,
  Sanitizer,
} from "@/lib/openappa-remedies.query";

/** Who answers a consult, grouped for the panel's bar and the table's column. */
export type RunsAs = {
  key: "people" | "services" | "models" | "programs" | "builtIn";
  /** The bar legend, plural. */
  label: string;
  /** The table cell. */
  phrase: string;
  color: string;
};

const RUNS_AS: Record<RunsAs["key"], RunsAs> = {
  people: {
    key: "people",
    label: "people",
    phrase: "a person reviews",
    color: "var(--color-blue-400)",
  },
  services: {
    key: "services",
    label: "services",
    phrase: "an HTTP service",
    color: "var(--color-violet-400)",
  },
  models: {
    key: "models",
    label: "models",
    phrase: "a model decides",
    color: "var(--color-pink-400)",
  },
  programs: {
    key: "programs",
    label: "programs",
    phrase: "a local program",
    color: "var(--color-amber-400)",
  },
  builtIn: {
    key: "builtIn",
    label: "built in",
    phrase: "built in",
    color: "var(--color-teal-400)",
  },
};

/** Null when the remedy is declared but no `[externals.*]` entry wires it. */
export function runsAs(remedy: Remedy): RunsAs | null {
  switch (remedy.implementation?.kind) {
    case "hitl":
      return RUNS_AS.people;
    case "url":
      return RUNS_AS.services;
    case "llm":
    case "claude_code":
      return RUNS_AS.models;
    case "command":
    case "module":
      return RUNS_AS.programs;
    case "approve":
    case "builtin":
      return RUNS_AS.builtIn;
    default:
      return null;
  }
}

/** How many wired remedies each kind of implementation runs, for a bar; empty groups left out. */
export function runsAsBreakdown(
  remedies: Remedy[],
): (RunsAs & { count: number })[] {
  const counts = new Map<RunsAs["key"], number>();
  for (const remedy of remedies) {
    const group = runsAs(remedy);
    if (group) counts.set(group.key, (counts.get(group.key) ?? 0) + 1);
  }
  return Object.values(RUNS_AS).flatMap((group) => {
    const count = counts.get(group.key) ?? 0;
    return count > 0 ? [{ ...group, count }] : [];
  });
}

/** One kind of block a remedy lifts, as `Lock · value`. */
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

/** One line of the Gaps panel: a kind of block, or the wiring check. */
export type GapLine = {
  key: BlockCoverage["kind"] | "wiring";
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

const BLOCK_NEED: Record<BlockCoverage["kind"], string> = {
  trust: "need trusted data",
  audience: "limit who may read",
  effects: "exclude an earlier effect",
  approvals: "need an approval mark",
};

const rules = (count: number) => `${count} ${count === 1 ? "rule" : "rules"}`;
const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The lines the Gaps panel shows: every kind of block some rule can cause,
 * then the wiring check when a remedy is declared but not wired. A kind no
 * rule uses is left out.
 */
export function gapLines(view: RemediesView): GapLine[] {
  const lines = view.blocks.flatMap((block): GapLine[] => {
    if (block.rules === 0) return [];
    const label = BLOCK_LABEL[block.kind];
    if (block.kind === "approvals")
      return [
        block.covered
          ? {
              key: block.kind,
              label,
              text: `${rules(block.rules)} · every mark has an approver`,
              covered: true,
            }
          : {
              key: block.kind,
              label,
              text: `${plural(block.unservedMarks.length, "mark", "marks")} nobody gives: ${block.unservedMarks.join(", ")}`,
              covered: false,
            },
      ];
    const lifts = [
      block.approvers > 0 ? `${block.approvers} approve` : null,
      block.cleaners > 0 ? `${block.cleaners} clean` : null,
    ].filter((each) => each !== null);
    return [
      {
        key: block.kind,
        label,
        text: block.covered
          ? `${rules(block.rules)} · ${lifts.join(", ")}`
          : `${rules(block.rules)} ${BLOCK_NEED[block.kind]} · no remedy`,
        covered: block.covered,
      },
    ];
  });
  const unwired = [...view.authorities, ...view.sanitizers].filter(
    (remedy) => !isWired(remedy),
  );
  if (unwired.length > 0)
    lines.push({
      key: "wiring",
      label: "Wiring",
      text: `${plural(unwired.length, "remedy", "remedies")} declared but not wired: ${unwired.map((each) => each.name).join(", ")}`,
      covered: false,
    });
  return lines;
}

/** How many Gaps lines are not covered: the panel's number. */
export function gapCount(view: RemediesView): number {
  return gapLines(view).filter((line) => !line.covered).length;
}
