export const SORTING_HAT_HOUSES = [
  "gryffindor",
  "slytherin",
  "ravenclaw",
  "hufflepuff",
] as const;

export type SortingHatHouse = (typeof SORTING_HAT_HOUSES)[number];

export type PatronusCastResult = {
  form: string;
  corporeal: boolean;
};

export type SortingHatMeta = {
  house: SortingHatHouse;
  confidence: number;
  monologue?: string[];
  patronus?: PatronusCastResult;
  floo?: {
    fromServer: string;
    toServer: string;
    particles: Array<{ color: "green"; size: number; delayMs: number }>;
  };
};

export const SORTING_HAT_META_KEY = "sortingHat";

export function isSortingHatHouse(value: unknown): value is SortingHatHouse {
  return (
    typeof value === "string" &&
    (SORTING_HAT_HOUSES as readonly string[]).includes(value)
  );
}

export function getSortingHatMeta(value: unknown): SortingHatMeta | null {
  if (!isRecord(value)) return null;
  const meta = value._meta;
  if (!isRecord(meta)) return null;
  const sortingHat = meta[SORTING_HAT_META_KEY];
  if (!isRecord(sortingHat) || !isSortingHatHouse(sortingHat.house)) {
    return null;
  }

  const confidence =
    typeof sortingHat.confidence === "number" ? sortingHat.confidence : 0;
  return {
    house: sortingHat.house,
    confidence,
    monologue: Array.isArray(sortingHat.monologue)
      ? sortingHat.monologue.filter((chunk): chunk is string => {
          return typeof chunk === "string";
        })
      : undefined,
    patronus: parsePatronus(sortingHat.patronus),
    floo: parseFloo(sortingHat.floo),
  };
}

function parsePatronus(value: unknown): PatronusCastResult | undefined {
  if (!isRecord(value) || typeof value.form !== "string") return undefined;
  return {
    form: value.form,
    corporeal: value.corporeal === true,
  };
}

function parseFloo(value: unknown): SortingHatMeta["floo"] | undefined {
  if (
    !isRecord(value) ||
    typeof value.fromServer !== "string" ||
    typeof value.toServer !== "string" ||
    !Array.isArray(value.particles)
  ) {
    return undefined;
  }

  return {
    fromServer: value.fromServer,
    toServer: value.toServer,
    particles: value.particles.filter(isRecord).map((particle) => ({
      color: "green" as const,
      size: typeof particle.size === "number" ? particle.size : 1,
      delayMs: typeof particle.delayMs === "number" ? particle.delayMs : 0,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
