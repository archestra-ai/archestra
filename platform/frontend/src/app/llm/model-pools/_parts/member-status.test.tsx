import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberStatus } from "./member-status";

const NOW = new Date("2026-10-22T12:00:00Z");

function savedMember(overrides: {
  enabled?: boolean;
  benchedUntil?: string | null;
  benchReason?: string | null;
}) {
  return {
    id: "member",
    poolId: "pool",
    providerApiKeyId: "key",
    providerApiKeyName: "Key",
    priority: 1,
    weight: 1,
    enabled: true,
    createdAt: NOW.toISOString(),
    benchedUntil: null,
    benchReason: null,
    ...overrides,
  };
}

describe("MemberStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down a benched member and says why", () => {
    render(
      <MemberStatus
        enabled
        saved={savedMember({
          benchedUntil: new Date(NOW.getTime() + 12_000).toISOString(),
          benchReason: "rate_limited (429)",
        })}
      />,
    );
    expect(screen.getByText(/Benched 12 s/)).toHaveTextContent(
      "Benched 12 s · rate_limited (429)",
    );
  });

  it("calls a member healthy once its bench has passed", () => {
    render(
      <MemberStatus
        enabled
        saved={savedMember({
          benchedUntil: new Date(NOW.getTime() - 1_000).toISOString(),
          benchReason: "rate_limited (429)",
        })}
      />,
    );
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("shows a switched-off member as off and a new one as not saved", () => {
    const { rerender } = render(
      <MemberStatus enabled={false} saved={savedMember({})} />,
    );
    expect(screen.getByText("Off")).toBeInTheDocument();
    rerender(<MemberStatus enabled saved={null} />);
    expect(screen.getByText("Not saved yet")).toBeInTheDocument();
  });
});
