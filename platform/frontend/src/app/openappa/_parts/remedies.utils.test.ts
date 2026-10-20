// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  Authority,
  RemediesView,
  Sanitizer,
} from "@/lib/openappa-remedies.query";
import { coverChips, groupBySource } from "./remedies.utils";

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
      { lock: "attention", value: "any", code: false },
      { lock: "audience", value: "up to public", code: false },
      { lock: "trust", value: "up to trusted", code: false },
      { lock: "effects", value: "email.sent", code: true },
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
    ).toEqual([{ lock: "attention", value: "finance-signoff", code: true }]);
  });

  test("a sanitizer gets its one transition", () => {
    expect(coverChips(sanitizer())).toEqual([
      { lock: "audience", value: "self → public", code: false },
    ]);
    expect(
      coverChips(
        sanitizer({
          permits: { kind: "trust", from: "suspicious", to: "trusted" },
        }),
      ),
    ).toEqual([{ lock: "trust", value: "suspicious → trusted", code: false }]);
    expect(coverChips(sanitizer({ permits: null }))).toEqual([]);
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
