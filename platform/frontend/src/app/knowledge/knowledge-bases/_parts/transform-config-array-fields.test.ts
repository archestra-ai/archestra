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
      includePaths: "docs, packages/api/src",
    };

    const result = transformConfigArrayFields(config);

    expect(result.repos).toEqual(["a", "b"]);
    expect(result.includePaths).toEqual(["docs", "packages/api/src"]);
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

  it("converts M-Files objectTypeIds to non-negative integers", () => {
    const config = {
      type: "mfiles",
      objectTypeIds: "0, 2, invalid, -1, 7",
    };

    const result = transformConfigArrayFields(config);

    expect(result.objectTypeIds).toEqual([0, 2, 7]);
  });

  it("treats an absent M-Files authMethod as password mode and strips the seeded OAuth presets", () => {
    expect(
      transformConfigArrayFields({
        type: "mfiles",
        domain: "CONTOSO",
        oauthAuthConfig: "Technical Credentials",
        oauthAuthConfigScope: "technical",
      }),
    ).toEqual({
      type: "mfiles",
      domain: "CONTOSO",
    });
  });

  it("removes credentials-mode fields that do not apply to M-Files", () => {
    expect(
      transformConfigArrayFields({
        type: "mfiles",
        authMethod: "mfiles_password_token",
        domain: "CONTOSO",
        oauthTokenEndpoint: "https://login.example.com/token",
        oauthAuthConfig: "Entra ID",
        oauthAuthConfigScope: "technical",
        oauthAccountName: String.raw`integration\archestra`,
        oauthUseIdToken: true,
      }),
    ).toEqual({
      type: "mfiles",
      authMethod: "mfiles_password_token",
      domain: "CONTOSO",
    });

    expect(
      transformConfigArrayFields({
        type: "mfiles",
        authMethod: "oauth_client_credentials",
        domain: "CONTOSO",
        oauthTokenEndpoint: "https://login.example.com/token",
        oauthAuthConfig: "Entra ID",
        oauthAuthConfigScope: "technical",
        oauthAccountName: String.raw`integration\archestra`,
        oauthScope: "",
        oauthResource: "",
      }),
    ).toEqual({
      type: "mfiles",
      authMethod: "oauth_client_credentials",
      oauthTokenEndpoint: "https://login.example.com/token",
      oauthAuthConfig: "Entra ID",
      oauthAuthConfigScope: "technical",
      oauthAccountName: String.raw`integration\archestra`,
    });
  });

  it("drops empty Perforce permission-sync fields and keeps filled ones", () => {
    expect(
      transformConfigArrayFields({
        type: "perforce",
        serverUrl: "https://perforce.example.com:8080",
        depotPaths: "//depot/docs",
        p4Port: "",
        adminUsername: "",
      }),
    ).toEqual({
      type: "perforce",
      serverUrl: "https://perforce.example.com:8080",
      depotPaths: ["//depot/docs"],
    });

    expect(
      transformConfigArrayFields({
        type: "perforce",
        p4Port: "ssl:perforce.example.com:1666",
        adminUsername: "p4admin",
      }),
    ).toEqual({
      type: "perforce",
      p4Port: "ssl:perforce.example.com:1666",
      adminUsername: "p4admin",
    });
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

  it("converts ServiceNow role audiences and drops empty entries", () => {
    const config = {
      type: "servicenow",
      instanceUrl: "https://example.service-now.com",
      roleAudiences: {
        incident: "itil, sn_incident_read",
        problem: "",
        change_request: ["itil"],
      },
    };

    const result = transformConfigArrayFields(config);

    expect(result.roleAudiences).toEqual({
      incident: ["itil", "sn_incident_read"],
      change_request: ["itil"],
    });
  });

  it("drops an all-empty ServiceNow role audience map", () => {
    const config = {
      type: "servicenow",
      instanceUrl: "https://example.service-now.com",
      roleAudiences: { incident: "", problem: " " },
    };

    const result = transformConfigArrayFields(config);

    expect(result.roleAudiences).toBeUndefined();
  });
});
