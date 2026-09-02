import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CreatedByCell, createdByFact } from "@/components/created-by-cell";

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

  // It used to render an em dash under a tooltip listing the three reasons a
  // creator can be missing, which put "Created by —" in a page header and read
  // as a name that had failed to load.
  test("renders nothing when no creator was recorded", () => {
    const { container } = render(<CreatedByCell createdBy={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  test("renders nothing when the creator is not loaded yet", () => {
    const { container } = render(<CreatedByCell createdBy={undefined} />);

    expect(container).toBeEmptyDOMElement();
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

describe("createdByFact", () => {
  test("states the creator under a Created by label", () => {
    const fact = createdByFact({
      id: "u1",
      name: "Nomi Ferreira",
      email: "nomi@x.invalid",
    });

    expect(fact?.label).toBe("Created by");
  });

  // Absent, not present-and-empty: the label is the half that made "Created by
  // —" read as a name that had failed to load.
  test("produces no fact at all when no creator was recorded", () => {
    expect(createdByFact(null)).toBeNull();
  });
});
