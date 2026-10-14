import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vitest";
import {
  readOpeningPolicy,
  retiredAnnotators,
  unservedAnnotator,
  withKeptAnnotators,
} from "./retired-annotators";

describe("retiredAnnotators", () => {
  test("a URL-bound annotator is kept with its externals table", () => {
    const { kept, dropped } = retire({
      openings: [opening("a1", URL_BOUND)],
      composed: JUDGED_BY_B,
    });

    expect(dropped).toEqual([]);
    expect(kept).toEqual([
      {
        name: "a.tool-call",
        declaration: {
          name: "a.tool-call",
          ranks: ["suspicious", "trusted"],
          audiences: ["self", "internal"],
          marks: [],
        },
        externals: [
          {
            path: ["annotators", "a.tool-call"],
            table: { url: "http://judge-a.test/annotate" },
          },
        ],
        credentials: {},
        binding: "http://judge-a.test/annotate",
      },
    ]);
  });

  test("a builtin with settings is kept with its externals table and credential", () => {
    const { kept, dropped } = retire({
      openings: [opening("a1", JEV_BOUND)],
      composed: JUDGED_BY_B,
    });

    expect(dropped).toEqual([]);
    expect(kept).toEqual([
      expect.objectContaining({
        name: "jev.tool-call",
        declaration: expect.objectContaining({ builtin: "jev" }),
        externals: [
          {
            path: ["jev"],
            table: { api_key_env: "APPA_PROVIDER_JEV_API_KEY" },
          },
        ],
        credentials: { APPA_PROVIDER_JEV_API_KEY: "jev-key" },
        binding: 'builtin "jev"',
      }),
    ]);
  });

  test("a name with the same current binding needs no retained declaration", () => {
    expect(
      retire({ openings: [opening("a1", URL_BOUND)], composed: URL_BOUND })
        .kept,
    ).toEqual([]);
  });

  test("a new shared profile credential cannot replace an old binding", () => {
    const { kept, dropped } = retire({
      openings: [opening("a1", JEV_BOUND)],
      composed: `${JUDGED_BY_B}
[externals.jev]
api_key_env = "APPA_PROVIDER_JEV_API_KEY"

[credentials]
APPA_PROVIDER_JEV_API_KEY = "other-key"
`,
    });
    expect(kept).toEqual([]);
    expect(dropped).toEqual([
      {
        name: "jev.tool-call",
        reason:
          "the current policy binds APPA_PROVIDER_JEV_API_KEY to a different credential",
      },
    ]);
  });

  test("an annotator whose credential the organization can no longer read is dropped", () => {
    const { kept, dropped } = retire({
      openings: [opening("a1", JEV_BOUND)],
      composed: JUDGED_BY_B,
      readable: [],
    });

    expect(kept).toEqual([]);
    expect(dropped).toEqual([
      {
        name: "jev.tool-call",
        reason:
          'its credential APPA_PROVIDER_JEV_API_KEY is bound to "jev-key", which the organization can no longer read',
      },
    ]);
  });

  test("an annotator whose battery helper's install is gone is dropped", () => {
    const helped = (install: string) =>
      opening(
        "a1",
        URL_BOUND.replace(
          "http://judge-a.test/annotate",
          `${HELPER_BASE}${install}/annotators/a.tool-call`,
        ),
      );

    expect(
      retire({ openings: [helped("gone")], composed: JUDGED_BY_B }).dropped,
    ).toEqual([
      {
        name: "a.tool-call",
        reason: "the battery install whose helper answered it no longer exists",
      },
    ]);
    expect(
      retire({ openings: [helped("install-1")], composed: JUDGED_BY_B }).kept,
    ).toHaveLength(1);
  });

  test("a live helper retains its original host-bound credential and no old rules", () => {
    const url = `${HELPER_BASE}install-1/annotators/a.tool-call`;
    const helped = URL_BOUND.replace(
      "http://judge-a.test/annotate",
      url,
    ).concat('token_env = "APPA_ARCHESTRA_BRIDGE_TOKEN"\n');
    const { kept, dropped } = retire({
      openings: [opening("a1", helped)],
      composed: JUDGED_BY_B,
    });
    expect(dropped).toEqual([]);
    const document = parseToml(withKeptAnnotators(JUDGED_BY_B, kept) ?? "");
    expect(document).toMatchObject({
      externals: {
        annotators: {
          "a.tool-call": { url, token_env: "APPA_ARCHESTRA_BRIDGE_TOKEN" },
        },
      },
      policy: { tool: [{ name: "*", annotator: "b.tool-call" }] },
    });
  });

  test("two opening policies with different bindings fail closed instead of choosing one", () => {
    const other = URL_BOUND.replace("judge-a.test", "judge-a2.test");
    const { kept, dropped, conflicts } = retire({
      openings: [opening("ff", other), opening("0a", URL_BOUND)],
      composed: JUDGED_BY_B,
    });

    expect(kept).toEqual([]);
    expect(dropped).toEqual([
      {
        name: "a.tool-call",
        reason: "earlier sessions require different bindings for this name",
      },
    ]);
    expect(conflicts).toEqual(["a.tool-call"]);
  });

  test("redeclaring a name with a different URL is refused before redirecting old sessions", () => {
    const { refusal } = retire({
      openings: [opening("a1", URL_BOUND)],
      composed: URL_BOUND.replace("judge-a.test", "judge-a2.test"),
    });
    expect(refusal).toEqual([
      'annotator "a.tool-call" is used by earlier sessions with a different binding. Use a new annotator name to keep their original binding.',
    ]);
  });

  test("changing a shared profile cannot silently redirect a renamed old annotator", () => {
    const { kept, dropped } = retire({
      openings: [opening("a1", JEV_BOUND)],
      composed: `${JUDGED_BY_B}
[externals.jev]
api_key_env = "APPA_PROVIDER_OTHER_API_KEY"
`,
    });
    expect(kept).toEqual([]);
    expect(dropped).toEqual([
      {
        name: "jev.tool-call",
        reason: "the current policy uses a different externals.jev binding",
      },
    ]);
  });

  test("retained names cannot overwrite each other's shared credential", () => {
    const other = JEV_BOUND.replaceAll(
      "jev.tool-call",
      "older.tool-call",
    ).replace('"jev-key"', '"other-key"');
    const { kept, dropped } = retire({
      openings: [opening("a1", JEV_BOUND), opening("b1", other)],
      composed: JUDGED_BY_B,
      readable: ["jev-key", "other-key"],
    });
    expect(kept.map(({ name }) => name)).toEqual(["jev.tool-call"]);
    expect(dropped).toEqual([
      {
        name: "older.tool-call",
        reason:
          "the current policy binds APPA_PROVIDER_JEV_API_KEY to a different credential",
      },
    ]);
  });
});

describe("withKeptAnnotators", () => {
  test("declares the kept annotators without replacing the root's own tables", () => {
    const { kept } = retire({
      openings: [opening("a1", JEV_BOUND)],
      composed: JUDGED_BY_B,
    });
    const root = `${JUDGED_BY_B}
[credentials]
OTHER = "other-key"
`;

    const merged = parseToml(withKeptAnnotators(root, kept) ?? "");

    expect(merged).toMatchObject({
      policy: {
        annotator: [
          { name: "b.tool-call" },
          { name: "jev.tool-call", builtin: "jev" },
        ],
        tool: [{ name: "*", annotator: "b.tool-call" }],
      },
      externals: {
        annotators: { "b.tool-call": { url: "http://judge-b.test/annotate" } },
        jev: { api_key_env: "APPA_PROVIDER_JEV_API_KEY" },
      },
      credentials: {
        OTHER: "other-key",
        APPA_PROVIDER_JEV_API_KEY: "jev-key",
      },
    });
  });
});

// =============================================================================
// Helpers
// =============================================================================

const HELPER_BASE = "http://127.0.0.1:9000/api/openappa/helpers/";

const URL_BOUND = `[policy]
version = 2

[[policy.annotator]]
name = "a.tool-call"
ranks = ["suspicious", "trusted"]
audiences = ["self", "internal"]
marks = []

[[policy.tool]]
name = "*"
annotator = "a.tool-call"

[externals.annotators."a.tool-call"]
url = "http://judge-a.test/annotate"
`;

const JEV_BOUND = `[policy]
version = 2

[[policy.annotator]]
name = "jev.tool-call"
builtin = "jev"
ranks = ["suspicious", "trusted"]

[[policy.tool]]
name = "*"
annotator = "jev.tool-call"

[externals.jev]
api_key_env = "APPA_PROVIDER_JEV_API_KEY"

[credentials]
APPA_PROVIDER_JEV_API_KEY = "jev-key"
`;

const JUDGED_BY_B = `[policy]
version = 2

[[policy.annotator]]
name = "b.tool-call"

[[policy.tool]]
name = "*"
annotator = "b.tool-call"

[externals.annotators."b.tool-call"]
url = "http://judge-b.test/annotate"
`;

function opening(hash: string, content: string) {
  const parsed = readOpeningPolicy(hash, content);
  if (!parsed) throw new Error("not TOML");
  return parsed;
}

describe("unservedAnnotator", () => {
  test("names an opening annotator the served policy no longer answers", () => {
    expect(unservedAnnotator({ opening: URL_BOUND, served: JUDGED_BY_B })).toBe(
      "a.tool-call",
    );
  });

  test("does not name an annotator whose binding is unchanged", () => {
    expect(unservedAnnotator({ opening: URL_BOUND, served: URL_BOUND })).toBe(
      null,
    );
  });
});

function retire(params: {
  openings: ReturnType<typeof opening>[];
  composed: string;
  readable?: string[];
}) {
  return retiredAnnotators({
    openings: params.openings,
    composed: params.composed,
    readable: new Set(params.readable ?? ["jev-key"]),
    helperBase: HELPER_BASE,
    installs: new Set(["install-1"]),
  });
}
