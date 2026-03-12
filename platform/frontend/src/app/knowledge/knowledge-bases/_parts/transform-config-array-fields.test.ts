import { describe, expect, it } from "vitest";
import { transformConfigArrayFields } from "./transform-config-array-fields";

describe("transformConfigArrayFields", () => {
  it("converts comma-separated string fields to arrays", () => {
    const config = {
      type: "github",
      githubUrl: "https://api.github.com",
      repos: "repo1, repo2, repo3",
    };

    const result = transformConfigArrayFields(config);

    expect(result.repos).toEqual(["repo1", "repo2", "repo3"]);
  });

  it("converts all known string array fields", () => {
    const config = {
      repos: "a, b",
      spaceKeys: "TEAM, DEV",
      pageIds: "page-1, page-2",
      labelsToSkip: "internal, draft",
      commentEmailBlacklist: "bot@test.com, noreply@test.com",
      states: "open, closed",
      assignmentGroups: "group1, group2",
    };

    const result = transformConfigArrayFields(config);

    expect(result.repos).toEqual(["a", "b"]);
    expect(result.spaceKeys).toEqual(["TEAM", "DEV"]);
    expect(result.pageIds).toEqual(["page-1", "page-2"]);
    expect(result.labelsToSkip).toEqual(["internal", "draft"]);
    expect(result.commentEmailBlacklist).toEqual([
      "bot@test.com",
      "noreply@test.com",
    ]);
    expect(result.states).toEqual(["open", "closed"]);
    expect(result.assignmentGroups).toEqual(["group1", "group2"]);
  });

  it("converts projectIds to number array", () => {
    const config = {
      projectIds: "1, 2, 3",
    };

    const result = transformConfigArrayFields(config);

    expect(result.projectIds).toEqual([1, 2, 3]);
  });

  it("filters out NaN values from projectIds", () => {
    const config = {
      projectIds: "1, abc, 3",
    };

    const result = transformConfigArrayFields(config);

    expect(result.projectIds).toEqual([1, 3]);
  });

  it("trims whitespace and filters empty entries", () => {
    const config = {
      repos: " repo1 ,, repo2 , , repo3 ",
    };

    const result = transformConfigArrayFields(config);

    expect(result.repos).toEqual(["repo1", "repo2", "repo3"]);
  });

  it("does not mutate the original config object", () => {
    const config = {
      repos: "repo1, repo2",
      githubUrl: "https://api.github.com",
    };

    transformConfigArrayFields(config);

    expect(config.repos).toBe("repo1, repo2");
  });

  it("passes through fields that are not in the known list", () => {
    const config = {
      type: "jira",
      jiraBaseUrl: "https://example.atlassian.net",
      isCloud: true,
      repos: "repo1, repo2",
    };

    const result = transformConfigArrayFields(config);

    expect(result.type).toBe("jira");
    expect(result.jiraBaseUrl).toBe("https://example.atlassian.net");
    expect(result.isCloud).toBe(true);
    expect(result.repos).toEqual(["repo1", "repo2"]);
  });
});
