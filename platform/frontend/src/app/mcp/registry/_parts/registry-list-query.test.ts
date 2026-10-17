import { describe, expect, it } from "vitest";
import {
  attentionRankTiers,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import {
  buildRegistryListQuery,
  registryPageRequestFromUrl,
  registryQueryInputs,
  sameRankTiers,
  sortKeyFromParams,
  sortParamsForKey,
} from "./registry-list-query";

const environments = [
  { id: "env-prod-eu", name: "Production" },
  { id: "env-prod-us", name: "Production" },
  { id: "env-staging", name: "Staging" },
];

const authors = [
  // Two people share a display name; both still match it.
  {
    authorId: "user-alex-1",
    createdByServiceAccountId: null,
    authorName: "Alex",
  },
  {
    authorId: "user-alex-2",
    createdByServiceAccountId: null,
    authorName: "Alex",
  },
  // Made through a service account on Alex's behalf: it shows, and so
  // filters, as the service account.
  {
    authorId: "user-alex-1",
    createdByServiceAccountId: "sa-ci",
    authorName: "CI bot",
  },
  { authorId: null, createdByServiceAccountId: "sa-ci", authorName: "CI bot" },
  { authorId: "user-sam", createdByServiceAccountId: null, authorName: "Sam" },
];

const build = (
  url: string,
  issuesByCatalog = new Map<string, McpServerIssue[]>(),
  attentionTiers?: string[][],
) =>
  buildRegistryListQuery({
    searchParams: new URLSearchParams(url),
    access: {},
    environments,
    authors,
    issuesByCatalog,
    attentionTiers,
  });

const issue = (
  catalogId: string,
  overrides: Partial<McpServerIssue> = {},
): McpServerIssue => ({
  kind: "needs-reauth",
  audience: "you",
  catalogId,
  detail: null,
  since: null,
  fingerprint: `fp-${catalogId}`,
  muted: false,
  mutedReason: null,
  ...overrides,
});

describe("buildRegistryListQuery", () => {
  it("reads an old-style link with names and the Status value", () => {
    expect(
      build("environment=Production&author=Alex&status=installed"),
    ).toEqual({
      sortBy: "attention",
      sortDirection: "asc",
      environmentIds: ["env-prod-eu", "env-prod-us"],
      authorIds: ["user-alex-1", "user-alex-2"],
      authorServiceAccountIds: [],
      installState: "installed",
    });
  });

  it("maps a service account's name to the service account", () => {
    expect(build("author=CI%20bot")).toMatchObject({
      authorIds: [],
      authorServiceAccountIds: ["sa-ci"],
    });
  });

  it("asks for nothing when a named environment or author no longer exists", () => {
    expect(build("environment=Gone&author=Nobody")).toMatchObject({
      environmentIds: [],
      authorIds: [],
      authorServiceAccountIds: [],
    });
  });

  it("drops the install filter when both Installed and Not installed are on", () => {
    expect(build("status=installed&status=not-installed")).not.toHaveProperty(
      "installState",
    );
  });

  it("narrows a facet to its catalog ids and the Issue filter's kinds", () => {
    const issues = new Map([
      ["cat-reauth", [issue("cat-reauth")]],
      ["cat-failed", [issue("cat-failed", { kind: "failed-to-start" })]],
      ["cat-others", [issue("cat-others", { audience: "others" })]],
    ]);

    expect(build("status=needs-my-action", issues).catalogIds).toEqual([
      "cat-failed",
      "cat-reauth",
    ]);
    expect(
      build("status=needs-my-action&issue=failed-to-start", issues).catalogIds,
    ).toEqual(["cat-failed"]);
  });

  it("applies the Issue filter without a facet, over every issue", () => {
    const issues = new Map([
      ["cat-failed", [issue("cat-failed", { kind: "failed-to-start" })]],
      [
        "cat-others-failed",
        [
          issue("cat-others-failed", {
            kind: "failed-to-start",
            audience: "others",
          }),
        ],
      ],
      ["cat-reauth", [issue("cat-reauth")]],
    ]);

    expect(build("issue=failed-to-start", issues).catalogIds).toEqual([
      "cat-failed",
      "cat-others-failed",
    ]);
  });

  it("leaves the attention order to the server unless live tiers override it", () => {
    const issues = new Map([
      ["cat-others", [issue("cat-others", { audience: "others" })]],
      ["cat-yours", [issue("cat-yours")]],
      ["cat-muted", [issue("cat-muted", { muted: true })]],
    ]);
    const live = attentionRankTiers(issues);

    expect(live).toEqual([["cat-yours"], ["cat-others"]]);
    expect(build("", issues)).not.toHaveProperty("rankTiers");
    expect(build("", issues, live).rankTiers).toEqual(live);
    // Only the attention order takes them.
    expect(
      build("sortBy=name&sortDirection=asc", issues, live),
    ).not.toHaveProperty("rankTiers");
  });

  it("compares rank tiers by membership, ignoring order within a tier and empty tiers", () => {
    expect(sameRankTiers([["b", "a"], []], [["a", "b"]])).toBe(true);
    expect(sameRankTiers([["a"], ["b"]], [["b"], ["a"]])).toBe(false);
    expect(sameRankTiers([["a"]], [["a"], ["b"]])).toBe(false);
  });

  it("waits for the issue index only for what the index maps", () => {
    const inputs = (url: string) =>
      registryQueryInputs(new URLSearchParams(url));

    expect(inputs("")).toEqual({
      needsEnvironments: false,
      needsIssueIndex: false,
      needsIssues: false,
    });
    expect(inputs("author=Alex").needsIssueIndex).toBe(true);
    expect(inputs("sortBy=issueAge&sortDirection=asc").needsIssueIndex).toBe(
      true,
    );
    expect(inputs("status=needs-my-action")).toMatchObject({
      needsIssueIndex: true,
      needsIssues: true,
    });
  });

  it("ranks the oldest outstanding issue first for issue age", () => {
    const issues = new Map([
      ["cat-new", [issue("cat-new", { since: "2026-10-02T00:00:00Z" })]],
      ["cat-old", [issue("cat-old", { since: "2026-09-01T00:00:00Z" })]],
      ["cat-undated", [issue("cat-undated")]],
    ]);

    expect(
      build("sortBy=issueAge&sortDirection=asc", issues).rankTiers,
    ).toEqual([["cat-old"], ["cat-new"]]);
  });

  it("round-trips every sort menu entry through the URL", () => {
    for (const key of [
      "attention",
      "name-asc",
      "name-desc",
      "newest",
      "oldest",
      "most-tools",
      "issue-age",
    ] as const) {
      const params = new URLSearchParams(sortParamsForKey(key));
      expect(sortKeyFromParams(params)).toBe(key);
    }
    expect(sortKeyFromParams(new URLSearchParams("sortBy=bogus"))).toBe(
      "attention",
    );
  });

  it("builds the page request from the URL alone when nothing maps through loaded data", () => {
    const url =
      "search=git&labels=team%3Dplatform&status=installed&sortBy=name&sortDirection=desc&page=3&pageSize=50&access=mine";
    const params = new URLSearchParams(url);

    expect(registryPageRequestFromUrl(params)).toEqual({
      ...buildRegistryListQuery({
        searchParams: params,
        access: { access: ["mine"] },
        environments: [],
        authors: [],
        issuesByCatalog: new Map(),
      }),
      limit: 50,
      offset: 100,
    });
    expect(registryPageRequestFromUrl(new URLSearchParams(""))).toMatchObject({
      sortBy: "attention",
      sortDirection: "asc",
      limit: 10,
      offset: 0,
    });
    for (const needsData of [
      "environment=Production",
      "author=Alex",
      "status=needs-my-action",
      "issue=failed-to-start",
      "sortBy=issueAge&sortDirection=asc",
    ]) {
      expect(registryPageRequestFromUrl(new URLSearchParams(needsData))).toBe(
        null,
      );
    }
  });
});
