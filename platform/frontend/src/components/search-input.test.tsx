import { render, screen } from "@testing-library/react";
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

  it("still applies the default sizing when no className is given", () => {
    render(<SearchInput placeholder="Search" />);

    const wrapper = screen.getByPlaceholderText("Search").parentElement;
    expect(wrapper).toHaveClass("relative");
    expect(wrapper).toHaveClass("sm:w-[320px]");
  });
});
