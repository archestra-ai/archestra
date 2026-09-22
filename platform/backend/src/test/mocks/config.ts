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
 *
 * The real named exports are carried over for the same reason: replacing the
 * module with `{ default }` alone leaves every helper it also exports
 * undefined, and the route under test fails with a 500 the moment it reaches
 * one. Only `default` is overridable, so a named export always behaves as it
 * does in production.
 */
export async function configModuleMock(
  overrides: DeepPartial<typeof import("@/config").default> = {},
) {
  const actual = await vi.importActual<typeof import("@/config")>("@/config");
  return {
    ...actual,
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
