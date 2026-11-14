import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AdvancedSection } from "./advanced-section";

function mockScrollIntoView() {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

describe("AdvancedSection scroll on expansion", () => {
  for (const reducedMotion of [false, true]) {
    test(`reveals newly opened content with reduced motion ${reducedMotion}`, async () => {
      const scrollIntoView = mockScrollIntoView();
      vi.stubGlobal(
        "matchMedia",
        vi.fn().mockReturnValue({ matches: reducedMotion }),
      );
      render(
        <AdvancedSection scrollIntoViewOnOpen>
          <input aria-label="Optional field" />
        </AdvancedSection>,
      );
      expect(scrollIntoView).not.toHaveBeenCalled();
      const trigger = screen.getByRole("button", { name: "Advanced" });
      fireEvent.click(trigger);
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
          behavior: reducedMotion ? "instant" : "smooth",
          block: "nearest",
        }),
      );
      expect(scrollIntoView.mock.instances[0]).toContainElement(
        screen.getByRole("textbox"),
      );
      fireEvent.click(trigger);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      fireEvent.click(trigger);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    });
  }

  test("does not scroll other sections or initially expanded content", () => {
    const scrollIntoView = mockScrollIntoView();
    const { rerender } = render(<AdvancedSection>Optional</AdvancedSection>);
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(
      <AdvancedSection key="initial" defaultOpen scrollIntoViewOnOpen>
        Optional
      </AdvancedSection>,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
