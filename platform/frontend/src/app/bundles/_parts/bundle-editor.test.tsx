import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { skillsMock, pluginsMock, profilesMock } = vi.hoisted(() => ({
  skillsMock: vi.fn(),
  pluginsMock: vi.fn(),
  profilesMock: vi.fn(),
}));

vi.mock("next/navigation");
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    backLink,
    children,
  }: {
    backLink?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <>
      {backLink}
      {children}
    </>
  ),
}));
vi.mock("@/lib/bundle.query", () => ({
  useCreateBundle: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateBundle: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/skills/skill.query", () => ({
  useAllSkills: () => skillsMock(),
}));
vi.mock("@/lib/plugins/plugin.query", () => ({
  usePlugins: () => pluginsMock(),
}));
vi.mock("@/lib/agent.query", () => ({
  useProfiles: () => profilesMock(),
}));

import { useRouter, useSearchParams } from "next/navigation";
import { BundleCreatePage } from "./bundle-editor";

describe("BundleCreatePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    skillsMock.mockReturnValue({ data: [] });
    pluginsMock.mockReturnValue({ data: [] });
    profilesMock.mockReturnValue({ data: [] });
  });

  it("uses Continue for details, then presents labelled capability controls in install order", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    const { unmount } = render(<BundleCreatePage />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeVisible();
    unmount();

    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("step=capabilities") as ReturnType<
        typeof useSearchParams
      >,
    );
    render(<BundleCreatePage />);

    const skills = screen.getByRole("combobox", {
      name: "Skills (0 selected)",
    });
    const plugins = screen.getByRole("combobox", {
      name: "Plugins (0 selected)",
    });
    const gateway = screen.getByRole("combobox", { name: "MCP gateway" });
    const localMcp = screen.getByRole("heading", {
      name: "Local MCP servers (0)",
    });

    expect(skills.compareDocumentPosition(plugins)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(plugins.compareDocumentPosition(gateway)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(gateway.compareDocumentPosition(localMcp)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
