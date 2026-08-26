import { fireEvent, render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "./search-input";

vi.mock("next/navigation");

describe("SearchInput", () => {
  beforeEach(() => {
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/mcp/registry");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  /**
   * The magnifier is absolutely positioned, so it only stays inside the input
   * when its wrapper establishes a containing block. Callers pass `className`
   * for sizing; when that replaced the defaults instead of merging, the icon
   * escaped to the nearest positioned ancestor and rendered detached from the
   * field. Positioning must survive any caller override.
   */
  it("keeps the icon anchored to the input when a caller overrides className", () => {
    render(
      <SearchInput placeholder="Filter tools by name" className="max-w-xs" />,
    );

    const input = screen.getByPlaceholderText("Filter tools by name");
    const wrapper = input.parentElement;

    expect(wrapper).toHaveClass("relative");
    expect(wrapper).toHaveClass("max-w-xs");
    // The icon is a sibling of the input, inside that positioned wrapper.
    expect(wrapper?.querySelector("svg")).toBeInTheDocument();
  });

  it("reserves room for the icon even when a caller overrides inputClassName", () => {
    render(
      <SearchInput
        placeholder="Search knowledge bases"
        inputClassName="w-full bg-background/50"
      />,
    );

    expect(screen.getByPlaceholderText("Search knowledge bases")).toHaveClass(
      "pl-9",
    );
  });
  /**
   * Typing used to produce no feedback at all: the debounce, the commit and the
   * request the commit triggers all passed under a static magnifier, which is
   * what made a search feel like it had not registered.
   */
  describe("search in flight", () => {
    it("marks itself busy from the keystroke, before anything is requested", () => {
      render(<SearchInput placeholder="Search skills" />);

      const input = screen.getByPlaceholderText("Search skills");
      expect(input).toHaveAttribute("aria-busy", "false");

      fireEvent.change(input, { target: { value: "not" } });

      expect(input).toHaveAttribute("aria-busy", "true");
    });

    it("stays busy while the list it filters is fetching", () => {
      const { rerender } = render(
        <SearchInput placeholder="Search skills" isLoading />,
      );

      // Nothing has been typed in this render, so only the caller's flag can
      // be holding the indicator on — the half that covers the request.
      expect(screen.getByPlaceholderText("Search skills")).toHaveAttribute(
        "aria-busy",
        "true",
      );

      rerender(<SearchInput placeholder="Search skills" isLoading={false} />);

      expect(screen.getByPlaceholderText("Search skills")).toHaveAttribute(
        "aria-busy",
        "false",
      );
    });

    /**
     * The spinner is the only animation in the field, and a search box is at
     * most one debounce away from spinning. It has to stop for readers who ask
     * motion to stop (WCAG 2.3.3).
     */
    it("keeps the spinner still under prefers-reduced-motion", () => {
      const { container } = render(<SearchInput placeholder="Search skills" />);

      expect(
        container.querySelector(".animate-spin.motion-reduce\\:animate-none"),
      ).toBeInTheDocument();
    });
  });
});
