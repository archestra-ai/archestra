// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  Authority,
  RemediesView,
  Sanitizer,
} from "@/lib/openappa-remedies.query";
import {
  coverChips,
  forTools,
  gapCount,
  gapLines,
  groupBySource,
  runsAs,
  runsAsBreakdown,
} from "./remedies.utils";

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
        rules: 0,
        approvers: 0,
        cleaners: 0,
        unservedMarks: [],
        covered: true,
      },
      {
        kind: "audience",
        rules: 0,
        approvers: 0,
        cleaners: 0,
        unservedMarks: [],
        covered: true,
      },
      {
        kind: "effects",
        rules: 0,
        approvers: 0,
        cleaners: 0,
        unservedMarks: [],
        covered: true,
      },
      {
        kind: "approvals",
        rules: 0,
        approvers: 0,
        cleaners: 0,
        unservedMarks: [],
        covered: true,
      },
    ],
    ...overrides,
  };
}

describe("runsAs", () => {
  test("groups implementations by who answers, and null when not wired", () => {
    expect(runsAs(authority())?.phrase).toBe("a person reviews");
    expect(
      runsAs(authority({ implementation: { kind: "url", detail: "a.b" } }))
        ?.phrase,
    ).toBe("an HTTP service");
    expect(
      runsAs(sanitizer({ implementation: { kind: "llm", detail: "llm" } }))
        ?.phrase,
    ).toBe("a model decides");
    expect(
      runsAs(sanitizer({ implementation: { kind: "command", detail: "py" } }))
        ?.phrase,
    ).toBe("a local program");
    expect(runsAs(sanitizer())?.phrase).toBe("built in");
    expect(runsAs(authority({ implementation: null }))).toBeNull();
  });

  test("the breakdown counts wired remedies only, in a fixed order", () => {
    expect(
      runsAsBreakdown([
        sanitizer(),
        authority({ implementation: null }),
        authority(),
        authority({ name: "other" }),
      ]).map((group) => [group.label, group.count]),
    ).toEqual([
      ["people", 2],
      ["built in", 1],
    ]);
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

describe("gapLines", () => {
  test("a kind no rule uses is left out; an uncovered kind names what the rules need", () => {
    const lines = gapLines(
      view({
        blocks: [
          {
            kind: "trust",
            rules: 41,
            approvers: 0,
            cleaners: 0,
            unservedMarks: [],
            covered: false,
          },
          {
            kind: "audience",
            rules: 88,
            approvers: 3,
            cleaners: 12,
            unservedMarks: [],
            covered: true,
          },
          {
            kind: "effects",
            rules: 0,
            approvers: 0,
            cleaners: 0,
            unservedMarks: [],
            covered: true,
          },
          {
            kind: "approvals",
            rules: 9,
            approvers: 1,
            cleaners: 0,
            unservedMarks: ["monday-review", "sentry-review"],
            covered: false,
          },
        ],
      }),
    );
    expect(lines).toEqual([
      {
        key: "trust",
        label: "Trust",
        text: "41 rules need trusted data · no authority approves, no sanitizer cleans",
        covered: false,
      },
      {
        key: "approvals",
        label: "Approvals",
        text: "2 marks nobody gives: monday-review, sentry-review",
        covered: false,
      },
      {
        key: "audience",
        label: "Audience",
        text: "88 rules · 3 authorities approve, 12 sanitizers clean",
        covered: true,
      },
    ]);
  });

  test("a declared but unwired authority adds a wiring line, and every uncovered line counts as a gap", () => {
    const current = view({
      authorities: [
        authority(),
        authority({ name: "legal-reviewer", implementation: null }),
      ],
      blocks: [
        {
          kind: "trust",
          rules: 2,
          approvers: 0,
          cleaners: 0,
          unservedMarks: [],
          covered: false,
        },
        {
          kind: "audience",
          rules: 0,
          approvers: 0,
          cleaners: 0,
          unservedMarks: [],
          covered: true,
        },
        {
          kind: "effects",
          rules: 0,
          approvers: 0,
          cleaners: 0,
          unservedMarks: [],
          covered: true,
        },
        {
          kind: "approvals",
          rules: 1,
          approvers: 1,
          cleaners: 0,
          unservedMarks: [],
          covered: true,
        },
      ],
    });
    expect(gapLines(current).map((line) => line.key)).toEqual([
      "trust",
      "wiring",
      "approvals",
    ]);
    expect(gapLines(current)[1]).toEqual({
      key: "wiring",
      label: "Wiring",
      text: "1 declared but not wired: legal-reviewer",
      covered: false,
    });
    expect(gapCount(current)).toBe(2);
    expect(gapCount(view())).toBe(0);
  });
});
