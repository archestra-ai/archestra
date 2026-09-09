import { render, screen } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useActiveMemberRole } from "@/lib/organization.query";
import { useMyTeams } from "@/lib/teams/team.query";
import AccountProfilePage from "./page";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/auth/account.query", () => ({
  useUpdateAccountNameMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

describe("AccountProfilePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: {
        user: { id: "u1", name: "Ada", email: "ada@example.com" },
        session: { activeOrganizationId: "org-1" },
      },
      isPending: false,
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: "member",
      isPending: false,
    } as unknown as ReturnType<typeof useActiveMemberRole>);
    vi.mocked(useMyTeams).mockReturnValue({
      data: [
        {
          id: "t1",
          name: "Platform",
          myRole: "member",
          members: [{ userId: "u1" }, { userId: "u2" }],
        },
      ],
      isPending: false,
      isLoadingError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useMyTeams>);
  });

  it("shows the My Teams list on the profile page, below the profile fields", () => {
    render(<AccountProfilePage />);

    // The profile fields and the My Teams section share the one page — there is
    // no separate route to visit.
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");

    const teamsHeading = screen.getByRole("heading", { name: "My Teams" });
    expect(teamsHeading).toBeInTheDocument();
    // My Teams follows Profile in document order.
    const profileHeading = screen.getByRole("heading", { name: "Profile" });
    expect(
      profileHeading.compareDocumentPosition(teamsHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(screen.getByText("Platform")).toBeInTheDocument();
    expect(screen.getByText("Platform").closest("li")).toHaveTextContent(
      "2 members",
    );
  });
});
