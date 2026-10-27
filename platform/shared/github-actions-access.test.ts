import { describe, expect, test } from "vitest";
import {
  GitHubActionsAccessSchema,
  gitHubRepositoryMatches,
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
        repositories: ["acme/widgets", "acme/*"],
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
});
