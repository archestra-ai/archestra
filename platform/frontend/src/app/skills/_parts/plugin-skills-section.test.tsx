import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TableCardView } from "@/components/table-card-view";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useSession: vi.fn(() => ({ data: { user: { id: "user-1" } } })),
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
  sourceRepo: "archestra-ai/portable-skills",
  sourceMarketplaceRepo: null,
  pluginEnabled: true,
  scope: "org" as const,
  clientType: "claude-code" as const,
  supportedPlatforms: ["posix" as const],
  skillPath: "skills/ste-writing",
  name: "ste-writing",
  description: "Write without AI slop.",
  compatibility: "Requires node 20+.",
  fileCount: 2,
  usageCount: 3,
  usageUserCount: 2,
  lastUsedAt: "2026-08-27T12:00:00.000Z",
};

const detailHref = `/skills/plugins/${skill.pluginId}?skillPath=skills%2Fste-writing`;

describe("PluginSkillsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("renders plugin provenance and the beta category", () => {
    const { container } = render(<PluginSkillsSection skills={[skill]} />);

    expect(screen.getByText("Skills from plugins")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("STE bundle")).toBeInTheDocument();
    expect(
      container.querySelector('[title="Source: archestra-ai/portable-skills"]'),
    ).toBeInTheDocument();
    expect(screen.getByText("ste-writing")).toBeInTheDocument();
    expect(screen.getByText("compatibility")).toBeInTheDocument();
    expect(screen.getByText(/claude-code/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "STE bundle" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View ste-writing" })).toBeNull();
  });

  it("opens the detail page from the row", async () => {
    const user = userEvent.setup();
    render(<PluginSkillsSection skills={[skill]} />);

    const row = screen.getByText("ste-writing").closest("tr");
    expect(row).not.toBeNull();
    await user.click(row as HTMLElement);
    expect(mockPush).toHaveBeenCalledWith(detailHref);
  });

  it("sorts plugin skills from the shared table header", async () => {
    const user = userEvent.setup();
    const alphaSkill = {
      ...skill,
      pluginId: "22222222-2222-4222-8222-222222222222",
      pluginName: "Alpha bundle",
      skillPath: "skills/alpha-writing",
      name: "alpha-writing",
    };
    render(<PluginSkillsSection skills={[skill, alphaSkill]} />);

    await user.click(screen.getByRole("button", { name: "Plugin" }));

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Alpha bundle")).toBeInTheDocument();
    expect(within(rows[1]).getByText("STE bundle")).toBeInTheDocument();
  });

  it("keeps read-only cards on the same paginated collection model", async () => {
    const user = userEvent.setup();
    const skills = Array.from({ length: 11 }, (_, index) => ({
      ...skill,
      pluginId: `plugin-${index}`,
      skillPath: `skills/skill-${index}`,
      name: `skill-${index}`,
    }));
    window.localStorage.setItem("plugin-skills-test-view", "cards");
    render(
      <TableCardView storageKey="plugin-skills-test-view">
        <PluginSkillsSection skills={skills} />
      </TableCardView>,
    );

    expect(
      await screen.findByRole("heading", { name: "skill-0" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "skill-0" })).toHaveAttribute(
      "href",
      "/skills/plugins/plugin-0?skillPath=skills%2Fskill-0",
    );
    expect(
      screen.queryByRole("heading", { name: "skill-10" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getAllByText("2 files")).toHaveLength(10);

    const nextPage = screen
      .getAllByRole("button", { name: "Go to next page" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(nextPage).toBeDefined();
    await user.click(nextPage as HTMLButtonElement);

    expect(
      await screen.findByRole("heading", { name: "skill-10" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "skill-0" }),
    ).not.toBeInTheDocument();
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
