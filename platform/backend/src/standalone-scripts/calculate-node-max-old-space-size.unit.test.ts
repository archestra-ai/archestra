import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL(
    "../../scripts/calculate-node-max-old-space-size.sh",
    import.meta.url,
  ),
);

const run = (env: Record<string, string> = {}) =>
  spawnSync(script, [], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...env,
    },
  });

describe("calculate-node-max-old-space-size.sh", () => {
  it.each([
    ["3072", "1843"],
    ["2048", "1228"],
  ])("uses 60%% of a %s MiB memory limit", (limit, expected) => {
    const result = run({ ARCHESTRA_NODE_MEMORY_LIMIT_MIB: limit });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it("falls back to 75% of the memory request", () => {
    const result = run({ ARCHESTRA_NODE_MEMORY_REQUEST_MIB: "2048" });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("1536");
  });

  it("prefers an explicit override and supports disabling with zero", () => {
    const overridden = run({
      ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB: "1700",
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
    });
    const disabled = run({
      ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB: "0",
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
    });

    expect(overridden.stdout.trim()).toBe("1700");
    expect(disabled.stdout).toBe("");
  });

  it.each([
    "--max-old-space-size=1600",
    "--max_old_space_size 1600",
  ])("preserves an existing NODE_OPTIONS limit: %s", (nodeOptions) => {
    const result = run({
      NODE_OPTIONS: nodeOptions,
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails fast for an invalid explicit override", () => {
    const result = run({ ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB: "large" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a non-negative integer");
  });

  it("ignores malformed discovered values", () => {
    const result = run({
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "not-a-number",
      ARCHESTRA_NODE_MEMORY_REQUEST_MIB: "also-invalid",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("subtracts a reservation from the limit before taking the percentage", () => {
    // The web container also runs the Next.js server, so 60% of the whole limit
    // would hand the backend a heap it cannot have: 60% of 3072 is 1843, and
    // 1843 of heap plus native, the co-located server and slab exceeds 3072
    // before V8 ever reaches its ceiling. 60% of (3072 - 384) does not.
    const result = run({
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
      ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "384",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("1612");
  });

  it("applies the reservation to the request fallback too", () => {
    const result = run({
      ARCHESTRA_NODE_MEMORY_REQUEST_MIB: "2048",
      ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "384",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("1248");
  });

  it("is unchanged when no reservation is set", () => {
    // Single-process containers (worker, renderer) must keep their existing
    // ceiling — this change is scoped to containers that co-locate a process.
    const withoutReservation = run({
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "2048",
    });
    const withZero = run({
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "2048",
      ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "0",
    });

    expect(withoutReservation.stdout.trim()).toBe("1228");
    expect(withZero.stdout.trim()).toBe("1228");
  });

  it("ignores a reservation that would consume the whole limit", () => {
    // Obeying it would emit no flag at all, silently handing the process back
    // Node's cgroup default — a bigger heap than either value asked for, which
    // is the opposite of what a misconfigured reservation intends.
    const result = run({
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "512",
      ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "1024",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("307");
  });

  it("fails fast for an invalid reservation", () => {
    const result = run({
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
      ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "lots",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a non-negative integer");
  });
});
