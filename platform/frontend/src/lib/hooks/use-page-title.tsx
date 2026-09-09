"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

const PageTitleContext = createContext<{
  pageTitle: string | null;
  setPageTitle: (title: string | null) => void;
} | null>(null);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [pageTitle, setPageTitle] = useState<string | null>(null);

  return (
    <PageTitleContext.Provider value={{ pageTitle, setPageTitle }}>
      {children}
    </PageTitleContext.Provider>
  );
}

export function useCurrentPageTitle() {
  return useContext(PageTitleContext)?.pageTitle ?? null;
}

/** Keeps the browser tab aligned with the page currently shown in the app. */
export function usePageTitle(pageTitle: string) {
  const setPageTitle = useContext(PageTitleContext)?.setPageTitle;

  useEffect(() => {
    setPageTitle?.(pageTitle);

    return () => {
      setPageTitle?.(null);
    };
  }, [pageTitle, setPageTitle]);
}
