import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useExternalMcpSkills } from "@/lib/skills/skill.query";
import { SkillPill } from "./skill-pill";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/skills/skill.query");

describe("SkillPill", () => {
  beforeEach(() => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as never);
    vi.mocked(useExternalMcpSkills).mockReturnValue({
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          mcpServerId: "7e8933c4-3333-4333-8333-333333333333",
          serverName: "TTRPG Helper",
          scope: "personal",
          name: "fallout-rpg",
        },
      ],
    } as never);
  });

  it("reduces an external MCP reference to its human Skill name and source", () => {
    render(
      <SkillPill skillName="TTRPG Helper [personal:7e8933c4] / fallout-rpg" />,
    );

    const link = screen.getByRole("link", { name: "fallout-rpg" });
    expect(link).toHaveAttribute(
      "href",
      "/skills/external/11111111-1111-4111-8111-111111111111?mcpServerId=7e8933c4-3333-4333-8333-333333333333",
    );
    expect(link.closest("div")).toHaveAttribute(
      "title",
      "fallout-rpg from TTRPG Helper",
    );
    expect(screen.queryByText(/personal:7e8933c4/)).not.toBeInTheDocument();
  });

  it("uses the exact detail href supplied by persisted chat metadata", () => {
    render(
      <SkillPill
        skillName="TTRPG Helper [personal:7e8933c4] / fallout-rpg"
        href="/skills/external/exact?mcpServerId=server"
      />,
    );

    expect(screen.getByRole("link", { name: "fallout-rpg" })).toHaveAttribute(
      "href",
      "/skills/external/exact?mcpServerId=server",
    );
  });

  it("preserves the standalone Skill search and edit deep link", () => {
    render(<SkillPill skillName="Build App" />);

    expect(screen.getByRole("link", { name: "Build App" })).toHaveAttribute(
      "href",
      "/skills?search=Build%20App&openEdit=Build%20App",
    );
  });

  it("uses a plain loading label before the tool input is available", () => {
    render(<SkillPill skillName={null} />);
    expect(screen.getByText("Loading skill")).toBeInTheDocument();
  });
});
