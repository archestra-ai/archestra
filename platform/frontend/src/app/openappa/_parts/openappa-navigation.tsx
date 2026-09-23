"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";

export const OPENAPPA_TABS = [
  { value: "overview", label: "Overview" },
  { value: "tools", label: "Tools" },
  { value: "batteries", label: "Batteries" },
  { value: "policy", label: "Policy" },
] as const;
export type OpenappaTab = (typeof OPENAPPA_TABS)[number]["value"];

/** The URL of a tab: the overview is the page itself, every other tab a `tab` parameter. */
export function openappaTabHref(tab: OpenappaTab): string {
  return tab === "overview" ? "/openappa" : `/openappa?tab=${tab}`;
}

/**
 * Element ids the Batteries tab gives its entries, so a link from another
 * tab or the server dialog can land on one through `goToTab`'s anchor.
 */
export const BATTERIES_ANCHORS = {
  included: (name: string) => `battery-${name}`,
  available: (name: string) => `available-battery-${name}`,
  custom: "custom-batteries",
} as const;

type OpenappaNavigation = {
  tab: OpenappaTab;
  /** A line of the policy text to select once the editor shows; null when none is asked for. */
  line: number | null;
  /** The catalog entry whose server dialog is open; null when closed. */
  server: string | null;
  /** The catalog entry the Tools tab was opened filtered to; null when it was not. */
  toolsServer: string | null;
  /** Land on a tab; with an anchor, on that element of it. Closes the dialog and drops a pending line. */
  goToTab: (tab: OpenappaTab, options?: { anchor?: string }) => void;
  /** Open the Policy tab with this line of the text selected in the editor. */
  goToLine: (line: number) => void;
  /** Open the Tools tab with its Server facet set to this catalog entry. */
  goToTools: (catalogId: string) => void;
  openServer: (catalogId: string) => void;
  closeServer: () => void;
  /** The editor calls this once it has selected the line, so the next link to the same line lands again. */
  clearLine: () => void;
};

const NavigationContext = createContext<OpenappaNavigation | null>(null);

/**
 * The page's own state lives in the URL, so a tab, a selected line and an open
 * server dialog are all deep-linkable: `tab`, `line`, `server` and
 * `toolsServer`. Every line link, Details button and server chip goes through
 * this context; nothing else touches those parameters. The tables' own paging
 * and filters keep their own parameters beside these.
 */
export function OpenappaNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const query = searchParams.toString();

  const update = useCallback(
    (
      updates: Record<string, string | null>,
      options?: { history?: "push" | "replace"; anchor?: string },
    ) => {
      const next = new URLSearchParams(query);
      for (const [name, value] of Object.entries(updates)) {
        if (value === null) next.delete(name);
        else next.set(name, value);
      }
      const search = next.toString();
      const href = `${pathname}${search ? `?${search}` : ""}${
        options?.anchor ? `#${options.anchor}` : ""
      }`;
      // A plain navigation keeps the scroll position; one aimed at an anchor
      // lets the router bring that element into view.
      router[options?.history ?? "push"](href, {
        scroll: options?.anchor !== undefined,
      });
    },
    [pathname, query, router],
  );

  const value = useMemo<OpenappaNavigation>(() => {
    const params = new URLSearchParams(query);
    const rawTab = params.get("tab");
    const tab = isTab(rawTab) ? rawTab : "overview";
    const rawLine = Number.parseInt(params.get("line") ?? "", 10);
    return {
      tab,
      line: Number.isInteger(rawLine) && rawLine >= 1 ? rawLine : null,
      server: params.get("server"),
      toolsServer: params.get("toolsServer"),
      goToTab: (next, options) =>
        update(
          {
            tab: next === "overview" ? null : next,
            server: null,
            line: null,
            toolsServer: null,
          },
          { anchor: options?.anchor },
        ),
      goToLine: (line) =>
        update({ tab: "policy", line: String(line), server: null }),
      goToTools: (catalogId) =>
        update({
          tab: "tools",
          toolsServer: catalogId,
          server: null,
          line: null,
        }),
      openServer: (catalogId) => update({ server: catalogId }),
      closeServer: () => update({ server: null }, { history: "replace" }),
      clearLine: () => update({ line: null }, { history: "replace" }),
    };
  }, [query, update]);

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useOpenappaNavigation(): OpenappaNavigation {
  const navigation = useContext(NavigationContext);
  if (!navigation)
    throw new Error(
      "useOpenappaNavigation must be used inside OpenappaNavigationProvider",
    );
  return navigation;
}

function isTab(value: string | null): value is OpenappaTab {
  return OPENAPPA_TABS.some((tab) => tab.value === value);
}
