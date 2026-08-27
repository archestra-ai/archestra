import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/skills/plugins/plugin-1",
  useSearchParams: () => new URLSearchParams("skillPath=skills/ste-writing"),
}));
vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: vi.fn(() => ({ data: true })),
}));
vi.mock("@/lib/skills/skill.query", () => ({ usePluginSkill: vi.fn() }));
vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Workspace",
}));
vi.mock("../../_parts/skill-content-editor", () => ({
  SkillContentEditor: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="content" data-read-only={readOnly} />
  ),
}));

import { usePluginSkill } from "@/lib/skills/skill.query";
import { PluginSkillPage } from "./page.client";

beforeEach(() => {
  vi.mocked(usePluginSkill).mockReturnValue({
    data: {
      source: "plugin",
      pluginId: "plugin-1",
      pluginName: "STE bundle",
      pluginSlug: "ste-bundle-plugin-1",
      pluginEnabled: true,
      scope: "org",
      clientType: "claude-code",
      supportedPlatforms: ["posix"],
      skillPath: "skills/ste-writing",
      name: "ste-writing",
      description: "Write without AI slop.",
      compatibility: null,
      fileCount: 1,
      manifest:
        "---\nname: ste-writing\ndescription: Write plainly.\n---\n\n# STE writing",
      content: "# STE writing",
      allowedTools: null,
      resourcesRestricted: false,
      files: [],
    },
    isPending: false,
    // biome-ignore lint/suspicious/noExplicitAny: partial query state is enough
  } as any);
});

describe("PluginSkillPage", () => {
  it("renders a beta, read-only plugin source view", () => {
    render(<PluginSkillPage pluginId="plugin-1" />);

    expect(screen.getByText("ste-writing")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "STE bundle" })).toHaveAttribute(
      "href",
      "/plugins/plugin-1",
    );
    const sourceNotice = screen.getByText(
      (_, element) =>
        element?.tagName === "P" &&
        element.textContent?.includes("This portable skill comes from") ===
          true,
    );
    expect(sourceNotice).toHaveTextContent(/not copied or versioned/);
    expect(sourceNotice).toHaveTextContent(/standalone Workspace skill/);
    expect(screen.getByTestId("content")).toHaveAttribute(
      "data-read-only",
      "true",
    );
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });
});
