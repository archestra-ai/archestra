import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: vi.fn(() => ({ data: true })),
  useMissingPermissions: vi.fn(() => ({})),
}));

import {
  filterPluginSkills,
  PluginSkillsSection,
} from "./plugin-skills-section";

const skill = {
  source: "plugin" as const,
  pluginId: "11111111-1111-4111-8111-111111111111",
  pluginName: "STE bundle",
  pluginSlug: "ste-bundle-11111111",
  pluginEnabled: true,
  scope: "org" as const,
  clientType: "claude-code" as const,
  supportedPlatforms: ["posix" as const],
  skillPath: "skills/ste-writing",
  name: "ste-writing",
  description: "Write without AI slop.",
  compatibility: null,
  fileCount: 2,
};

const detailHref = `/skills/plugins/${skill.pluginId}?skillPath=skills%2Fste-writing`;

describe("PluginSkillsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders plugin provenance and the beta category", () => {
    render(<PluginSkillsSection skills={[skill]} />);

    expect(screen.getByText("Skills from plugins")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("STE bundle")).toBeInTheDocument();
    expect(screen.getByText("ste-writing")).toBeInTheDocument();
    expect(screen.getByText(/claude-code/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "STE bundle" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "View ste-writing" }),
    ).toHaveAttribute("href", detailHref);
  });

  it("opens the detail page from the row", async () => {
    const user = userEvent.setup();
    render(<PluginSkillsSection skills={[skill]} />);

    const row = screen.getByText("ste-writing").closest("tr");
    expect(row).not.toBeNull();
    await user.click(row as HTMLElement);
    expect(mockPush).toHaveBeenCalledWith(detailHref);
  });

  it("applies the shared page search and scope filters", () => {
    expect(filterPluginSkills({ skills: [skill], search: "missing" })).toEqual(
      [],
    );
    expect(
      filterPluginSkills({
        skills: [skill],
        search: "ste bundle",
        scope: "org",
      }),
    ).toEqual([skill]);
    expect(filterPluginSkills({ skills: [skill], scope: "team" })).toEqual([]);
  });
});
