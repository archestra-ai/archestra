import { describe, expect, test } from "vitest";
import { matchBatteries } from "./battery-match";

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
    ).toEqual(["github"]);
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
    ).toEqual(["github"]);
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
    ).toEqual(["notion"]);
    expect(
      matchBatteries(
        {
          name: "Linear - Engineering",
          serverUrl: "https://mcp.example.com/linear",
          localConfig: null,
        },
        available,
      ),
    ).toEqual(["linear"]);
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
});
