import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionMap } from "@/lib/auth/auth.query";
import { useTeamLimitAccess } from "@/lib/limits-access";
import CostsLayout from "./layout";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/limits-access");

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    description,
    tabs,
    children,
  }: {
    description?: React.ReactNode;
    tabs?: { label: React.ReactNode; href: string }[];
    children: React.ReactNode;
  }) => (
    <div>
      <div data-testid="description">{description}</div>
      <div data-testid="tabs">
        {(tabs ?? []).map((tab) => tab.href).join(",")}
      </div>
      {children}
    </div>
  ),
}));

vi.mock("@/components/external-docs-link", () => ({
  ExternalDocsLink: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

const setPermissions = ({
  canReadCosts,
  canReadLimits,
  canReadModels = false,
  canReadExports = false,
}: {
  canReadCosts: boolean;
  canReadLimits: boolean;
  canReadModels?: boolean;
  canReadExports?: boolean;
}) => {
  vi.mocked(usePermissionMap).mockReturnValue({
    "/llm/costs": canReadCosts,
    "/llm/limits": canReadLimits,
    "/llm/cost-exports": canReadExports,
    "/llm/models": canReadModels,
  } as unknown as ReturnType<typeof usePermissionMap>);
};

describe("CostsLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/llm/costs");
  });

  it("offers only the tabs the reader can actually open", () => {
    setPermissions({
      canReadCosts: false,
      canReadLimits: false,
    });

    render(<CostsLayout>content</CostsLayout>);

    expect(screen.getByTestId("tabs")).toBeEmptyDOMElement();
  });

  it("scopes the Costs description to a team admin's teams", () => {
    setPermissions({ canReadCosts: false, canReadLimits: false });
    vi.mocked(useTeamLimitAccess).mockReturnValue({
      canRead: true,
      isTeamAdmin: true,
    } as ReturnType<typeof useTeamLimitAccess>);
    render(<CostsLayout>content</CostsLayout>);
    expect(screen.getByTestId("description")).toHaveTextContent(
      /across the teams you administer/i,
    );
  });

  it("offers a team admin Model Settings only when they can open it", () => {
    vi.mocked(useTeamLimitAccess).mockReturnValue({
      canRead: true,
      isTeamAdmin: true,
    } as ReturnType<typeof useTeamLimitAccess>);
    setPermissions({ canReadCosts: false, canReadLimits: false });
    const { unmount } = render(<CostsLayout>content</CostsLayout>);
    expect(
      screen.queryByRole("link", { name: "Model Settings" }),
    ).not.toBeInTheDocument();
    unmount();

    setPermissions({
      canReadCosts: false,
      canReadLimits: false,
      canReadModels: true,
    });
    render(<CostsLayout>content</CostsLayout>);
    expect(
      screen.getByRole("link", { name: "Model Settings" }),
    ).toHaveAttribute("href", "/llm/models");
  });

  it("gives Cost Controls the Limits and Exports tabs, and Costs none", () => {
    setPermissions({
      canReadCosts: true,
      canReadLimits: true,
      canReadExports: true,
    });

    vi.mocked(usePathname).mockReturnValue("/llm/limits");
    const { unmount } = render(<CostsLayout>content</CostsLayout>);
    const tabs = screen.getByTestId("tabs");
    expect(tabs).toHaveTextContent("/llm/limits");
    expect(tabs).toHaveTextContent("/llm/cost-exports");
    expect(tabs).not.toHaveTextContent("/llm/costs,");
    unmount();

    vi.mocked(usePathname).mockReturnValue("/llm/costs");
    render(<CostsLayout>content</CostsLayout>);
    expect(screen.getByTestId("tabs")).toBeEmptyDOMElement();
  });

  it("describes the organization-wide view when the reader may see it", () => {
    setPermissions({
      canReadCosts: true,
      canReadLimits: true,
    });

    render(<CostsLayout>content</CostsLayout>);

    expect(screen.getByTestId("description")).toHaveTextContent(
      /track spend, token usage and requests across your organization/i,
    );
  });
});
