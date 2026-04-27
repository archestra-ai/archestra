import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";
import { Dialog, DialogContent } from "./dialog";
import { Input } from "./input";
import { InputGroup } from "./input-group";
import { Textarea } from "./textarea";

/**
 * Regression tests for UI improvements (issue #4076).
 *
 * Each test asserts that the rendered className includes or excludes
 * specific Tailwind utilities so future refactors don't reintroduce
 * the visual bugs.
 */

describe("Button alignment (#4076)", () => {
  it("default size should not include py-2 (vertical centering handled by h-9 + flexbox)", () => {
    const classes = buttonVariants({ size: "default" });
    // py-2 causes off-center text when combined with h-9
    expect(classes).not.toContain("py-2");
  });

  it("renders with items-center for proper vertical centering", () => {
    const classes = buttonVariants({ size: "default" });
    expect(classes).toContain("items-center");
  });
});

describe("Shadow removal (#4076)", () => {
  it("outline button variant should not have shadow-xs", () => {
    const classes = buttonVariants({ variant: "outline" });
    expect(classes).not.toContain("shadow-xs");
  });

  it("Input should not have shadow-xs", () => {
    const { container } = render(<Input />);
    const input = container.querySelector("[data-slot='input']");
    expect(input?.className).not.toContain("shadow-xs");
  });

  it("InputGroup should not have shadow-xs", () => {
    const { container } = render(<InputGroup />);
    const group = container.querySelector("[data-slot='input-group']");
    expect(group?.className).not.toContain("shadow-xs");
  });

  it("Textarea should not have shadow-xs", () => {
    const { container } = render(<Textarea />);
    const textarea = container.querySelector("[data-slot='textarea']");
    expect(textarea?.className).not.toContain("shadow-xs");
  });
});

describe("Dialog modal scrolling (#4076)", () => {
  it("DialogContent should include max-h and overflow-y-auto for tall content", () => {
    const { container } = render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <div>content</div>
        </DialogContent>
      </Dialog>,
    );
    const content = container.ownerDocument.querySelector(
      "[data-slot='dialog-content']",
    );
    // The dialog should constrain its height and allow scrolling
    expect(content?.className).toContain("max-h-[90vh]");
    expect(content?.className).toContain("overflow-y-auto");
  });
});
