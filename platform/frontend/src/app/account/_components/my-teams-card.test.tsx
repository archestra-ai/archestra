import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMyTeams } from "@/lib/teams/team.query";
import { MyTeamsCard } from "./my-teams-card";

vi.mock("@/lib/teams/team.query");

function mockMyTeams(overrides: Partial<ReturnType<typeof useMyTeams>>) {
  vi.mocked(useMyTeams).mockReturnValue({
    data: [],
    isPending: false,
    isLoadingError: false,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useMyTeams>);
}

describe("MyTeamsCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists each team with its role and member count", () => {
    mockMyTeams({
      data: [
        {
          id: "t1",
          name: "Platform",
          description: "Core platform team",
          myRole: "admin",
          members: [{ userId: "u1" }, { userId: "u2" }],
        },
        {
          id: "t2",
          name: "Design",
          myRole: "member",
          members: [{ userId: "u1" }],
        },
      ] as unknown as ReturnType<typeof useMyTeams>["data"],
    });

    render(<MyTeamsCard />);

    const platform = screen.getByText("Platform").closest("li");
    expect(platform).toHaveTextContent("admin");
    expect(platform).toHaveTextContent("2 members");
    expect(platform).toHaveTextContent("Core platform team");

    const design = screen.getByText("Design").closest("li");
    expect(design).toHaveTextContent("member");
    expect(design).toHaveTextContent("1 member");
  });

  it("shows an empty state when the user has no teams", () => {
    mockMyTeams({ data: [] });

    render(<MyTeamsCard />);

    expect(screen.getByText("You're not in any teams yet")).toBeInTheDocument();
  });

  it("offers a retry when the teams fail to load", async () => {
    const refetch = vi.fn();
    mockMyTeams({ data: undefined, isLoadingError: true, refetch });

    render(<MyTeamsCard />);

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});
