import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bundleMock, deleteBundleMock, skillsMock, pluginsMock, profilesMock } =
  vi.hoisted(() => ({
    bundleMock: vi.fn(),
    deleteBundleMock: vi.fn(),
    skillsMock: vi.fn(),
    pluginsMock: vi.fn(),
    profilesMock: vi.fn(),
  }));

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    actionButton,
    children,
  }: {
    actionButton?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <>
      {actionButton}
      {children}
    </>
  ),
}));
vi.mock("@/lib/bundle.query", () => ({
  useBundle: () => bundleMock(),
  useDeleteBundle: () => deleteBundleMock(),
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

import { useRouter } from "next/navigation";
import { useHasPermissions } from "@/lib/auth/auth.query";
import BundleDetailPage from "./page.client";

function mockBundle(overrides: Record<string, unknown> = {}) {
  bundleMock.mockReturnValue({
    data: {
      id: "bundle-1",
      organizationId: "org-1",
      name: "Engineering baseline",
      description: "A focused setup.",
      mcpGatewayId: null,
      skillIds: [],
      pluginIds: [],
      localMcpServers: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      ...overrides,
    },
    isPending: false,
    isLoadingError: false,
    refetch: vi.fn(),
  });
}

describe("BundleDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    skillsMock.mockReturnValue({ data: [] });
    pluginsMock.mockReturnValue({ data: [] });
    profilesMock.mockReturnValue({ data: [] });
    deleteBundleMock.mockReturnValue({ isPending: false, mutate: vi.fn() });
    mockBundle();
  });

  it("keeps destructive deletion in an accessible More actions menu", async () => {
    const user = userEvent.setup();
    render(<BundleDetailPage bundleId="bundle-1" />);

    await user.click(screen.getByRole("button", { name: "More actions" }));

    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteItem).not.toHaveAttribute("aria-disabled", "true");
    await user.click(deleteItem);
    expect(screen.getByText("Delete bundle?")).toBeVisible();
  });

  it("uses one compact empty state when no capability category has content", () => {
    render(<BundleDetailPage bundleId="bundle-1" />);

    expect(screen.getByText("No capabilities in this bundle")).toBeVisible();
    expect(screen.getByRole("link", { name: "Edit bundle" })).toHaveAttribute(
      "href",
      "/bundles/bundle-1/edit",
    );
    expect(
      screen.queryByRole("heading", { name: "Skills" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Plugins" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Local MCP servers" }),
    ).not.toBeInTheDocument();
  });
});
