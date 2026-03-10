import { describe, expect, test } from "@/test";
import {
  ConfluenceConfigSchema,
  ConnectorConfigSchema,
  GithubConfigSchema,
  GitlabConfigSchema,
  JiraConfigSchema,
} from "./knowledge-connector";

describe("knowledge-connector schemas", () => {
  describe("JiraConfigSchema trailing slash normalization", () => {
    test("strips trailing slash from jiraBaseUrl", () => {
      const result = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "https://mycompany.atlassian.net/",
        isCloud: true,
      });
      expect(result.jiraBaseUrl).toBe("https://mycompany.atlassian.net");
    });

    test("strips multiple trailing slashes from jiraBaseUrl", () => {
      const result = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "https://mycompany.atlassian.net///",
        isCloud: true,
      });
      expect(result.jiraBaseUrl).toBe("https://mycompany.atlassian.net");
    });

    test("leaves jiraBaseUrl unchanged when no trailing slash", () => {
      const result = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "https://mycompany.atlassian.net",
        isCloud: true,
      });
      expect(result.jiraBaseUrl).toBe("https://mycompany.atlassian.net");
    });

    test("produces identical output for URLs with and without trailing slash", () => {
      const withSlash = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "https://mycompany.atlassian.net/",
        isCloud: true,
      });
      const withoutSlash = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "https://mycompany.atlassian.net",
        isCloud: true,
      });
      expect(withSlash.jiraBaseUrl).toBe(withoutSlash.jiraBaseUrl);
    });
  });

  describe("ConfluenceConfigSchema trailing slash normalization", () => {
    test("strips trailing slash from confluenceUrl", () => {
      const result = ConfluenceConfigSchema.parse({
        type: "confluence",
        confluenceUrl: "https://mycompany.atlassian.net/",
        isCloud: true,
      });
      expect(result.confluenceUrl).toBe("https://mycompany.atlassian.net");
    });

    test("strips multiple trailing slashes from confluenceUrl", () => {
      const result = ConfluenceConfigSchema.parse({
        type: "confluence",
        confluenceUrl: "https://mycompany.atlassian.net///",
        isCloud: true,
      });
      expect(result.confluenceUrl).toBe("https://mycompany.atlassian.net");
    });

    test("leaves confluenceUrl unchanged when no trailing slash", () => {
      const result = ConfluenceConfigSchema.parse({
        type: "confluence",
        confluenceUrl: "https://mycompany.atlassian.net",
        isCloud: true,
      });
      expect(result.confluenceUrl).toBe("https://mycompany.atlassian.net");
    });

    test("produces identical output for URLs with and without trailing slash", () => {
      const withSlash = ConfluenceConfigSchema.parse({
        type: "confluence",
        confluenceUrl: "https://mycompany.atlassian.net/",
        isCloud: true,
      });
      const withoutSlash = ConfluenceConfigSchema.parse({
        type: "confluence",
        confluenceUrl: "https://mycompany.atlassian.net",
        isCloud: true,
      });
      expect(withSlash.confluenceUrl).toBe(withoutSlash.confluenceUrl);
    });
  });

  describe("connectorUrlSchema protocol prepending", () => {
    test("prepends https:// when no protocol is provided (Jira)", () => {
      const result = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "mycompany.atlassian.net",
        isCloud: true,
      });
      expect(result.jiraBaseUrl).toBe("https://mycompany.atlassian.net");
    });

    test("prepends https:// when no protocol is provided (Confluence)", () => {
      const result = ConfluenceConfigSchema.parse({
        type: "confluence",
        confluenceUrl: "mycompany.atlassian.net/wiki",
        isCloud: true,
      });
      expect(result.confluenceUrl).toBe(
        "https://mycompany.atlassian.net/wiki",
      );
    });

    test("prepends https:// when no protocol is provided (GitHub)", () => {
      const result = GithubConfigSchema.parse({
        type: "github",
        githubUrl: "api.github.com",
        owner: "test-org",
      });
      expect(result.githubUrl).toBe("https://api.github.com");
    });

    test("prepends https:// when no protocol is provided (GitLab)", () => {
      const result = GitlabConfigSchema.parse({
        type: "gitlab",
        gitlabUrl: "gitlab.com",
      });
      expect(result.gitlabUrl).toBe("https://gitlab.com");
    });

    test("preserves existing https:// protocol", () => {
      const result = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "https://mycompany.atlassian.net",
        isCloud: true,
      });
      expect(result.jiraBaseUrl).toBe("https://mycompany.atlassian.net");
    });

    test("preserves existing http:// protocol", () => {
      const result = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "http://jira.internal.company.com",
        isCloud: false,
      });
      expect(result.jiraBaseUrl).toBe("http://jira.internal.company.com");
    });

    test("handles protocol prepending with trailing slash stripping", () => {
      const result = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "mycompany.atlassian.net/",
        isCloud: true,
      });
      expect(result.jiraBaseUrl).toBe("https://mycompany.atlassian.net");
    });

    test("produces identical output with and without protocol", () => {
      const withProtocol = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "https://mycompany.atlassian.net",
        isCloud: true,
      });
      const withoutProtocol = JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "mycompany.atlassian.net",
        isCloud: true,
      });
      expect(withProtocol.jiraBaseUrl).toBe(withoutProtocol.jiraBaseUrl);
    });
  });

  describe("ConnectorConfigSchema discriminated union", () => {
    test("normalizes jira URL through discriminated union", () => {
      const result = ConnectorConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: "https://mycompany.atlassian.net/",
        isCloud: true,
      });
      expect(result.type).toBe("jira");
      if (result.type === "jira") {
        expect(result.jiraBaseUrl).toBe("https://mycompany.atlassian.net");
      }
    });

    test("normalizes confluence URL through discriminated union", () => {
      const result = ConnectorConfigSchema.parse({
        type: "confluence",
        confluenceUrl: "https://mycompany.atlassian.net/",
        isCloud: true,
      });
      expect(result.type).toBe("confluence");
      if (result.type === "confluence") {
        expect(result.confluenceUrl).toBe("https://mycompany.atlassian.net");
      }
    });
  });
});
