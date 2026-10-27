import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import AutoRoutingLayout from "./layout";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    tabs,
    children,
  }: {
    tabs?: { label: React.ReactNode; href: string }[];
    children: React.ReactNode;
  }) => (
    <div>
      <div data-testid="tabs">
        {(tabs ?? []).map((tab) => tab.href).join(",")}
      </div>
      {children}
    </div>
  ),
}));

describe("AutoRoutingLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppName).mockReturnValue("Archestra");
  });

  it("offers the overview, plans and diagnostics tabs while the alpha is enabled", () => {
    vi.mocked(useFeature).mockReturnValue(true);

    render(<AutoRoutingLayout>content</AutoRoutingLayout>);

    expect(screen.getByTestId("tabs")).toHaveTextContent(
      "/llm/auto-routing,/llm/auto-routing/plans,/llm/auto-routing/diagnostics",
    );
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("explains that the alpha is off instead of rendering the page", () => {
    vi.mocked(useFeature).mockReturnValue(false);

    render(<AutoRoutingLayout>content</AutoRoutingLayout>);

    expect(screen.getByTestId("tabs")).toBeEmptyDOMElement();
    expect(screen.getByText("Auto routing is off")).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });
});
