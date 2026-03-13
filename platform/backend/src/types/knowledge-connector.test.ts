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
    // Helper to parse a URL through connectorUrlSchema via JiraConfigSchema
    function parseUrl(url: string): string {
      return JiraConfigSchema.parse({
        type: "jira",
        jiraBaseUrl: url,
        isCloud: true,
      }).jiraBaseUrl;
    }

    test("prepends https:// when no protocol is provided", () => {
      expect(parseUrl("mycompany.atlassian.net")).toBe(
        "https://mycompany.atlassian.net",
      );
    });

    test("prepends https:// for all connector types", () => {
      expect(
        ConfluenceConfigSchema.parse({
          type: "confluence",
          confluenceUrl: "mycompany.atlassian.net/wiki",
          isCloud: true,
        }).confluenceUrl,
      ).toBe("https://mycompany.atlassian.net/wiki");

      expect(
        GithubConfigSchema.parse({
          type: "github",
          githubUrl: "api.github.com",
          owner: "test-org",
        }).githubUrl,
      ).toBe("https://api.github.com");

      expect(
        GitlabConfigSchema.parse({
          type: "gitlab",
          gitlabUrl: "gitlab.com",
        }).gitlabUrl,
      ).toBe("https://gitlab.com");
    });

    test("preserves existing https:// protocol", () => {
      expect(parseUrl("https://mycompany.atlassian.net")).toBe(
        "https://mycompany.atlassian.net",
      );
    });

    test("preserves existing http:// protocol", () => {
      expect(parseUrl("http://jira.internal.company.com")).toBe(
        "http://jira.internal.company.com",
      );
    });

    test("preserves protocol case-insensitively", () => {
      expect(parseUrl("HTTP://jira.example.com")).toBe(
        "HTTP://jira.example.com",
      );
      expect(parseUrl("HTTPS://jira.example.com")).toBe(
        "HTTPS://jira.example.com",
      );
      expect(parseUrl("Http://jira.example.com")).toBe(
        "Http://jira.example.com",
      );
    });

    test("preserves unsupported protocols without prepending", () => {
      expect(parseUrl("ftp://files.example.com")).toBe(
        "ftp://files.example.com",
      );
      expect(parseUrl("ssh://git.example.com")).toBe("ssh://git.example.com");
    });

    test("prepends https:// for URL with path but no protocol", () => {
      expect(parseUrl("github.mycompany.com/api/v3")).toBe(
        "https://github.mycompany.com/api/v3",
      );
    });

    test("prepends https:// for URL with port but no protocol", () => {
      expect(parseUrl("localhost:8080")).toBe("https://localhost:8080");
    });

    test("prepends https:// for URL with port and path but no protocol", () => {
      expect(parseUrl("jira.local:8443/rest")).toBe(
        "https://jira.local:8443/rest",
      );
    });

    test("combines protocol prepending with trailing slash stripping", () => {
      expect(parseUrl("mycompany.atlassian.net/")).toBe(
        "https://mycompany.atlassian.net",
      );
      expect(parseUrl("mycompany.atlassian.net///")).toBe(
        "https://mycompany.atlassian.net",
      );
    });

    test("preserves path segments when stripping trailing slashes", () => {
      expect(parseUrl("mycompany.atlassian.net/wiki/")).toBe(
        "https://mycompany.atlassian.net/wiki",
      );
    });

    test("produces identical output with and without protocol", () => {
      expect(parseUrl("mycompany.atlassian.net")).toBe(
        parseUrl("https://mycompany.atlassian.net"),
      );
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
