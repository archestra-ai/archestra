import { describe, expect, test } from "vitest";
import {
  frontendVitestResourceLimits,
  parseCpuQuantity,
  parseMemoryQuantity,
  resourceEnvelope,
} from "../../../vitest.resources";
import { calculateVitestResourceLimits } from "./vitest-resource-limits";

const GIB = 1024 ** 3;

// An n2d-standard-8 node of the staging runtime pool, as the pod sees it.
const NODE = { hostParallelism: 8, hostMemoryBytes: 32 * GIB };

describe("resourceEnvelope", () => {
  test("is the machine when nothing constrains the process", () => {
    // Node reports no constraint as 0 or, on Linux without a cgroup limit, as
    // the largest unsigned 64-bit value.
    for (const constrainedMemoryBytes of [0, 18_446_744_073_709_552_000]) {
      expect(
        resourceEnvelope({
          hostParallelism: 32,
          hostMemoryBytes: 62 * GIB,
          constrainedMemoryBytes,
        }),
      ).toEqual({
        availableParallelism: 32,
        totalMemoryBytes: 62 * GIB,
        constrained: false,
      });
    }
  });

  test("takes the cgroup memory limit and the pod's CPU request in a runtime pod", () => {
    // Tier S: 2 CPU requested, no CPU limit, 8Gi memory limit. Node reports
    // the node's CPUs and the cgroup limit; the Agent Runtime names both.
    expect(
      resourceEnvelope({
        ...NODE,
        constrainedMemoryBytes: 8 * GIB,
        podCpuRequest: "2",
        podMemoryLimit: "8Gi",
      }),
    ).toEqual({
      availableParallelism: 2,
      totalMemoryBytes: 8 * GIB,
      constrained: true,
    });
  });

  test("uses the pod's limit when the process cannot read its cgroup", () => {
    expect(
      resourceEnvelope({
        ...NODE,
        constrainedMemoryBytes: undefined,
        podCpuRequest: "3500m",
        podMemoryLimit: "18Gi",
      }),
    ).toEqual({
      availableParallelism: 3,
      totalMemoryBytes: 18 * GIB,
      constrained: true,
    });
  });

  test("keeps the smaller figure when the signals disagree", () => {
    expect(
      resourceEnvelope({
        ...NODE,
        constrainedMemoryBytes: 16 * GIB,
        podMemoryLimit: "8Gi",
      }),
    ).toMatchObject({ availableParallelism: 8, totalMemoryBytes: 8 * GIB });
  });

  test("never reports less than one CPU", () => {
    expect(
      resourceEnvelope({
        ...NODE,
        constrainedMemoryBytes: 0,
        podCpuRequest: "500m",
      }).availableParallelism,
    ).toBe(1);
  });
});

describe("Kubernetes quantities", () => {
  test("memory", () => {
    expect(parseMemoryQuantity("8Gi")).toBe(8 * GIB);
    expect(parseMemoryQuantity("512Mi")).toBe(512 * 1024 ** 2);
    expect(parseMemoryQuantity("1.5Gi")).toBe(1.5 * GIB);
    expect(parseMemoryQuantity("8G")).toBe(8_000_000_000);
    expect(parseMemoryQuantity("1024")).toBe(1024);
    expect(parseMemoryQuantity(undefined)).toBe(0);
    expect(parseMemoryQuantity("lots")).toBe(0);
  });

  test("cpu", () => {
    expect(parseCpuQuantity("2")).toBe(2);
    expect(parseCpuQuantity("3.5")).toBe(3);
    expect(parseCpuQuantity("3500m")).toBe(3);
    expect(parseCpuQuantity("500m")).toBe(1);
    expect(parseCpuQuantity("0")).toBe(0);
    expect(parseCpuQuantity(undefined)).toBe(0);
  });
});

describe("sizing inside an Agent Runtime pod", () => {
  const tierS = resourceEnvelope({
    ...NODE,
    constrainedMemoryBytes: 8 * GIB,
    podCpuRequest: "2",
    podMemoryLimit: "8Gi",
  });
  const tierM = resourceEnvelope({
    ...NODE,
    constrainedMemoryBytes: 16 * GIB,
    podCpuRequest: "4",
    podMemoryLimit: "16Gi",
  });

  test("the backend suite gets one fork with a 2 GiB heap at tier S", () => {
    expect(calculateVitestResourceLimits({ isCI: false, ...tierS })).toEqual({
      maxWorkers: 1,
      maxOldSpaceMb: 2048,
    });
    // Sized for the node instead, the same pod got two forks of 3 GiB each.
    expect(
      calculateVitestResourceLimits({
        isCI: false,
        availableParallelism: NODE.hostParallelism,
        totalMemoryBytes: NODE.hostMemoryBytes,
      }),
    ).toEqual({ maxWorkers: 2, maxOldSpaceMb: 3072 });
  });

  test("the frontend suite gets one fork with a 4 GiB heap at tier S and two at tier M", () => {
    expect(frontendVitestResourceLimits(tierS)).toEqual({
      maxWorkers: 1,
      maxOldSpaceMb: 4096,
    });
    expect(frontendVitestResourceLimits(tierM)).toEqual({
      maxWorkers: 2,
      maxOldSpaceMb: 4096,
    });
  });

  test("the frontend suite keeps half the cores and the 8 GiB ceiling on a machine", () => {
    const laptop = resourceEnvelope({
      hostParallelism: 8,
      hostMemoryBytes: 16 * GIB,
      constrainedMemoryBytes: 0,
    });
    expect(frontendVitestResourceLimits(laptop)).toEqual({
      maxWorkers: 4,
      maxOldSpaceMb: 8192,
    });
    const workstation = resourceEnvelope({
      hostParallelism: 32,
      hostMemoryBytes: 62 * GIB,
      constrainedMemoryBytes: 0,
    });
    expect(frontendVitestResourceLimits(workstation)).toEqual({
      maxWorkers: 16,
      maxOldSpaceMb: 8192,
    });
  });
});
