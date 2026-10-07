import { renderHook } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";
import { useScopeFilterParams } from "./resource-scope-filter";

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
      access: ["mine", "shared", "org"],
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
  it("reads a bookmarked built-in origin through a namespaced query adapter", () => {
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
  });
});
