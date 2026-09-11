"use client";

import { act, renderHook } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataTableQueryParams } from "./use-data-table-query-params";
import {
  useQueryParamsAdapter,
  useQueryParamsController,
} from "./use-query-params-adapter";

const mockPush = vi.fn();

vi.mock("next/navigation");

const externalAgentParamNames = {
  name: "externalName",
  scope: "externalScope",
  teamIds: "externalTeamIds",
  authorIds: "externalAuthorIds",
  excludeAuthorIds: "externalExcludeAuthorIds",
  sortBy: "externalSortBy",
  sortDirection: "externalSortDirection",
  page: "externalPage",
  pageSize: "externalPageSize",
} as const;

describe("useQueryParamsAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/agents");
    vi.mocked(usePathname).mockReturnValue("/agents");
    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
      replace: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "name=regular-agent&page=4&externalName=remote-agent&externalPage=3&externalPageSize=25",
      ) as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it("presents mapped keys as logical table params", () => {
    const { result } = renderHook(() => {
      const queryParamsAdapter = useQueryParamsAdapter({
        paramNames: externalAgentParamNames,
      });
      return useDataTableQueryParams({ queryParamsAdapter });
    });

    expect(result.current.searchParams.get("name")).toBe("remote-agent");
    expect(result.current.pageIndex).toBe(2);
    expect(result.current.pageSize).toBe(25);
    expect(result.current.offset).toBe(50);
  });

  it("stages rapid patches against the latest full query string", () => {
    const { result } = renderHook(() =>
      useQueryParamsAdapter({ paramNames: externalAgentParamNames }),
    );

    act(() => {
      result.current.updateQueryParams({ name: "updated-remote", page: "1" });
      result.current.updateQueryParams({ scope: "team", teamIds: "team-1" });
    });

    expect(mockPush).toHaveBeenNthCalledWith(
      1,
      "/agents?name=regular-agent&page=4&externalName=updated-remote&externalPage=1&externalPageSize=25",
      { scroll: false },
    );
    expect(mockPush).toHaveBeenNthCalledWith(
      2,
      "/agents?name=regular-agent&page=4&externalName=updated-remote&externalPage=1&externalPageSize=25&externalScope=team&externalTeamIds=team-1",
      { scroll: false },
    );
  });

  it.each([
    "regular-first",
    "external-first",
  ] as const)("preserves both namespaces when %s adapters patch back-to-back", (order) => {
    const { result } = renderHook(() => {
      const controller = useQueryParamsController();
      return {
        regular: useQueryParamsAdapter({ controller }),
        external: useQueryParamsAdapter({
          controller,
          paramNames: externalAgentParamNames,
        }),
      };
    });

    act(() => {
      if (order === "regular-first") {
        result.current.regular.updateQueryParams({ name: "regular-updated" });
        result.current.external.updateQueryParams({
          name: "external-updated",
        });
      } else {
        result.current.external.updateQueryParams({
          name: "external-updated",
        });
        result.current.regular.updateQueryParams({ name: "regular-updated" });
      }
    });

    expect(mockPush).toHaveBeenCalledTimes(2);
    const lastHref = mockPush.mock.calls.at(-1)?.[0];
    if (typeof lastHref !== "string") throw new Error("missing pushed URL");
    const pushedParams = new URL(lastHref, "http://localhost").searchParams;
    expect(pushedParams.get("name")).toBe("regular-updated");
    expect(pushedParams.get("externalName")).toBe("external-updated");
  });

  it("preserves the external-agents fragment while updating its filters", () => {
    window.history.replaceState({}, "", "/agents#external-agents");
    const { result } = renderHook(() =>
      useQueryParamsAdapter({ paramNames: externalAgentParamNames }),
    );

    act(() => result.current.updateQueryParams({ scope: "team" }));

    expect(mockPush).toHaveBeenCalledWith(
      "/agents?name=regular-agent&page=4&externalName=remote-agent&externalPage=3&externalPageSize=25&externalScope=team#external-agents",
      { scroll: false },
    );
  });
});
