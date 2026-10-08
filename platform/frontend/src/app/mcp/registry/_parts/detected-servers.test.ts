// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { DetectedMcpServer } from "@/lib/mcp/detected-mcp-server.query";
import { filterDetectedServers } from "./detected-servers";

const server = (
  clientFamily: DetectedMcpServer["clientFamily"],
  label: string,
): DetectedMcpServer => ({
  id: `${clientFamily}.${label}`,
  label,
  clientFamily,
  tools: [],
  observerCount: 1,
  firstObservedAt: "2026-10-01T00:00:00.000Z",
});

describe("filterDetectedServers", () => {
  const servers = [
    server("opencode", "slack"),
    server("claude-code", "linear"),
    server("claude-code", "slack"),
    server("codex", "Slack-Admin"),
  ];

  it("orders by label, then client, so one server's clients sit together", () => {
    expect(filterDetectedServers(servers, "").map((s) => s.id)).toEqual([
      "claude-code.linear",
      "claude-code.slack",
      "opencode.slack",
      "codex.Slack-Admin",
    ]);
  });

  it("matches the search against the label, ignoring case and surrounding spaces", () => {
    expect(filterDetectedServers(servers, "  SLACK ").map((s) => s.id)).toEqual(
      ["claude-code.slack", "opencode.slack", "codex.Slack-Admin"],
    );
    expect(filterDetectedServers(servers, "claude")).toEqual([]);
  });
});
