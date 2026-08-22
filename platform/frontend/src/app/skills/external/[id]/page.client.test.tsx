import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/skills/external/skill-1",
  useSearchParams: () => new URLSearchParams("mcpServerId=server-1"),
}));
vi.mock("@/lib/skills/skill.query", () => ({ useExternalMcpSkill: vi.fn() }));
vi.mock("@/lib/hooks/use-app-name", () => ({ useAppName: () => "Archestra" }));
vi.mock("../../_parts/skill-content-editor", () => ({
  SkillContentEditor: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="content" data-read-only={readOnly} />
  ),
}));

import { useExternalMcpSkill } from "@/lib/skills/skill.query";
import { ExternalMcpSkillPage } from "./page.client";

beforeEach(() => {
  vi.mocked(useExternalMcpSkill).mockReturnValue({
    data: {
      source: "external_mcp",
      id: "skill-1",
      catalogId: "catalog-1",
      mcpServerId: "server-1",
      scope: "org",
      serverName: "Operations server",
      icon: "🛰️",
      name: "release-checklist",
      description: "Current description.",
      uri: "skill://example/release/SKILL.md",
      resources: [],
      usageCount: 3,
      usageUserCount: 1,
      lastUsedAt: "2026-08-21T12:00:00.000Z",
      content: "# Current source",
      files: [],
    },
    isPending: false,
    // biome-ignore lint/suspicious/noExplicitAny: partial query state is enough
  } as any);
});

describe("ExternalMcpSkillPage", () => {
  it("renders a live, read-only source view without edit/version actions", () => {
    render(<ExternalMcpSkillPage id="skill-1" />);

    expect(screen.getByText("release-checklist")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Operations server" }),
    ).toHaveAttribute("href", "/mcp/registry/catalog-1");
    expect(screen.getByText(/not copied or versioned/)).toBeInTheDocument();
    expect(screen.getByTestId("content")).toHaveAttribute(
      "data-read-only",
      "true",
    );
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });
});
