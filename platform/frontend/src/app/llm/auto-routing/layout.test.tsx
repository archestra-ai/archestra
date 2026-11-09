import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import AutoRoutingLayout from "./layout";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-layout">{children}</div>
  ),
}));

describe("AutoRoutingLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppName).mockReturnValue("Archestra");
  });

  it("renders the page as is while the alpha is enabled", () => {
    vi.mocked(useFeature).mockReturnValue(true);

    render(<AutoRoutingLayout>content</AutoRoutingLayout>);

    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.queryByTestId("page-layout")).not.toBeInTheDocument();
  });

  it("explains that the alpha is off instead of rendering the page", () => {
    vi.mocked(useFeature).mockReturnValue(false);

    render(<AutoRoutingLayout>content</AutoRoutingLayout>);

    expect(screen.getByText("Auto routing is off")).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
  });
});
