import { render, screen } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMyStatistics, useMyUsageBreakdown } from "@/lib/statistics.query";
import MyUsagePage from "./page";

vi.mock("next/navigation");
vi.mock("@/lib/statistics.query");

vi.mock("@/components/my-usage-summary", () => ({
  MyUsageSummary: () => <div>usage summary</div>,
}));

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({
    title,
    description,
    tabs,
    children,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    tabs?: { href: string }[];
    children: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <div>{description}</div>
      <div data-testid="tabs">{tabs?.map((tab) => tab.href).join(",")}</div>
      {children}
    </div>
  ),
}));

describe("MyUsagePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useMyStatistics).mockReturnValue({
      isPending: true,
    } as ReturnType<typeof useMyStatistics>);
    vi.mocked(useMyUsageBreakdown).mockReturnValue({
      isPending: true,
    } as ReturnType<typeof useMyUsageBreakdown>);
  });

  it("renders as a standalone personal page without organization tabs", () => {
    render(<MyUsagePage />);

    expect(
      screen.getByRole("heading", { name: "My Usage" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("tabs")).toBeEmptyDOMElement();
    expect(screen.getByText(/your own llm activity/i)).toBeInTheDocument();
  });
});
