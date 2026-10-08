import { describe, expect, test } from "vitest";
import {
  matchBatteries,
  matchBatteriesByToolNames,
} from "./openappa-battery-match";

const available = new Set(["github", "notion", "slack", "linear"]);

describe("matchBatteries", () => {
  test("a known server host or image outweighs a misleading name", () => {
    expect(
      matchBatteries(
        {
          name: "Issue tracker (notion)",
          serverUrl: "https://api.githubcopilot.com/mcp/",
          localConfig: null,
        },
        available,
      ),
    ).toEqual([{ battery: "github", evidence: "host" }]);
    expect(
      matchBatteries(
        {
          name: "Team chat",
          serverUrl: null,
          localConfig: {
            dockerImage: "ghcr.io/github/github-mcp-server:v0.20.0",
          },
        },
        available,
      ),
    ).toEqual([{ battery: "github", evidence: "image" }]);
    expect(
      matchBatteries(
        {
          name: "Team chat",
          serverUrl: null,
          localConfig: { dockerImage: "docker.io/mcp/github:latest" },
        },
        available,
      ),
    ).toEqual([{ battery: "github", evidence: "image" }]);
    expect(
      matchBatteries(
        {
          name: "Team chat",
          serverUrl: null,
          localConfig: { dockerImage: "registry.example.com/mcp/github" },
        },
        available,
      ),
    ).toEqual([]);
  });

  test("a subdomain of a known host matches, an unrelated host with a familiar name falls back to the name", () => {
    expect(
      matchBatteries(
        {
          name: "Docs",
          serverUrl: "https://eu.mcp.notion.com/mcp",
          localConfig: null,
        },
        available,
      ),
    ).toEqual([{ battery: "notion", evidence: "host" }]);
    expect(
      matchBatteries(
        {
          name: "Linear - Engineering",
          serverUrl: "https://mcp.example.com/linear",
          localConfig: null,
        },
        available,
      ),
    ).toEqual([{ battery: "linear", evidence: "name" }]);
  });

  test("the monday Platform MCP server matches the monday battery", () => {
    expect(
      matchBatteries(
        {
          name: "Work management",
          serverUrl: "https://mcp.monday.com/mcp",
          localConfig: null,
        },
        new Set(["monday"]),
      ),
    ).toEqual([{ battery: "monday", evidence: "host" }]);
    expect(
      matchBatteries(
        { name: "monday.com", serverUrl: null, localConfig: null },
        new Set(["monday"]),
      ),
    ).toEqual([{ battery: "monday", evidence: "name" }]);
  });

  test("only available batteries and no false positives", () => {
    expect(
      matchBatteries(
        {
          name: "PagerDuty",
          serverUrl: "https://mcp.pagerduty.com/mcp",
          localConfig: null,
        },
        available,
      ),
    ).toEqual([]);
    expect(
      matchBatteries(
        {
          name: "Internal wiki",
          serverUrl: "https://wiki.example.com/mcp",
          localConfig: null,
        },
        available,
      ),
    ).toEqual([]);
  });

  test("a name fragment matches whole words only", () => {
    expect(
      matchBatteries(
        { name: "github-mcp (prod)", serverUrl: null, localConfig: null },
        available,
      ),
    ).toEqual([{ battery: "github", evidence: "name" }]);
    expect(
      matchBatteries(
        { name: "Notional planning", serverUrl: null, localConfig: null },
        available,
      ),
    ).toEqual([]);
  });
});

describe("matchBatteriesByToolNames", () => {
  const rules = new Map<string, ReadonlySet<string>>([
    ["slack", new Set(["slack_send_message", "slack_list_channels"])],
    ["github", new Set(["create_issue", "list"])],
    ["linear", new Set(["create_issue"])],
  ]);

  test("names the batteries whose rules address the server's tools, most named first", () => {
    expect(
      matchBatteriesByToolNames(
        new Set(["slack_send_message", "slack_list_channels", "create_issue"]),
        rules,
      ),
    ).toEqual([
      { battery: "slack", evidence: "tool" },
      { battery: "github", evidence: "tool" },
      { battery: "linear", evidence: "tool" },
    ]);
  });

  test("a server none of the rules address matches nothing", () => {
    expect(matchBatteriesByToolNames(new Set(["forecast"]), rules)).toEqual([]);
    expect(matchBatteriesByToolNames(new Set(), rules)).toEqual([]);
  });
});
