import { describe, expect, test } from "vitest";
import { setupPullRequestOutcome } from "./setup-pull-request";

const source = {
  organizationId: "org",
  repo: "example/policies",
  ref: null,
  path: "appa.toml",
  interval: "1h" as const,
  githubPatId: null,
  githubAppConfigId: null,
  revision: "revision",
  sourceCommit: null,
  setupPullRequestNumber: 7,
  lastSyncedAt: null,
  lastSyncError: null,
  declarationsPendingPublish: false,
  heldContentHash: null,
  heldSourceCommit: null,
  heldReasons: [],
};

describe("setupPullRequestOutcome", () => {
  test("the pull request is pending while the row still carries its number", () => {
    expect(setupPullRequestOutcome(source, 7)).toBe("pending");
    // Closed without merging keeps the number and reports through lastSyncError.
    expect(
      setupPullRequestOutcome(
        { ...source, lastSyncError: "closed without merging" },
        7,
      ),
    ).toBe("pending");
  });

  test("a cleared number on the same source means the merge was imported", () => {
    expect(
      setupPullRequestOutcome(
        {
          ...source,
          setupPullRequestNumber: null,
          sourceCommit: "a".repeat(40),
        },
        7,
      ),
    ).toBe("merged");
  });

  test("a stopped sync or another setup pull request is no longer this one", () => {
    expect(setupPullRequestOutcome(null, 7)).toBe("gone");
    expect(setupPullRequestOutcome({ ...source, interval: null }, 7)).toBe(
      "gone",
    );
    expect(
      setupPullRequestOutcome({ ...source, setupPullRequestNumber: 8 }, 7),
    ).toBe("gone");
  });
});
