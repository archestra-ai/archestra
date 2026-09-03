import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "./search-input";

vi.mock("next/navigation");

const mockPush = vi.fn();

describe("SearchInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
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

  it("removes cursor pagination from the URL when cursor-backed search changes", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "cursor=opaque&page=3&pageSize=10",
      ) as unknown as ReturnType<typeof useSearchParams>,
    );
    render(
      <SearchInput
        placeholder="Search logs"
        paginationMode="cursor"
        debounceMs={0}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Search logs"), {
      target: { value: "tools" },
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/mcp/registry?search=tools", {
        scroll: false,
      });
    });
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

    it("stays busy while the list it filters fetches a search", () => {
      const { rerender } = render(
        <SearchInput placeholder="Search skills" value="not" isLoading />,
      );

      // There is a term in the box, so the caller's flag is covering the
      // request that term triggered — the half after the commit.
      expect(screen.getByPlaceholderText("Search skills")).toHaveAttribute(
        "aria-busy",
        "true",
      );

      rerender(
        <SearchInput
          placeholder="Search skills"
          value="not"
          isLoading={false}
        />,
      );

      expect(screen.getByPlaceholderText("Search skills")).toHaveAttribute(
        "aria-busy",
        "false",
      );
    });

    it("ignores a fetch that is not a search", () => {
      // Callers pass the list query's `isFetching`, which is also true for its
      // first load and for every background refetch. An empty box is not
      // searching, whatever the list behind it is doing — and claiming
      // otherwise suppresses the sidebar toggle's spinner, which is the
      // indicator that should be reporting that load.
      render(<SearchInput placeholder="Search skills" isLoading />);

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
