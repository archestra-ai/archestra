import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: vi.fn(() => ({ data: { user: { id: "user-1" } } })),
  useHasPermissions: vi.fn(() => ({ data: true })),
  useMissingPermissions: vi.fn(() => ({})),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppIconLogo: () => "/app-icon.png",
}));

vi.mock("@/lib/skills/skill.query", () => ({
  useSkillUsageStatistics: () => ({
    data: { users: [], daily: [] },
    isPending: false,
  }),
}));

import {
  ExternalMcpSkillsSection,
  filterExternalMcpSkills,
} from "./external-mcp-skills-section";

const skill = {
  source: "external_mcp" as const,
  id: "11111111-1111-4111-8111-111111111111",
  catalogId: "22222222-2222-4222-8222-222222222222",
  mcpServerId: "33333333-3333-4333-8333-333333333333",
  scope: "team" as const,
  serverName: "Operations server",
  icon: "🛰️",
  name: "release-checklist",
  description: "Verify a release.",
  uri: "skill://example/release/SKILL.md",
  resources: [
    { uri: "skill://example/release/SKILL.md", digest: "sha256:aaa" },
    { uri: "skill://example/release/run.sh", digest: "sha256:bbb" },
  ],
  usageCount: 7,
  usageUserCount: 2,
  lastUsedAt: "2026-08-21T12:00:00.000Z",
};

const detailHref = `/skills/external/${skill.id}?mcpServerId=${skill.mcpServerId}`;

describe("ExternalMcpSkillsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the source MCP server in its own non-linked column", () => {
    render(<ExternalMcpSkillsSection skills={[skill]} />);

    expect(
      screen.getByText("Skills from installed MCP servers"),
    ).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("🛰️")).toBeInTheDocument();
    expect(screen.getByText("release-checklist")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: /MCP server/ }),
    ).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader");
    expect(headers[0]).toHaveTextContent("MCP server");
    expect(headers[1]).toHaveTextContent("Skill");
    expect(screen.getByText("Operations server")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Operations server" }),
    ).toBeNull();
    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("by 2 users")).toBeInTheDocument();
    expect(screen.getAllByText("Rows per page").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Page 1 of 1").length).toBeGreaterThan(0);
    const chatParams = new URLSearchParams({
      mcp_skill_id: skill.id,
      mcp_server_id: skill.mcpServerId,
      mcp_skill_uri: skill.uri,
      mcp_skill_name: skill.name,
      mcp_server_name: skill.serverName,
      mcp_skill_display_name:
        "Operations server [team:33333333] / release-checklist",
    });
    expect(
      screen.getByRole("link", { name: "Chat release-checklist" }),
    ).toHaveAttribute("href", `/chat/new?${chatParams.toString()}`);
    expect(
      screen.getByRole("link", {
        name: "Manage MCP server release-checklist",
      }),
    ).toHaveAttribute("href", `/mcp/registry/${skill.catalogId}`);
    expect(
      screen.queryByRole("button", { name: /edit/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Version history")).toBeNull();
  });

  it("opens the live detail page from the row without a redundant View action", async () => {
    const user = userEvent.setup();
    render(<ExternalMcpSkillsSection skills={[skill]} />);

    expect(screen.queryByRole("link", { name: /view/i })).toBeNull();

    const row = screen.getByText("release-checklist").closest("tr");
    expect(row).not.toBeNull();
    await user.click(row as HTMLElement);
    expect(mockPush).toHaveBeenCalledWith(detailHref);
  });

  it("opens the shared Usage dialog from the row action", async () => {
    const user = userEvent.setup();
    render(<ExternalMcpSkillsSection skills={[skill]} />);

    await user.click(
      screen.getByRole("button", { name: "Usage release-checklist" }),
    );

    expect(
      screen.getByText('Usage of "release-checklist"'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No uses in the last 30 days."),
    ).toBeInTheDocument();
  });

  it("applies the shared page search and scope filters", () => {
    expect(
      filterExternalMcpSkills({ skills: [skill], search: "missing" }),
    ).toEqual([]);
    expect(
      filterExternalMcpSkills({
        skills: [skill],
        search: "operations",
        scope: "team",
      }),
    ).toEqual([skill]);
    expect(filterExternalMcpSkills({ skills: [skill], scope: "org" })).toEqual(
      [],
    );
  });
});
