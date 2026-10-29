import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberCooldown, PoolHealth } from "./member-status";

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
    provider: "zhipuai" as const,
    modelId: "glm-5",
    priority: 1,
    weight: 1,
    enabled: true,
    createdAt: NOW.toISOString(),
    benchedUntil: null,
    benchReason: null,
    ...overrides,
  };
}

describe("MemberCooldown and PoolHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down a member that is cooling down", () => {
    render(
      <MemberCooldown
        saved={savedMember({
          benchedUntil: new Date(NOW.getTime() + 12_000).toISOString(),
          benchReason: "rate_limited (429)",
        })}
      />,
    );
    expect(screen.getByText("Cooling down · 12 s")).toBeInTheDocument();
  });

  it("shows nothing once the cooldown has passed, or for a member that is off", () => {
    const { container, rerender } = render(
      <MemberCooldown
        saved={savedMember({
          benchedUntil: new Date(NOW.getTime() - 1_000).toISOString(),
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <MemberCooldown
        saved={savedMember({
          enabled: false,
          benchedUntil: new Date(NOW.getTime() + 12_000).toISOString(),
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("sums up a pool by its members cooling down", () => {
    const pool = {
      id: "pool",
      organizationId: "org",
      name: "glm-5",
      streamTimeoutSeconds: null,
      timeoutSeconds: null,
      cooldownSeconds: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      virtualApiKeyIds: [],
      members: [
        savedMember({}),
        savedMember({
          benchedUntil: new Date(NOW.getTime() + 30_000).toISOString(),
        }),
      ],
    };
    const { rerender } = render(<PoolHealth pool={pool} />);
    expect(screen.getByText("1 cooling down, 30 s")).toBeInTheDocument();
    rerender(<PoolHealth pool={{ ...pool, members: [savedMember({})] }} />);
    expect(screen.getByText("All healthy")).toBeInTheDocument();
  });
});
