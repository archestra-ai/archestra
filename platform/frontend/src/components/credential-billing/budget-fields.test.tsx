import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useLimits } from "@/lib/limits.query";
import { useMyTeams, useTeams } from "@/lib/teams/team.query";
import { BudgetFields, type SpendCapValue } from "./budget-fields";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/limits.query", () => ({ useLimits: vi.fn() }));
vi.mock("@/lib/teams/team.query", () => ({
  useTeams: vi.fn(),
  useMyTeams: vi.fn(),
}));

// Radix Popper / floating-ui needs ResizeObserver as a real constructor
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const TEAM = {
  id: "team-support",
  name: "Support",
  memberCount: 3,
  myRole: "admin",
};

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "u-self" } },
  } as unknown as ReturnType<typeof useSession>);
  vi.mocked(useTeams).mockReturnValue({
    data: [TEAM],
  } as unknown as ReturnType<typeof useTeams>);
  vi.mocked(useMyTeams).mockReturnValue({
    data: [TEAM],
  } as unknown as ReturnType<typeof useMyTeams>);
  // $300 a month, $40 of it used.
  vi.mocked(useLimits).mockReturnValue({
    data: [
      {
        id: "limit-1",
        entityType: "team",
        entityId: TEAM.id,
        limitType: "token_cost",
        model: [],
        limitValue: 300,
        cleanupInterval: "calendar_month",
        modelUsage: [{ model: "claude", cost: 40 }],
      },
    ],
  } as unknown as ReturnType<typeof useLimits>);
});

describe("BudgetFields team usage", () => {
  it("fits a cap on the team's period inside the team's bar", () => {
    renderBudget({ limitValue: 100, cleanupInterval: "calendar_month" });

    expect(legend("This key, at most")).toHaveTextContent("$100");
    expect(legend("Team has left")).toHaveTextContent("$260");
  });

  it("does not set a cap on another period against the team's month", () => {
    renderBudget({ limitValue: 500, cleanupInterval: "1w" });

    expect(screen.queryByText("This key, at most")).not.toBeInTheDocument();
    expect(legend("Team has left")).toHaveTextContent("$260");
    expect(
      screen.getByText(/\$500 per 7 days.*\$300\/month.*different periods/),
    ).toBeVisible();
  });

  it("shows what the key can really spend when the team has less left than the cap", () => {
    renderBudget({ limitValue: 500, cleanupInterval: "calendar_month" });

    expect(legend("This key, at most")).toHaveTextContent("$260");
    expect(screen.getByText(/the team limit stops it first/)).toBeVisible();
  });
});

describe("BudgetFields billing team choices", () => {
  it("offers a non-cost-manager only the teams they administer, with member counts", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    // Rows as the server returns them for ?mine=true&includeRelations=false:
    // the caller's role and a count, never member arrays.
    vi.mocked(useMyTeams).mockReturnValue({
      data: [
        { id: "t-admin", name: "Platform", memberCount: 4, myRole: "admin" },
        { id: "t-member", name: "Research", memberCount: 9, myRole: "member" },
      ],
    } as unknown as ReturnType<typeof useMyTeams>);
    const user = userEvent.setup();
    render(
      <BudgetFields
        subject="key"
        idPrefix="test"
        billingTeamId={null}
        onBillingTeamIdChange={vi.fn()}
        spendCap={null}
        onSpendCapChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("combobox", { name: "Who pays for this key?" }),
    );

    expect(screen.getByRole("option", { name: /^Platform/ })).toHaveTextContent(
      "4 members",
    );
    expect(screen.queryByRole("option", { name: /^Research/ })).toBeNull();
  });
});

function legend(label: string) {
  // biome-ignore lint/style/noNonNullAssertion: the legend item must exist
  return screen.getByText(label).closest("div")!;
}

function renderBudget(spendCap: SpendCapValue) {
  render(
    <BudgetFields
      subject="key"
      idPrefix="test"
      billingTeamId={TEAM.id}
      onBillingTeamIdChange={vi.fn()}
      spendCap={spendCap}
      onSpendCapChange={vi.fn()}
    />,
  );
}
