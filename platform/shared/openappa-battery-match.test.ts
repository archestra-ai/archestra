import { describe, expect, test } from "vitest";
import { matchBatteries } from "./openappa-battery-match";

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

  test("GitHub Enterprise servers match by the ghe.com host or a mirrored official image", () => {
    expect(
      matchBatteries(
        {
          name: "Source control",
          serverUrl: "https://copilot-api.octocorp.ghe.com/mcp",
          localConfig: null,
        },
        available,
      ),
    ).toEqual([{ battery: "github", evidence: "host" }]);
    const enterpriseServer = (dockerImage: string) => ({
      name: "Source control",
      serverUrl: null,
      localConfig: {
        dockerImage,
        command: "/server/github-mcp-server",
        arguments: ["stdio"],
        environment: [
          {
            key: "GITHUB_HOST",
            type: "plain_text" as const,
            value: "https://code.example.com",
            promptOnInstallation: false,
          },
        ],
      },
    });
    for (const dockerImage of [
      "registry.example.com/github/github-mcp-server:v0.30.1",
      "docker.io/github/github-mcp-server:latest",
      "harbor.example.com/ghcr-proxy/github/github-mcp-server@sha256:e47f6ccc5347e1ea6be495d8d9ab55ac8a995fe87800fb984fa770cebe14ad44",
    ])
      expect(matchBatteries(enterpriseServer(dockerImage), available)).toEqual([
        { battery: "github", evidence: "image" },
      ]);
    for (const dockerImage of [
      "registry.example.com/acme/github-mcp-server",
      "registry.example.com/github/github-mcp-server-fork",
    ])
      expect(matchBatteries(enterpriseServer(dockerImage), available)).toEqual(
        [],
      );
    expect(
      matchBatteries(
        {
          name: "Source control",
          serverUrl: "https://ghe.com.example.com/mcp",
          localConfig: null,
        },
        available,
      ),
    ).toEqual([]);
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
