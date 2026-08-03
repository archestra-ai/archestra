import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFeature } from "@/lib/config/config.query";
import { DeletedRowMeta } from "./deleted-row-meta";

vi.mock("@/lib/config/config.query");

function setRetention(retention: { enabled: boolean; days: number }) {
  vi.mocked(useFeature).mockReturnValue(
    retention as ReturnType<typeof useFeature>,
  );
}

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("DeletedRowMeta", () => {
  it("shows no countdown when the deployment has no retention sweep", () => {
    // Nothing is coming to delete the row, so promising a date would be a lie.
    setRetention({ enabled: false, days: 30 });

    render(<DeletedRowMeta deletedAt={daysAgo(3)} />);

    expect(screen.getByText(/Deleted 3 days ago/)).toBeInTheDocument();
    expect(screen.queryByText(/Eligible for deletion/)).not.toBeInTheDocument();
  });

  it("counts down the days left in the retention window", () => {
    setRetention({ enabled: true, days: 30 });

    const { rerender } = render(<DeletedRowMeta deletedAt={daysAgo(0)} />);
    expect(
      screen.getByText("Eligible for deletion in 30 days"),
    ).toBeInTheDocument();

    rerender(<DeletedRowMeta deletedAt={daysAgo(15)} />);
    expect(
      screen.getByText("Eligible for deletion in 15 days"),
    ).toBeInTheDocument();
  });

  it("says 'day', not 'days', on the last day", () => {
    setRetention({ enabled: true, days: 30 });

    render(<DeletedRowMeta deletedAt={daysAgo(29)} />);

    expect(
      screen.getByText("Eligible for deletion in 1 day"),
    ).toBeInTheDocument();
  });

  it("drops the countdown once the row is past the window", () => {
    // The sweep can lag its own date (daily tick, batch ceiling, skipped
    // rows), so a past-due row states eligibility without a promise.
    setRetention({ enabled: true, days: 30 });

    render(<DeletedRowMeta deletedAt={daysAgo(400)} />);

    expect(screen.getByText("Eligible for deletion")).toBeInTheDocument();
    expect(screen.queryByText(/in .* days?/)).not.toBeInTheDocument();
  });

  it("renders nothing for a row that was never deleted", () => {
    setRetention({ enabled: true, days: 30 });

    const { container } = render(<DeletedRowMeta deletedAt={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
