import { describe, expect, test } from "vitest";
import { calculateVitestResourceLimits } from "./vitest-resource-limits";

const GIB = 1024 ** 3;

describe("calculateVitestResourceLimits", () => {
  test("keeps a large developer machine below the local CPU and heap caps", () => {
    expect(
      calculateVitestResourceLimits({
        isCI: false,
        availableParallelism: 18,
        totalMemoryBytes: 64 * GIB,
      }),
    ).toEqual({ maxWorkers: 4, maxOldSpaceMb: 3072 });
  });

  test("scales down further on ordinary developer hardware", () => {
    expect(
      calculateVitestResourceLimits({
        isCI: false,
        availableParallelism: 8,
        totalMemoryBytes: 16 * GIB,
      }),
    ).toEqual({ maxWorkers: 1, maxOldSpaceMb: 3072 });
    expect(
      calculateVitestResourceLimits({
        isCI: false,
        availableParallelism: 4,
        totalMemoryBytes: 8 * GIB,
      }),
    ).toEqual({ maxWorkers: 1, maxOldSpaceMb: 2048 });
  });

  test("preserves the existing throughput-oriented CI sizing", () => {
    expect(
      calculateVitestResourceLimits({
        isCI: true,
        availableParallelism: 16,
        totalMemoryBytes: 64 * GIB,
      }),
    ).toEqual({ maxWorkers: 12, maxOldSpaceMb: 4096 });
  });
});
