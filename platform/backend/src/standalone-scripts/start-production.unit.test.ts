import { describe, expect, it } from "vitest";
// A namespace import keeps the module specifier on the directive's line.
// @ts-expect-error — plain ESM module that starts the server in the image
import * as startProduction from "../../scripts/start-production.mjs";

const { maxOldSpaceSizeMib, serverArguments } = startProduction;

const heap = (env: Record<string, string>) => maxOldSpaceSizeMib(env);

describe("maxOldSpaceSizeMib", () => {
  it.each([
    ["3072", 1843],
    ["2048", 1228],
  ])("uses 60%% of a %s MiB memory limit", (limit, expected) => {
    expect(heap({ ARCHESTRA_NODE_MEMORY_LIMIT_MIB: limit })).toBe(expected);
  });

  it("falls back to 75% of the memory request", () => {
    expect(heap({ ARCHESTRA_NODE_MEMORY_REQUEST_MIB: "2048" })).toBe(1536);
  });

  it("prefers an explicit override and supports disabling with zero", () => {
    expect(
      heap({
        ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB: "1700",
        ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
      }),
    ).toBe(1700);
    expect(
      heap({
        ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB: "0",
        ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
      }),
    ).toBeNull();
  });

  it.each([
    "--max-old-space-size=1600",
    "--max_old_space_size 1600",
    "--inspect --max-old-space-size=1600",
  ])("preserves an existing NODE_OPTIONS limit: %s", (nodeOptions) => {
    expect(
      heap({
        NODE_OPTIONS: nodeOptions,
        ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
      }),
    ).toBeNull();
  });

  it("fails fast for an invalid explicit override", () => {
    expect(() =>
      heap({ ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB: "large" }),
    ).toThrow("must be a non-negative integer");
  });

  it("ignores malformed discovered values", () => {
    expect(
      heap({
        ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "not-a-number",
        ARCHESTRA_NODE_MEMORY_REQUEST_MIB: "also-invalid",
      }),
    ).toBeNull();
  });

  it("subtracts a reservation from the limit before taking the percentage", () => {
    // The web container also runs the Next.js server, so 60% of the whole limit
    // would hand the backend a heap it cannot have: 60% of 3072 is 1843, and
    // 1843 of heap plus native, the co-located server and slab exceeds 3072
    // before V8 ever reaches its ceiling. 60% of (3072 - 384) does not.
    expect(
      heap({
        ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
        ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "384",
      }),
    ).toBe(1612);
  });

  it("applies the reservation to the request fallback too", () => {
    expect(
      heap({
        ARCHESTRA_NODE_MEMORY_REQUEST_MIB: "2048",
        ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "384",
      }),
    ).toBe(1248);
  });

  it("is unchanged when no reservation is set", () => {
    // Single-process containers (worker, renderer) must keep their existing
    // ceiling — the reservation is scoped to containers that co-locate a process.
    expect(heap({ ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "2048" })).toBe(1228);
    expect(
      heap({
        ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "2048",
        ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "0",
      }),
    ).toBe(1228);
  });

  it("ignores a reservation that would consume the whole limit", () => {
    // Obeying it would emit no flag at all, silently handing the process back
    // Node's cgroup default — a bigger heap than either value asked for, which
    // is the opposite of what a misconfigured reservation intends.
    expect(
      heap({
        ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "512",
        ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "1024",
      }),
    ).toBe(307);
  });

  it("fails fast for an invalid reservation", () => {
    expect(() =>
      heap({
        ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "3072",
        ARCHESTRA_NODE_MEMORY_RESERVED_MIB: "lots",
      }),
    ).toThrow("must be a non-negative integer");
  });
});

describe("serverArguments", () => {
  it("reports fatal errors into the diagnostics directory, with a heap limit and no source maps", () => {
    const { args, diagnosticDir, messages } = serverArguments({
      ARCHESTRA_NODE_MEMORY_LIMIT_MIB: "2048",
    });
    expect(diagnosticDir).toBe("/app/data/diagnostics");
    expect(args).toEqual([
      "--report-on-fatalerror",
      "--report-uncaught-exception",
      "--diagnostic-dir=/app/data/diagnostics",
      "--max-old-space-size=1228",
    ]);
    expect(messages).toEqual(["Configuring Node old-space limit: 1228 MiB"]);
  });

  it("turns source maps on only when asked for, in every deployment", () => {
    for (const quickstart of ["true", "false", undefined]) {
      expect(
        serverArguments({ ARCHESTRA_QUICKSTART: quickstart }).args,
      ).not.toContain("--enable-source-maps");
      expect(
        serverArguments({
          ARCHESTRA_QUICKSTART: quickstart,
          ARCHESTRA_NODE_SOURCE_MAPS: "true",
        }).args,
      ).toContain("--enable-source-maps");
    }
    expect(
      serverArguments({ ARCHESTRA_NODE_SOURCE_MAPS: "false" }).args,
    ).not.toContain("--enable-source-maps");
  });

  it("warns about an invalid source maps setting and keeps them off", () => {
    const { args, messages } = serverArguments({
      ARCHESTRA_NODE_SOURCE_MAPS: "yes",
    });
    expect(args).not.toContain("--enable-source-maps");
    expect(messages).toEqual([
      "WARNING: ARCHESTRA_NODE_SOURCE_MAPS must be true or false, using false",
    ]);
  });

  it("uses the configured diagnostics directory and heap snapshot count", () => {
    const { args } = serverArguments({
      ARCHESTRA_NODE_DIAGNOSTIC_DIR: "/var/diagnostics",
      ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT: "2",
    });
    expect(args).toContain("--diagnostic-dir=/var/diagnostics");
    expect(args).toContain("--heapsnapshot-near-heap-limit=2");
  });
});
