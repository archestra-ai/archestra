export type SortingHatHouse =
  | "gryffindor"
  | "slytherin"
  | "ravenclaw"
  | "hufflepuff";

const HOUSES = new Set<SortingHatHouse>([
  "gryffindor",
  "slytherin",
  "ravenclaw",
  "hufflepuff",
]);

export function getSortingHatHouse(value: unknown): SortingHatHouse | null {
  const candidates = [
    readPath(value, ["_meta", "sortingHat", "house"]),
    readPath(value, ["_meta", "sorting_hat", "house"]),
    readPath(value, ["structuredContent", "sortingHat", "house"]),
    readPath(value, ["structuredContent", "sorting_hat", "house"]),
    readPath(value, ["sortingHat", "house"]),
    readPath(value, ["sorting_hat", "house"]),
    readPath(value, ["house"]),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = candidate.toLowerCase();
      if (HOUSES.has(normalized as SortingHatHouse)) {
        return normalized as SortingHatHouse;
      }
    }
  }

  return null;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
