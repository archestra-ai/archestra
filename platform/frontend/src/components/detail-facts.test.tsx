import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { DetailFacts } from "@/components/detail-facts";

describe("DetailFacts", () => {
  test("states each fact as a label over its value", () => {
    render(
      <DetailFacts
        facts={[
          { label: "Source", value: "GitHub" },
          { label: "Version", value: "v3" },
        ]}
      />,
    );

    expect(screen.getByText("Source")).toBeVisible();
    expect(screen.getByText("GitHub")).toBeVisible();
    expect(screen.getByText("Version")).toBeVisible();
  });

  // A caller lists every fact it can state and lets the ones with nothing to
  // say fall out, so a label never stands over an empty value.
  test("drops the facts a caller had nothing to state", () => {
    render(
      <DetailFacts
        facts={[{ label: "Source", value: "GitHub" }, null, undefined]}
      />,
    );

    expect(screen.getByText("Source")).toBeVisible();
    expect(screen.getAllByRole("term")).toHaveLength(1);
  });

  test("renders nothing when no fact has anything to state", () => {
    const { container } = render(<DetailFacts facts={[null, undefined]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
