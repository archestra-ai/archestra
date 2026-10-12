"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef } from "react";

export type QueryParamUpdates = Record<string, string | null | undefined>;

export type QueryParamsReader = URLSearchParams;

interface QueryParamUpdateOptions {
  history?: "push" | "replace";
  /**
   * Change the URL in place, without re-rendering the server page. Use it
   * for client-side list filters whose server page ignores search params, so
   * a click does not wait on a server round trip.
   */
  shallow?: boolean;
}

export interface QueryParamsAdapter {
  pathname: string;
  searchParams: QueryParamsReader;
  updateQueryParams: (
    updates: QueryParamUpdates,
    options?: QueryParamUpdateOptions,
  ) => void;
}

export interface QueryParamsController {
  pathname: string;
  searchParams: URLSearchParams;
  updateQueryParams: QueryParamsAdapter["updateQueryParams"];
}

/** Owns the physical URL and its staged next value for every section on a page. */
export function useQueryParamsController(): QueryParamsController {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const currentQueryString = searchParams.toString();
  const observedQueryStringRef = useRef(currentQueryString);
  const stagedQueryStringRef = useRef(currentQueryString);

  if (observedQueryStringRef.current !== currentQueryString) {
    observedQueryStringRef.current = currentQueryString;
    stagedQueryStringRef.current = currentQueryString;
  }

  const updateQueryParams = useCallback(
    (updates: QueryParamUpdates, updateOptions?: QueryParamUpdateOptions) => {
      const nextParams = new URLSearchParams(stagedQueryStringRef.current);
      applyUpdates(nextParams, updates);

      const nextQueryString = nextParams.toString();
      stagedQueryStringRef.current = nextQueryString;
      const href = `${
        nextQueryString ? `${pathname}?${nextQueryString}` : pathname
      }${window.location.hash}`;
      const history = updateOptions?.history ?? "push";
      if (updateOptions?.shallow) {
        // Next.js syncs `useSearchParams` with native history updates.
        window.history[history === "push" ? "pushState" : "replaceState"](
          null,
          "",
          href,
        );
        return;
      }
      router[history](href, { scroll: false });
    },
    [pathname, router],
  );

  return {
    pathname,
    searchParams: useMemo(
      () => new URLSearchParams(currentQueryString),
      [currentQueryString],
    ),
    updateQueryParams,
  };
}

/**
 * Presents logical query-param names to one page section while storing them
 * under caller-selected URL keys. Reuse one adapter across a section's
 * controls and one controller across every section on the page.
 */
export function useQueryParamsAdapter(options?: {
  paramNames?: Readonly<Record<string, string>>;
  controller?: QueryParamsController;
}): QueryParamsAdapter {
  const localController = useQueryParamsController();
  const controller = options?.controller ?? localController;
  const searchParams = controller.searchParams;
  const pathname = controller.pathname;
  const paramNames = options?.paramNames;
  const currentQueryString = searchParams.toString();

  const resolveName = useCallback(
    (name: string) => paramNames?.[name] ?? name,
    [paramNames],
  );

  const adaptedSearchParams = useMemo<QueryParamsReader>(() => {
    const logicalParams = new URLSearchParams(currentQueryString);
    for (const [logicalName, urlName] of Object.entries(paramNames ?? {})) {
      if (logicalName === urlName) continue;
      const values = searchParams.getAll(urlName);
      logicalParams.delete(logicalName);
      for (const value of values) logicalParams.append(logicalName, value);
    }
    return logicalParams;
  }, [currentQueryString, paramNames, searchParams]);

  const updateQueryParams = useCallback(
    (updates: QueryParamUpdates, updateOptions?: QueryParamUpdateOptions) => {
      const mappedUpdates: QueryParamUpdates = {};
      for (const [logicalName, value] of Object.entries(updates)) {
        mappedUpdates[resolveName(logicalName)] = value;
      }
      controller.updateQueryParams(mappedUpdates, updateOptions);
    },
    [controller, resolveName],
  );

  return {
    pathname,
    searchParams: adaptedSearchParams,
    updateQueryParams,
  };
}

function applyUpdates(params: URLSearchParams, updates: QueryParamUpdates) {
  for (const [name, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      params.delete(name);
    } else {
      params.set(name, value);
    }
  }
}
