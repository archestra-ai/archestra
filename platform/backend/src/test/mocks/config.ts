import { vi } from "vitest";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Canonical module mock for `@/config`: the REAL config deep-merged with the
 * test's overrides.
 *
 * ```ts
 * vi.mock("@/config", async () =>
 *   (await import("@/test/mocks/config")).configModuleMock({
 *     kb: { taskWorkerPollIntervalSeconds: 1 },
 *   }),
 * );
 * ```
 *
 * Starting from the actual config keeps every field the module under test
 * incidentally reads populated — bespoke `{ default: { kb: {...} } }`
 * factories silently drop the rest of the config and break the first time
 * the code under test touches another key.
 */
export async function configModuleMock(
  overrides: DeepPartial<typeof import("@/config").default> = {},
) {
  const actual = await vi.importActual<typeof import("@/config")>("@/config");
  return {
    default: deepMerge(structuredClone(actual.default), overrides),
  };
}

function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const value = overrides[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof base[key] === "object" &&
      base[key] !== null
    ) {
      deepMerge(base[key], value as DeepPartial<T[keyof T]>);
    } else {
      base[key] = value as T[keyof T];
    }
  }
  return base;
}
