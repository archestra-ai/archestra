import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import CostsLayout from "./layout";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");

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
  canReadOptimizationRules,
}: {
  canReadCosts: boolean;
  canReadLimits: boolean;
  canReadOptimizationRules: boolean;
}) => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: canReadCosts,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(usePermissionMap).mockReturnValue({
    "/llm/limits": canReadLimits,
    "/llm/optimization-rules": canReadOptimizationRules,
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
      canReadOptimizationRules: false,
    });

    render(<CostsLayout>content</CostsLayout>);

    // Costs is ungated now, so it stays; the siblings would only ever render a
    // forbidden page for this reader.
    expect(screen.getByTestId("tabs")).toHaveTextContent("/llm/costs");
    expect(screen.getByTestId("tabs")).not.toHaveTextContent("/llm/limits");
    expect(screen.getByTestId("tabs")).not.toHaveTextContent(
      "/llm/optimization-rules",
    );
  });

  it("keeps every tab for a reader who may open them all", () => {
    setPermissions({
      canReadCosts: true,
      canReadLimits: true,
      canReadOptimizationRules: true,
    });

    render(<CostsLayout>content</CostsLayout>);

    const tabs = screen.getByTestId("tabs");
    expect(tabs).toHaveTextContent("/llm/costs");
    expect(tabs).toHaveTextContent("/llm/limits");
    expect(tabs).toHaveTextContent("/llm/optimization-rules");
  });

  it("describes the page as personal when organization-wide costs are out of reach", () => {
    setPermissions({
      canReadCosts: false,
      canReadLimits: false,
      canReadOptimizationRules: false,
    });

    render(<CostsLayout>content</CostsLayout>);

    expect(screen.getByTestId("description")).toHaveTextContent(
      /your own llm usage and spend/i,
    );
    // No promise of figures this reader will not see.
    expect(screen.getByTestId("description")).not.toHaveTextContent(
      /across teams, agents, and models/i,
    );
  });

  it("describes the organization-wide view when the reader may see it", () => {
    setPermissions({
      canReadCosts: true,
      canReadLimits: true,
      canReadOptimizationRules: true,
    });

    render(<CostsLayout>content</CostsLayout>);

    expect(screen.getByTestId("description")).toHaveTextContent(
      /across teams, agents, and models/i,
    );
  });
});
