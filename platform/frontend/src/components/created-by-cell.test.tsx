import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { CreatedByCell } from "@/components/created-by-cell";

vi.mock("@/lib/auth/auth.query");

import { useSession } from "@/lib/auth/auth.query";

function asViewer(id: string | undefined) {
  vi.mocked(useSession).mockReturnValue({
    data: id ? { user: { id } } : null,
  } as ReturnType<typeof useSession>);
}

describe("CreatedByCell", () => {
  test("names the creator, and carries the email for contacting them", () => {
    asViewer("someone-else");
    render(
      <CreatedByCell
        createdBy={{ id: "u1", name: "Nomi Ferreira", email: "nomi@x.invalid" }}
      />,
    );

    expect(screen.getByText("Nomi Ferreira")).toBeInTheDocument();
    // The email is the point of the column — reachable without a hover.
    expect(screen.getByTitle("nomi@x.invalid")).toBeInTheDocument();
  });

  test("says 'You' for the viewer's own row rather than their own name", () => {
    asViewer("u1");
    render(
      <CreatedByCell
        createdBy={{ id: "u1", name: "Nomi Ferreira", email: "nomi@x.invalid" }}
      />,
    );

    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByText("Nomi Ferreira")).not.toBeInTheDocument();
  });

  test("falls back to the email when the account has no display name", () => {
    asViewer("someone-else");
    render(
      <CreatedByCell
        createdBy={{ id: "u2", name: null, email: "runner@x.invalid" }}
      />,
    );

    expect(screen.getByText("runner@x.invalid")).toBeInTheDocument();
  });

  test("renders a dash when no creator was recorded", () => {
    asViewer("u1");
    render(<CreatedByCell createdBy={null} />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
