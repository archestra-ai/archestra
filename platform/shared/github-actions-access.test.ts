import { describe, expect, test } from "vitest";
import {
  GitHubActionsAccessSchema,
  gitHubRepositoryMatches,
  StoredGitHubActionsAccessSchema,
} from "./github-actions-access";

describe("gitHubRepositoryMatches", () => {
  test("matches a listed repository case-insensitively", () => {
    expect(gitHubRepositoryMatches("Acme/Widgets", "acme/widgets")).toBe(true);
    expect(gitHubRepositoryMatches("acme/widgets", "acme/gadgets")).toBe(false);
  });

  test("matches every repository of an owner listed as owner/*", () => {
    expect(gitHubRepositoryMatches("Acme/*", "acme/new-repo")).toBe(true);
    expect(gitHubRepositoryMatches("acme/*", "acme-labs/widgets")).toBe(false);
    expect(gitHubRepositoryMatches("acme/*", "other/widgets")).toBe(false);
    expect(gitHubRepositoryMatches("acme/*", "acme/")).toBe(false);
    expect(gitHubRepositoryMatches("acme/*", "acme/widgets/extra")).toBe(false);
  });

  test("never matches a malformed listed entry, which a lenient read can return", () => {
    for (const allowed of [
      "",
      "acme",
      "acme/",
      "/*",
      "*",
      "acme/*/extra",
      "acme/widgets/extra",
    ]) {
      expect(gitHubRepositoryMatches(allowed, "acme/widgets")).toBe(false);
    }
  });
});

describe("GitHubActionsAccessSchema", () => {
  const access = {
    githubAppCredentialKey: "review-app",
    workflows: [
      "acme/.github/.github/workflows/review.yml@0123456789abcdef0123456789abcdef01234567",
    ],
  };

  test("accepts owner/name and owner/*, and refuses other wildcards", () => {
    expect(
      GitHubActionsAccessSchema.safeParse({
        ...access,
        repositories: ["acme/*", "other/widgets"],
      }).success,
    ).toBe(true);
    for (const repository of ["*/*", "acme/wid*", "*"]) {
      expect(
        GitHubActionsAccessSchema.safeParse({
          ...access,
          repositories: [repository],
        }).success,
      ).toBe(false);
    }
  });

  test("refuses an owner/name entry that an owner/* entry covers", () => {
    const result = GitHubActionsAccessSchema.safeParse({
      ...access,
      repositories: ["Acme/widgets", "acme/*"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "An owner/* entry already covers that owner's repositories",
    );
  });
});

describe("actAs", () => {
  const access = {
    githubAppCredentialKey: "review-app",
    repositories: ["acme/*"],
    workflows: [
      "acme/.github/.github/workflows/review.yml@0123456789abcdef0123456789abcdef01234567",
    ],
  };

  test("saves author, actor or nothing, and nothing else", () => {
    for (const actAs of [undefined, "author", "actor"]) {
      expect(
        GitHubActionsAccessSchema.safeParse({ ...access, actAs }).success,
      ).toBe(true);
    }
    expect(
      GitHubActionsAccessSchema.safeParse({ ...access, actAs: "anyone" })
        .success,
    ).toBe(false);
  });

  test("saves resolveReviewThreads as a boolean, and reads anything else as off", () => {
    expect(
      GitHubActionsAccessSchema.safeParse({
        ...access,
        resolveReviewThreads: true,
      }).success,
    ).toBe(true);
    expect(
      GitHubActionsAccessSchema.safeParse({
        ...access,
        resolveReviewThreads: "yes",
      }).success,
    ).toBe(false);
    expect(
      StoredGitHubActionsAccessSchema.parse({
        ...access,
        resolveReviewThreads: "yes",
      }).resolveReviewThreads,
    ).toBeUndefined();
  });

  test("reads a stored value it does not know as the default, the author", () => {
    expect(
      StoredGitHubActionsAccessSchema.parse({ ...access, actAs: "anyone" })
        .actAs,
    ).toBeUndefined();
    expect(
      StoredGitHubActionsAccessSchema.parse({ ...access, actAs: "actor" })
        .actAs,
    ).toBe("actor");
  });
});

describe("StoredGitHubActionsAccessSchema", () => {
  test("reads a stored entry that the entry rules refuse", () => {
    const stored = {
      githubAppCredentialKey: "review-app",
      repositories: ["acme/*", "acme/widgets", "acme/wid*"],
      workflows: [
        "acme/.github/.github/workflows/review.yml@refs/pull/1/merge",
      ],
    };
    expect(StoredGitHubActionsAccessSchema.parse(stored)).toEqual(stored);
  });
});
