import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";
import {
  ResourceScopeFilter,
  useScopeFilterParams,
} from "./resource-scope-filter";

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/agent.query", () => ({
  useLabelKeys: () => ({ data: [] }),
  useLabelValues: () => ({ data: [] }),
}));

const push = vi.fn();
function setQuery(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<
    typeof useRouter
  >);
  vi.mocked(usePathname).mockReturnValue("/agents");
  setQuery("");
});

describe("resource list origin filters", () => {
  it("ignores old visibility and owner parameters so bookmarked lists do not hide accessible resources", () => {
    setQuery(
      "scope=personal&teamIds=team-a&authorIds=user-a&excludeAuthorIds=user-b",
    );
    const { result } = renderHook(() => useScopeFilterParams());
    expect(result.current).toEqual({
      scope: undefined,
      teamIds: undefined,
      authorIds: undefined,
      excludeAuthorIds: undefined,
      excludeOtherPersonal: undefined,
      hasActiveScopeFilters: false,
    });
  });
  it("retains built-in origin filtering only on supported resource lists", () => {
    setQuery("scope=built_in");
    expect(
      renderHook(() => useScopeFilterParams({ includeBuiltIn: true })).result
        .current.scope,
    ).toBe("built_in");
    expect(
      renderHook(() => useScopeFilterParams()).result.current.scope,
    ).toBeUndefined();
  });
  it("selects built-in origin without retaining obsolete sharing filters or resetting search", async () => {
    setQuery("scope=team&teamIds=team-a&authorIds=user-a&page=4&name=example");
    render(<ResourceScopeFilter showBuiltIn />);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by origin" }),
    );
    expect(
      screen.queryByRole("option", { name: "Personal" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Team" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Organization" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Built-in" }));
    // Assert the parameters, not the order they happen to serialize in. What
    // matters is that the retired sharing filters are dropped, the page resets
    // and the search survives.
    expect(push).toHaveBeenCalledTimes(1);
    const [href, options] = push.mock.calls[0] as [string, unknown];
    const [path, query] = href.split("?");
    expect(path).toBe("/agents");
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      name: "example",
      scope: "built_in",
    });
    expect(options).toEqual({ scroll: false });
  });
  it("reads and writes the built-in origin through a namespaced query adapter", async () => {
    setQuery("scope=team&page=7&externalScope=built_in&externalPage=3");
    const paramNames = {
      scope: "externalScope",
      teamIds: "externalTeamIds",
      authorIds: "externalAuthorIds",
      excludeAuthorIds: "externalExcludeAuthorIds",
      page: "externalPage",
    };
    const { result } = renderHook(() =>
      useScopeFilterParams({
        includeBuiltIn: true,
        queryParamsAdapter: useQueryParamsAdapter({ paramNames }),
      }),
    );
    expect(result.current.scope).toBe("built_in");

    function ExternalOriginFilter() {
      return (
        <ResourceScopeFilter
          showBuiltIn
          queryParamsAdapter={useQueryParamsAdapter({ paramNames })}
        />
      );
    }
    render(<ExternalOriginFilter />);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by origin" }),
    );
    await user.click(screen.getByRole("option", { name: "All origins" }));
    // Only the namespaced keys change; the page's own scope and page survive.
    expect(push).toHaveBeenCalledWith("/agents?scope=team&page=7", {
      scroll: false,
    });
  });
});
