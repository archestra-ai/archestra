import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelativeTime } from "./relative-time";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("RelativeTime", () => {
  it("reads as a relative phrase, with the exact timestamp on hover", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));

    render(<RelativeTime date="2026-08-21T09:00:00.000Z" />);

    expect(screen.getByText("about 3 hours ago")).toBeInTheDocument();
    // The absolute instant stays reachable — the point of the pair.
    expect(screen.getByTestId("tooltip")).toHaveTextContent("08/21/2026");
  });

  it("renders the empty label rather than a bogus date when there is none", () => {
    render(<RelativeTime date={null} emptyLabel="Never synced" />);
    expect(screen.getByText("Never synced")).toBeInTheDocument();
  });

  it("does not render an unparseable date as 'Invalid Date'", () => {
    render(<RelativeTime date="not-a-date" />);
    expect(screen.getByText("-")).toBeInTheDocument();
  });
});
