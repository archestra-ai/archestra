import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ItemNameLinks } from "./item-name-links";

const items = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    href: `/skills/${index + 1}`,
    name: `skill-${index + 1}`,
  }));
const text = (count: number) =>
  render(<ItemNameLinks items={items(count)} />).container.textContent;

it("names up to three items in a sentence, and counts the rest", () => {
  expect(text(1)).toBe("skill-1");
  expect(text(2)).toBe("skill-1 and skill-2");
  expect(text(3)).toBe("skill-1, skill-2 and skill-3");
  expect(text(7)).toBe("skill-1, skill-2, skill-3 and 4 more");
});
