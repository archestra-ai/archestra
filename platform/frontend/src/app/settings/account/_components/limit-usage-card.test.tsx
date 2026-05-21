import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LimitUsageCard } from "./limit-usage-card";

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({
    data: {
      user: { id: "user-1", name: "Test User", email: "test@example.com" },
    },
  }),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganization: () => ({
    data: {
      id: "org-1",
      name: "Test Org",
      defaultUserLimitValue: 100,
    },
  }),
}));

vi.mock("@/lib/limits.query", () => ({
  useLimits: vi.fn(),
  useMyDefaultLimitUsage: vi.fn(),
}));

import { useLimits, useMyDefaultLimitUsage } from "@/lib/limits.query";

const mockedUseLimits = vi.mocked(useLimits);
const mockedUseMyDefaultLimitUsage = vi.mocked(useMyDefaultLimitUsage);

describe("LimitUsageCard", () => {
  it("renders loading state", () => {
    mockedUseLimits.mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: true,
    } as unknown as ReturnType<typeof useLimits>);

    mockedUseMyDefaultLimitUsage.mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: true,
    } as unknown as ReturnType<typeof useMyDefaultLimitUsage>);

    render(<LimitUsageCard />);
    expect(screen.getByText("Usage Limits")).toBeInTheDocument();
  });

  it("renders custom user limit when one exists", () => {
    mockedUseLimits.mockReturnValue({
      data: [
        {
          id: "limit-1",
          entityType: "user",
          entityId: "user-1",
          limitType: "token_cost",
          limitValue: 50,
          model: ["gpt-4o", "gpt-4o-mini"],
          modelUsage: [
            { model: "gpt-4o", tokensIn: 1000, tokensOut: 500, cost: 10 },
          ],
          cleanupInterval: "1w",
          lastCleanup: null,
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
      ],
      isPending: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useLimits>);

    mockedUseMyDefaultLimitUsage.mockReturnValue({
      data: null,
      isPending: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useMyDefaultLimitUsage>);

    render(<LimitUsageCard />);
    expect(screen.getByText("Custom Limit")).toBeInTheDocument();
    expect(screen.getByText(/\$10\.00 \/ \$50/)).toBeInTheDocument();
    expect(screen.getByText(/\$40\.00 remaining/)).toBeInTheDocument();
    expect(screen.getByText(/Models: gpt-4o, gpt-4o-mini/)).toBeInTheDocument();
  });

  it("renders default limit when no custom limit exists", () => {
    mockedUseLimits.mockReturnValue({
      data: [],
      isPending: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useLimits>);

    mockedUseMyDefaultLimitUsage.mockReturnValue({
      data: {
        limitValue: 100,
        cleanupInterval: "1w",
        models: null,
        usage: { cost: 25, tokensIn: 5000, tokensOut: 2000 },
      },
      isPending: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useMyDefaultLimitUsage>);

    render(<LimitUsageCard />);
    expect(screen.getByText("Default Limit")).toBeInTheDocument();
    expect(screen.getByText(/\$25\.00 \/ \$100/)).toBeInTheDocument();
    expect(screen.getByText(/\$75\.00 remaining/)).toBeInTheDocument();
    expect(screen.getByText(/Models: All models/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /This is the default organization limit\. Custom per-user limits can be configured by an administrator\./,
      ),
    ).toBeInTheDocument();
  });

  it("returns null when no limits exist", () => {
    mockedUseLimits.mockReturnValue({
      data: [],
      isPending: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useLimits>);

    mockedUseMyDefaultLimitUsage.mockReturnValue({
      data: null,
      isPending: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useMyDefaultLimitUsage>);

    const { container } = render(<LimitUsageCard />);
    expect(container.firstChild).toBeNull();
  });
});
