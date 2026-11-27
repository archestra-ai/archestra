"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useState,
} from "react";

const PageTitleContext = createContext<{
  pageTitle: string | null;
  setPageTitle: Dispatch<SetStateAction<string | null>>;
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

/**
 * Keeps the browser tab aligned with the page currently shown in the app.
 *
 * The title is handed to `DynamicHead`, the only writer of `document.title`:
 * a page that wrote the tab itself raced the app-name write and lost whenever
 * the appearance settings loaded after the page did. Pass `null` while the
 * page has no title of its own.
 */
export function usePageTitle(pageTitle: string | null) {
  const setPageTitle = useContext(PageTitleContext)?.setPageTitle;

  useEffect(() => {
    if (!pageTitle) return;
    setPageTitle?.(pageTitle);

    return () => {
      // Only give the tab back when it still shows this title: a page that
      // mounted in the meantime has already claimed it.
      setPageTitle?.((current) => (current === pageTitle ? null : current));
    };
  }, [pageTitle, setPageTitle]);
}
