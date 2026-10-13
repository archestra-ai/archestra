// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  Authority,
  BlockCoverage,
  RemediesView,
  Sanitizer,
} from "@/lib/openappa-remedies.query";
import { coverChips, forTools, groupBySource, runsAs } from "./remedies.utils";

function authority(overrides: Partial<Authority> = {}): Authority {
  return {
    kind: "authority",
    name: "human",
    source: { entry: null, battery: null, line: 12 },
    implementation: { kind: "hitl", detail: "hitl" },
    tags: [],
    permits: {
      attention: ["*"],
      audienceMissing: [],
      trustBelow: null,
      effectsContaining: [],
    },
    lastConsult: null,
    ...overrides,
  };
}

function sanitizer(overrides: Partial<Sanitizer> = {}): Sanitizer {
  return {
    kind: "sanitizer",
    name: "redact-secrets",
    source: {
      entry: "batteries/claude-code/appa.toml",
      battery: "claude-code",
      line: 470,
    },
    implementation: { kind: "builtin", detail: "redact-secrets" },
    tags: [],
    on: ["tool_output"],
    permits: { kind: "audience", from: ["self"], to: ["public"] },
    lastConsult: null,
    ...overrides,
  };
}

function view(overrides: Partial<RemediesView> = {}): RemediesView {
  return {
    authorities: [],
    sanitizers: [],
    blocks: [
      {
        kind: "trust",
        level: "suspicious",
        approvers: [],
        cleaners: ["attest-schema"],
        unservedMarks: [],
        covered: true,
      },
    ],
    ...overrides,
  };
}

describe("runsAs", () => {
  test("groups implementations by who answers, and null when not wired", () => {
    expect(runsAs(authority())).toBe("a person reviews");
    expect(
      runsAs(authority({ implementation: { kind: "url", detail: "a.b" } })),
    ).toBe("an HTTP service");
    expect(
      runsAs(sanitizer({ implementation: { kind: "llm", detail: "llm" } })),
    ).toBe("a model decides");
    expect(
      runsAs(sanitizer({ implementation: { kind: "command", detail: "py" } })),
    ).toBe("a local program");
    expect(runsAs(sanitizer())).toBe("built in");
    expect(runsAs(authority({ implementation: null }))).toBeNull();
  });
});

describe("coverChips", () => {
  test("an authority gets one chip per permit, with the wildcard spelled any", () => {
    expect(
      coverChips(
        authority({
          permits: {
            attention: ["*"],
            audienceMissing: ["public"],
            trustBelow: "trusted",
            effectsContaining: ["email.sent"],
          },
        }),
      ),
    ).toEqual([
      { lock: "Approvals", value: "any", code: false },
      { lock: "Audience", value: "up to public", code: false },
      { lock: "Trust", value: "up to trusted", code: false },
      { lock: "Effects", value: "email.sent", code: true },
    ]);
    expect(
      coverChips(
        authority({
          permits: {
            attention: ["finance-signoff"],
            audienceMissing: [],
            trustBelow: null,
            effectsContaining: [],
          },
        }),
      ),
    ).toEqual([{ lock: "Approvals", value: "finance-signoff", code: true }]);
  });

  test("a sanitizer gets its one transition", () => {
    expect(coverChips(sanitizer())).toEqual([
      { lock: "Audience", value: "self → public", code: true },
    ]);
    expect(
      coverChips(
        sanitizer({
          permits: { kind: "trust", from: "suspicious", to: "trusted" },
        }),
      ),
    ).toEqual([{ lock: "Trust", value: "suspicious → trusted", code: true }]);
    expect(coverChips(sanitizer({ permits: null }))).toEqual([]);
  });
});

describe("forTools", () => {
  test("a sanitizer names the data it touches; an authority only its tags", () => {
    expect(forTools(sanitizer())).toEqual({ prefix: "results of", tags: [] });
    expect(
      forTools(sanitizer({ on: ["tool_input"], tags: ["slack"] })),
    ).toEqual({ prefix: "arguments of", tags: ["slack"] });
    expect(forTools(authority({ tags: ["finance"] }))).toEqual({
      prefix: null,
      tags: ["finance"],
    });
  });
});

describe("groupBySource", () => {
  test("the root comes first, then each battery in include order", () => {
    const groups = groupBySource(
      view({
        authorities: [
          authority({
            name: "support-reviewer",
            source: { entry: "b/support", battery: "support", line: 1 },
          }),
          authority(),
        ],
        sanitizers: [sanitizer()],
      }),
    );
    expect(
      groups.map((group) => [group.battery, group.remedies.map((r) => r.name)]),
    ).toEqual([
      [null, ["human"]],
      ["support", ["support-reviewer"]],
      ["claude-code", ["redact-secrets"]],
    ]);
  });
});
