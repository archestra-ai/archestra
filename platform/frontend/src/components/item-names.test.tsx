import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ItemNames } from "./item-names";

const items = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${index + 1}`,
    name: `skill-${index + 1}`,
  }));
const text = (count: number) =>
  render(<ItemNames items={items(count)} />).container.textContent;

it("names up to three items in a sentence, and counts the rest", () => {
  expect(text(1)).toBe("skill-1");
  expect(text(2)).toBe("skill-1 and skill-2");
  expect(text(3)).toBe("skill-1, skill-2 and skill-3");
  expect(text(7)).toBe("skill-1, skill-2, skill-3 and 4 more");
});

it("links only the items that have a page to open", () => {
  render(
    <ItemNames
      items={[
        { id: "1", name: "linked", href: "/plugins/1" },
        { id: "2", name: "plain" },
      ]}
    />,
  );

  expect(screen.getByRole("link", { name: "linked" })).toHaveAttribute(
    "href",
    "/plugins/1",
  );
  expect(screen.queryByRole("link", { name: "plain" })).toBeNull();
});
