import { describe, expect, test } from "@/test";
import {
  ConfluenceConfigSchema,
  ConnectorConfigSchema,
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
