import type { archestraApiTypes } from "@archestra/shared";
import { describe, expect, it, vi } from "vitest";
import { matchesKind } from "./page.client";

vi.mock("next/navigation");

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

const ownedApp: Extract<AppListItem, { source: "owned" }> = {
  source: "owned",
  id: "owned-1",
  name: "My Owned App",
  description: "An owned app",
  scope: "org",
  authorId: "user-1",
  latestVersion: 1,
  teams: [],
  executionModel: "viewer-scoped",
  cspOrigin: "platform-pinned",
  pinnedAt: null,
};

const externalApp: Extract<AppListItem, { source: "external" }> = {
  source: "external",
  catalogId: "cat-1",
  mcpServerId: "srv-1",
  scope: "org",
  name: "Archestra PM / show_board",
  description: "Shows the project board",
  resourceUri: "ui://pm/board.html",
  executionModel: "server-scoped",
  cspOrigin: "author-declared",
  pinnedAt: null,
  icon: null,
  requiresInput: false,
};

describe("matchesKind", () => {
  it("matches every app when kind is all", () => {
    expect(matchesKind(ownedApp, "all")).toBe(true);
    expect(matchesKind(externalApp, "all")).toBe(true);
  });

  it("matches only platform-authored apps when kind is owned", () => {
    expect(matchesKind(ownedApp, "owned")).toBe(true);
    expect(matchesKind(externalApp, "owned")).toBe(false);
  });

  it("matches only MCP server apps when kind is external", () => {
    expect(matchesKind(ownedApp, "external")).toBe(false);
    expect(matchesKind(externalApp, "external")).toBe(true);
  });

  it("matches every app for an unknown kind param", () => {
    expect(matchesKind(ownedApp, "bogus")).toBe(true);
    expect(matchesKind(externalApp, "bogus")).toBe(true);
  });
});
