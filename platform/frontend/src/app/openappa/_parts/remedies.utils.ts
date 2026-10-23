import type {
  Authority,
  RemediesView,
  Remedy,
  Sanitizer,
} from "@/lib/openappa-remedies.query";

/** One kind of block an authority or sanitizer lifts, as `lock value`, the lock spelled as in the policy. */
export type CoverChip = {
  lock: "attention" | "audience" | "trust" | "effects";
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
      ? [{ lock: "attention" as const, value: "any", code: false }]
      : attention.map((mark) => ({
          lock: "attention" as const,
          value: mark,
          code: true,
        }))),
    ...audienceMissing.map((audience) => ({
      lock: "audience" as const,
      value: `up to ${audience}`,
      code: false,
    })),
    ...(trustBelow
      ? [{ lock: "trust" as const, value: `up to ${trustBelow}`, code: false }]
      : []),
    ...effectsContaining.map((effect) => ({
      lock: "effects" as const,
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
      { lock: "trust", value: `${permits.from} → ${permits.to}`, code: false },
    ];
  return [
    {
      lock: "audience",
      value: `${permits.from.join(", ")} → ${permits.to.join(", ")}`,
      code: false,
    },
  ];
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
