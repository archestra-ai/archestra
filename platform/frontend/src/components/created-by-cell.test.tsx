import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CreatedByCell } from "@/components/created-by-cell";

describe("CreatedByCell", () => {
  test("names the creator, and carries the email for contacting them", () => {
    render(
      <CreatedByCell
        createdBy={{ id: "u1", name: "Nomi Ferreira", email: "nomi@x.invalid" }}
      />,
    );

    expect(screen.getByText("Nomi Ferreira")).toBeInTheDocument();
    // The email is the point — reachable without a hover.
    expect(screen.getByTitle("nomi@x.invalid")).toBeInTheDocument();
  });

  test("falls back to the email when the account has no display name", () => {
    render(
      <CreatedByCell
        createdBy={{ id: "u2", name: null, email: "runner@x.invalid" }}
      />,
    );

    expect(screen.getByText("runner@x.invalid")).toBeInTheDocument();
  });

  test("renders a dash when no creator was recorded", () => {
    render(<CreatedByCell createdBy={null} />);

    expect(screen.getByText("—")).toBeInTheDocument();
  });

  // Renders with no providers above it at all: a leaf that reached for the
  // session would need a QueryClientProvider in every page test that mounts it.
  test("needs no query provider", () => {
    expect(() =>
      render(
        <CreatedByCell createdBy={{ id: "u3", name: "A", email: null }} />,
      ),
    ).not.toThrow();
  });
});
