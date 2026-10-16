import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vitest";
import {
  readOpeningPolicy,
  retentionRecheckAt,
  retiredAnnotators,
  unservedAnnotator,
  withKeptAnnotators,
} from "./retired-annotators";

describe("which opening policies still need an annotator", () => {
  test("a policy that declares a name without routing to it never needs it, so a carried name ends with the conversations that route to it", () => {
    expect(
      retire({
        openings: [opening("p1", URL_BOUND), opening("e2", CARRIED)],
        composed: JUDGED_BY_B,
      }).kept.map(({ name, openingHashes }) => ({ name, openingHashes })),
    ).toEqual([{ name: "a.tool-call", openingHashes: ["p1"] }]);
    expect(
      retire({ openings: [opening("e2", CARRIED)], composed: JUDGED_BY_B }),
    ).toMatchObject({ kept: [], dropped: [], conflicts: [], inactive: [] });
  });

  test("a policy no conversation was active under lately keeps nothing, and says what it no longer keeps", () => {
    expect(
      retire({
        openings: [opening("p1", URL_BOUND)],
        composed: JUDGED_BY_B,
        live: ["e2"],
      }),
    ).toMatchObject({
      kept: [],
      dropped: [],
      inactive: [
        {
          name: "a.tool-call",
          binding: "http://judge-a.test/annotate",
          openingHashes: ["p1"],
        },
      ],
    });
  });

  test("a name a live policy needs is kept at its binding, whatever an idle policy bound it to", () => {
    const elsewhere = URL_BOUND.replace(
      "http://judge-a.test/annotate",
      "http://judge-c.test/annotate",
    );
    const result = retire({
      openings: [opening("p1", URL_BOUND), opening("p3", elsewhere)],
      composed: JUDGED_BY_B,
      live: ["p3"],
    });
    expect(result.conflicts).toEqual([]);
    expect(result.inactive).toEqual([]);
    expect(
      result.kept.map(({ binding, openingHashes }) => ({
        binding,
        openingHashes,
      })),
    ).toEqual([
      { binding: "http://judge-c.test/annotate", openingHashes: ["p3"] },
    ]);
  });

  test("a policy that is idle still counts when the current policy binds its name differently", () => {
    const rebinding = JUDGED_BY_B.replaceAll("b.tool-call", "a.tool-call");
    expect(
      retire({
        openings: [opening("p1", URL_BOUND)],
        composed: rebinding,
        live: [],
      }).rebound.map(({ name }) => name),
    ).toEqual(["a.tool-call"]);
  });
});

describe("retentionRecheckAt", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  test("checks when the first kept name may lose its last active conversation", () => {
    expect(
      retentionRecheckAt({
        now,
        horizonDays: 30,
        livenessKnown: true,
        kept: [{ lastActivityAt: daysAgo(1) }, { lastActivityAt: daysAgo(5) }],
      }),
    ).toEqual(new Date(daysAgo(5).getTime() + 30 * 24 * 60 * 60 * 1000));
  });

  test("never sooner than an hour, in an hour when activity was not read, and never without a horizon or anything kept", () => {
    const inAnHour = new Date(now.getTime() + 60 * 60 * 1000);
    expect(
      retentionRecheckAt({
        now,
        horizonDays: 30,
        livenessKnown: true,
        kept: [{ lastActivityAt: daysAgo(30) }],
      }),
    ).toEqual(inAnHour);
    expect(
      retentionRecheckAt({
        now,
        horizonDays: 30,
        livenessKnown: false,
        kept: [],
      }),
    ).toEqual(inAnHour);
    expect(
      retentionRecheckAt({
        now,
        horizonDays: 30,
        livenessKnown: true,
        kept: [],
      }),
    ).toBeNull();
    expect(
      retentionRecheckAt({
        now,
        horizonDays: 0,
        livenessKnown: true,
        kept: [{ lastActivityAt: daysAgo(1) }],
      }),
    ).toBeNull();
  });
});

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
        openingHashes: ["a1"],
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

  test("live opening policies that bind a name differently keep the binding a conversation was active under most recently", () => {
    const other = URL_BOUND.replace("judge-a.test", "judge-a2.test");
    const openings = [
      opening("a1", URL_BOUND),
      opening("b2", other),
      opening("c3", URL_BOUND),
    ];
    const newest = retire({
      openings,
      composed: JUDGED_BY_B,
      lastActive: { a1: 100, b2: 300, c3: 200 },
    });
    expect(newest.dropped).toEqual([]);
    expect(
      newest.kept.map(({ binding, openingHashes }) => ({
        binding,
        openingHashes,
      })),
    ).toEqual([
      { binding: "http://judge-a2.test/annotate", openingHashes: ["b2"] },
    ]);
    expect(newest.conflicts).toEqual([
      {
        name: "a.tool-call",
        current: "http://judge-a2.test/annotate",
        earlier: ["http://judge-a.test/annotate"],
      },
    ]);

    // One binding is one candidate, however the ledger interleaves them.
    const older = retire({
      openings,
      composed: JUDGED_BY_B,
      lastActive: { a1: 100, b2: 200, c3: 300 },
    });
    expect(
      older.kept.map(({ binding, openingHashes }) => ({
        binding,
        openingHashes,
      })),
    ).toEqual([
      {
        binding: "http://judge-a.test/annotate",
        openingHashes: ["a1", "c3"],
      },
    ]);
    expect(older.conflicts).toEqual([
      {
        name: "a.tool-call",
        current: "http://judge-a.test/annotate",
        earlier: ["http://judge-a2.test/annotate"],
      },
    ]);
  });

  test("a conversation that opened before a builtin replaced a command annotator keeps being judged once the name is removed", () => {
    const command = JEV_BOUND.replace('builtin = "jev"\n', "").replace(
      '[externals.jev]\napi_key_env = "APPA_PROVIDER_JEV_API_KEY"\n\n[credentials]\nAPPA_PROVIDER_JEV_API_KEY = "jev-key"\n',
      '[externals.annotators."jev.tool-call"]\ncommand = ["python3", "jev-annotator.py"]\n',
    );
    const { kept, dropped, conflicts } = retire({
      // Ledger order alone would keep the command annotator.
      openings: [opening("a1", command), opening("b2", JEV_BOUND)],
      composed: JUDGED_BY_B,
      lastActive: { a1: 100, b2: 200 },
    });
    expect(dropped).toEqual([]);
    expect(conflicts).toEqual([
      {
        name: "jev.tool-call",
        current: 'builtin "jev" with APPA_PROVIDER_JEV_API_KEY = "jev-key"',
        earlier: ["its own table"],
      },
    ]);
    expect(
      unservedAnnotator({
        opening: JEV_BOUND,
        served: withKeptAnnotators(JUDGED_BY_B, kept) ?? "",
        helperBase: HELPER_BASE,
      }),
    ).toBeNull();
  });

  test("when the most recently active binding cannot be kept, the next one is", () => {
    const unreadable = JEV_BOUND.replace('"jev-key"', '"gone-key"');
    const { kept, dropped, conflicts } = retire({
      openings: [opening("a1", JEV_BOUND), opening("b2", unreadable)],
      composed: JUDGED_BY_B,
      lastActive: { a1: 100, b2: 200 },
    });
    expect(dropped).toEqual([]);
    expect(kept.map(({ credentials }) => credentials)).toEqual([
      { APPA_PROVIDER_JEV_API_KEY: "jev-key" },
    ]);
    expect(conflicts).toEqual([
      {
        name: "jev.tool-call",
        current: 'builtin "jev" with APPA_PROVIDER_JEV_API_KEY = "jev-key"',
        earlier: ['builtin "jev" with APPA_PROVIDER_JEV_API_KEY = "gone-key"'],
      },
    ]);
  });

  test("a name no binding of which can be kept is dropped for why the most recently active one cannot be", () => {
    const { kept, dropped, conflicts } = retire({
      openings: [
        opening("a1", JEV_BOUND),
        opening("b2", JEV_BOUND.replace('"jev-key"', '"gone-key"')),
      ],
      composed: JUDGED_BY_B,
      readable: [],
      lastActive: { a1: 100, b2: 200 },
    });
    expect(kept).toEqual([]);
    expect(conflicts).toEqual([]);
    expect(dropped).toEqual([
      {
        name: "jev.tool-call",
        reason:
          'its credential APPA_PROVIDER_JEV_API_KEY is bound to "gone-key", which the organization can no longer read',
      },
    ]);
  });

  test("without activity, conflicting bindings rank in ledger order", () => {
    const { kept, conflicts } = retire({
      openings: [
        opening("ff", URL_BOUND.replace("judge-a.test", "judge-a2.test")),
        opening("0a", URL_BOUND),
      ],
      composed: JUDGED_BY_B,
    });
    expect(kept.map(({ binding }) => binding)).toEqual([
      "http://judge-a.test/annotate",
    ]);
    expect(conflicts.map(({ earlier }) => earlier)).toEqual([
      ["http://judge-a2.test/annotate"],
    ]);
  });

  test("redeclaring a name with a different URL is reported as a rebinding, not kept or refused", () => {
    const { kept, dropped, rebound } = retire({
      openings: [
        opening("a1", URL_BOUND),
        opening("a2", URL_BOUND.replace("judge-a.test", "judge-a0.test")),
      ],
      composed: URL_BOUND.replace("judge-a.test", "judge-a2.test"),
    });
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
    expect(rebound).toEqual([
      {
        name: "a.tool-call",
        current: "http://judge-a2.test/annotate",
        earlier: [
          "http://judge-a.test/annotate",
          "http://judge-a0.test/annotate",
        ],
      },
    ]);
  });

  test("the earlier bindings of a rebound name are listed once each, in hash order", () => {
    const { rebound } = retire({
      openings: [
        opening("c3", URL_BOUND),
        opening("b2", URL_BOUND.replace("judge-a.test", "judge-a0.test")),
        opening("a1", URL_BOUND),
      ],
      composed: URL_BOUND.replace("judge-a.test", "judge-a2.test"),
    });
    expect(rebound).toEqual([
      {
        name: "a.tool-call",
        current: "http://judge-a2.test/annotate",
        earlier: [
          "http://judge-a.test/annotate",
          "http://judge-a0.test/annotate",
        ],
      },
    ]);
  });

  test("a builtin whose credential changed is reported with the credential that differs", () => {
    const { rebound } = retire({
      openings: [opening("a1", JEV_BOUND)],
      composed: JEV_BOUND.replace('"jev-key"', '"other-key"'),
      readable: ["jev-key", "other-key"],
    });
    expect(rebound).toEqual([
      {
        name: "jev.tool-call",
        current: 'builtin "jev" with APPA_PROVIDER_JEV_API_KEY = "other-key"',
        earlier: ['builtin "jev" with APPA_PROVIDER_JEV_API_KEY = "jev-key"'],
      },
    ]);
  });

  test("two retired snapshots of one helper are one binding, kept at the install that answers and at this host", () => {
    const gone = hostHelped({ install: "install-9", port: 9000 });
    const alive = hostHelped({ install: "install-1", port: 3000 }).replace(
      "APPA_ARCHESTRA_BRIDGE_TOKEN",
      "APPA_ARCHESTRA_HELPER_TOKEN",
    );
    const { kept, dropped, conflicts } = retire({
      // Hash order would pick the gone install last; the live one is kept.
      openings: [opening("a1", alive), opening("b2", gone)],
      composed: JUDGED_BY_B,
    });
    expect(conflicts).toEqual([]);
    expect(dropped).toEqual([]);
    expect(
      kept.map(({ name, binding, externals }) => ({
        name,
        binding,
        externals,
      })),
    ).toEqual([
      {
        name: "a.tool-call",
        binding: `${HELPER_BASE}install-1/a.tool-call`,
        externals: [
          {
            path: ["annotators", "a.tool-call"],
            table: {
              url: `${HELPER_BASE}install-1/a.tool-call`,
              token_env: "APPA_ARCHESTRA_BRIDGE_TOKEN",
            },
          },
        ],
      },
    ]);
  });

  test("a table with more than the host writes for its helpers is its own binding", () => {
    const served = hostHelped({ install: "install-2", port: 9000 });
    const authored = `${served}timeout_ms = 1\n`;
    expect(
      retire({ openings: [opening("a1", authored)], composed: served }).rebound,
    ).toHaveLength(1);
    expect(
      retire({ openings: [opening("a1", served)], composed: authored }).rebound,
    ).toHaveLength(1);
  });

  test("a host helper served under another install id, port or token variable is the same binding", () => {
    const served = hostHelped({ install: "install-2", port: 9000 });
    for (const earlier of [
      hostHelped({ install: "install-1", port: 9000 }),
      hostHelped({ install: "install-2", port: 3000 }),
      hostHelped({ install: "install-2", port: 9000 }).replace(
        "APPA_ARCHESTRA_BRIDGE_TOKEN",
        "APPA_ARCHESTRA_HELPER_TOKEN",
      ),
    ]) {
      const { kept, dropped, rebound } = retire({
        openings: [opening("a1", earlier)],
        composed: served,
      });
      expect({ kept, dropped, rebound }).toEqual({
        kept: [],
        dropped: [],
        rebound: [],
      });
      expect(
        unservedAnnotator({
          opening: earlier,
          served,
          helperBase: HELPER_BASE,
        }),
      ).toBeNull();
    }
  });

  test("a host helper that names another external, or a URL elsewhere, is a rebinding", () => {
    const served = hostHelped({ install: "install-2", port: 9000 });
    const otherExternal = hostHelped({
      install: "install-1",
      port: 9000,
    }).replace("install-1/a.tool-call", "install-1/other.tool-call");
    const elsewhere = served.replace("127.0.0.1:9000", "judge-a.test");
    for (const earlier of [otherExternal, elsewhere]) {
      expect(
        retire({ openings: [opening("a1", earlier)], composed: served })
          .rebound,
      ).toEqual([
        {
          name: "a.tool-call",
          current: `${HELPER_BASE}install-2/a.tool-call`,
          earlier: [
            earlier === otherExternal
              ? `${HELPER_BASE}install-1/other.tool-call`
              : "http://judge-a.test/api/openappa/helpers/install-2/a.tool-call",
          ],
        },
      ]);
      expect(
        unservedAnnotator({
          opening: earlier,
          served,
          helperBase: HELPER_BASE,
        }),
      ).toBe("a.tool-call");
    }
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

/** `URL_BOUND` answered by this host's helper of `install` on `port`, as the host composes it. */
function hostHelped(params: { install: string; port: number }): string {
  const base = HELPER_BASE.replace(":9000", `:${params.port}`);
  return URL_BOUND.replace(
    "http://judge-a.test/annotate",
    `${base}${params.install}/a.tool-call`,
  ).concat('token_env = "APPA_ARCHESTRA_BRIDGE_TOKEN"\n');
}

describe("unservedAnnotator", () => {
  test("names an opening annotator the served policy no longer answers", () => {
    expect(
      unservedAnnotator({
        opening: URL_BOUND,
        served: JUDGED_BY_B,
        helperBase: HELPER_BASE,
      }),
    ).toBe("a.tool-call");
  });

  test("does not name an annotator whose binding is unchanged", () => {
    expect(
      unservedAnnotator({
        opening: URL_BOUND,
        served: URL_BOUND,
        helperBase: HELPER_BASE,
      }),
    ).toBe(null);
  });

  test("does not invalidate a new session for an unused retained declaration", () => {
    const { kept } = retire({
      openings: [opening("a1", URL_BOUND)],
      composed: JUDGED_BY_B,
    });
    const openingPolicy = withKeptAnnotators(JUDGED_BY_B, kept);
    expect(openingPolicy).not.toBeNull();
    expect(
      unservedAnnotator({
        opening: openingPolicy ?? "",
        served: JUDGED_BY_B,
        helperBase: HELPER_BASE,
      }),
    ).toBeNull();
  });
});

function retire(params: {
  openings: ReturnType<typeof opening>[];
  composed: string;
  readable?: string[];
  live?: string[];
  /** When a conversation under each opening was last active, by hash. */
  lastActive?: Record<string, number>;
}) {
  return retiredAnnotators({
    openings: params.openings,
    composed: params.composed,
    readable: new Set(params.readable ?? ["jev-key"]),
    helperBase: HELPER_BASE,
    helperTokenEnv: "APPA_ARCHESTRA_BRIDGE_TOKEN",
    installs: new Set(["install-1"]),
    live: params.live ? new Set(params.live) : null,
    lastActive: new Map(Object.entries(params.lastActive ?? {})),
  });
}

/** `URL_BOUND` carried by a later composition that keeps it without routing to it. */
const CARRIED = `${JUDGED_BY_B}
[[policy.annotator]]
name = "a.tool-call"
ranks = ["suspicious", "trusted"]
audiences = ["self", "internal"]
marks = []

[externals.annotators."a.tool-call"]
url = "http://judge-a.test/annotate"
`;
