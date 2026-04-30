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
      teamIds: "team-1, team-2",
      spaceKeys: "TEAM, DEV",
      pageIds: "page-1, page-2",
      projectIds: "project-1, project-2",
      labelsToSkip: "internal, draft",
      commentEmailBlacklist: "bot@test.com, noreply@test.com",
      states: "open, closed",
      assignmentGroups: "group1, group2",
      projectGids: "111, 222",
      tagsToSkip: "wip, archived",
      objects: "Account, Contact",
    };

    const result = transformConfigArrayFields(config);

    expect(result.repos).toEqual(["a", "b"]);
    expect(result.teamIds).toEqual(["team-1", "team-2"]);
    expect(result.spaceKeys).toEqual(["TEAM", "DEV"]);
    expect(result.pageIds).toEqual(["page-1", "page-2"]);
    expect(result.projectIds).toEqual(["project-1", "project-2"]);
    expect(result.labelsToSkip).toEqual(["internal", "draft"]);
    expect(result.commentEmailBlacklist).toEqual([
      "bot@test.com",
      "noreply@test.com",
    ]);
    expect(result.states).toEqual(["open", "closed"]);
    expect(result.assignmentGroups).toEqual(["group1", "group2"]);
    expect(result.projectGids).toEqual(["111", "222"]);
    expect(result.tagsToSkip).toEqual(["wip", "archived"]);
    expect(result.objects).toEqual(["Account", "Contact"]);
  });

  it("converts GitLab projectIds to number array", () => {
    const config = {
      type: "gitlab",
      projectIds: "1, 2, 3",
    };

    const result = transformConfigArrayFields(config);

    expect(result.projectIds).toEqual([1, 2, 3]);
  });

  it("filters out NaN values from GitLab projectIds", () => {
    const config = {
      type: "gitlab",
      projectIds: "1, abc, 3",
    };

    const result = transformConfigArrayFields(config);

    expect(result.projectIds).toEqual([1, 3]);
  });

  it("keeps linear projectIds as string array", () => {
    const config = {
      type: "linear",
      projectIds: "proj-a, proj-b",
    };

    const result = transformConfigArrayFields(config);

    expect(result.projectIds).toEqual(["proj-a", "proj-b"]);
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
