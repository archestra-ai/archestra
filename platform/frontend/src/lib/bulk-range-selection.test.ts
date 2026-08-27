import { describe, expect, it } from "vitest";
import { BulkRangeSelectionController } from "./bulk-range-selection";

const ids = ["one", "two", "three", "four", "five"];

describe("BulkRangeSelectionController", () => {
  it("uses the clicked endpoint state and advances the anchor", () => {
    const controller = new BulkRangeSelectionController();
    let selection = controller.update({
      current: {},
      orderedIds: ids,
      targetId: "three",
      range: false,
    });
    selection = controller.update({
      current: selection,
      orderedIds: ids,
      targetId: "one",
      range: true,
    });
    selection = controller.update({
      current: selection,
      orderedIds: ids,
      targetId: "two",
      range: true,
    });

    expect(selection).toEqual({ three: true });
  });

  it("uses the first range click as the next anchor", () => {
    const controller = new BulkRangeSelectionController();
    let selection = controller.update({
      current: {},
      orderedIds: ids,
      targetId: "three",
      range: true,
    });
    selection = controller.update({
      current: selection,
      orderedIds: ids,
      targetId: "one",
      range: true,
    });

    expect(selection).toEqual({ one: true, two: true, three: true });
  });

  it("only mutates ids supplied in the visible selectable order", () => {
    const controller = new BulkRangeSelectionController();
    let selection = controller.update({
      current: {},
      orderedIds: ["one", "two", "four", "five"],
      targetId: "two",
      range: false,
    });
    selection = controller.update({
      current: selection,
      orderedIds: ["one", "two", "four", "five"],
      targetId: "four",
      range: true,
    });

    expect(selection).toEqual({ two: true, four: true });
  });
});
