import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionMap } from "@/lib/auth/auth.query";
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
}: {
  canReadCosts: boolean;
  canReadLimits: boolean;
}) => {
  vi.mocked(usePermissionMap).mockReturnValue({
    "/llm/costs": canReadCosts,
    "/llm/limits": canReadLimits,
  } as unknown as ReturnType<typeof usePermissionMap>);
};

describe("CostsLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/llm/usage");
  });

  it("offers only the tabs the reader can actually open", () => {
    setPermissions({
      canReadCosts: false,
      canReadLimits: false,
    });

    render(<CostsLayout>content</CostsLayout>);

    // My Usage is ungated, so it stays; the siblings would only ever render a
    // forbidden page for this reader.
    expect(screen.getByTestId("tabs")).toHaveTextContent("/llm/usage");
    expect(screen.getByTestId("tabs")).not.toHaveTextContent("/llm/costs");
    expect(screen.getByTestId("tabs")).not.toHaveTextContent("/llm/limits");
  });

  it("keeps every tab for a reader who may open them all", () => {
    setPermissions({
      canReadCosts: true,
      canReadLimits: true,
    });

    render(<CostsLayout>content</CostsLayout>);

    const tabs = screen.getByTestId("tabs");
    expect(tabs).toHaveTextContent("/llm/usage");
    expect(tabs).toHaveTextContent("/llm/costs");
    expect(tabs).toHaveTextContent("/llm/limits");
  });

  it("describes My Usage as personal", () => {
    setPermissions({
      canReadCosts: false,
      canReadLimits: false,
    });

    render(<CostsLayout>content</CostsLayout>);

    expect(screen.getByTestId("description")).toHaveTextContent(
      /your own llm activity/i,
    );
    // No promise of figures this reader will not see.
    expect(screen.getByTestId("description")).not.toHaveTextContent(
      /across teams, agents, and models/i,
    );
  });

  it("describes the organization-wide view when the reader may see it", () => {
    vi.mocked(usePathname).mockReturnValue("/llm/costs");
    setPermissions({
      canReadCosts: true,
      canReadLimits: true,
    });

    render(<CostsLayout>content</CostsLayout>);

    expect(screen.getByTestId("description")).toHaveTextContent(
      /across teams, agents, and models/i,
    );
  });
});
