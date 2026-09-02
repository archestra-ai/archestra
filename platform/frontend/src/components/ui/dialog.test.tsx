import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

function renderDialog(
  onScroll?: (event: React.UIEvent<HTMLDivElement>) => void,
) {
  render(
    <Dialog open>
      <DialogContent onScroll={onScroll}>
        <DialogTitle>Edit connector</DialogTitle>
        <p>Body</p>
      </DialogContent>
    </Dialog>,
  );
  return screen.getByRole("dialog");
}

describe("DialogContent", () => {
  // DialogContent is deliberately a scrollport (`overflow-hidden`) so the
  // sticky footer resolves against it. That also makes it programmatically
  // scrollable with no scrollbar to undo it: a `scrollIntoView()` anywhere in
  // the body drags this element along, pushing the header off the top and
  // leaving the footer stranded above dead space, permanently. The body has
  // its own scroll container, so this one must stay at the origin.
  it("snaps back to the origin when something scrolls it", () => {
    const content = renderDialog();

    content.scrollTop = 159;
    content.scrollLeft = 40;
    fireEvent.scroll(content);

    expect(content.scrollTop).toBe(0);
    expect(content.scrollLeft).toBe(0);
  });

  it("still forwards the scroll event to a caller's handler", () => {
    const onScroll = vi.fn();
    const content = renderDialog(onScroll);

    content.scrollTop = 80;
    fireEvent.scroll(content);

    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(content.scrollTop).toBe(0);
  });
});
