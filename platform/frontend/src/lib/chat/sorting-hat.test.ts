import { describe, expect, it } from "vitest";
import { getSortingHatHouse } from "./sorting-hat";

describe("getSortingHatHouse", () => {
  it("reads Sorting Hat house from MCP metadata", () => {
    expect(
      getSortingHatHouse({
        _meta: {
          sortingHat: {
            house: "gryffindor",
          },
        },
      }),
    ).toBe("gryffindor");
  });

  it("reads snake_case Sorting Hat metadata", () => {
    expect(
      getSortingHatHouse({
        structuredContent: {
          sorting_hat: {
            house: "Slytherin",
          },
        },
      }),
    ).toBe("slytherin");
  });

  it("ignores unknown houses", () => {
    expect(getSortingHatHouse({ house: "ministry" })).toBeNull();
  });
});
