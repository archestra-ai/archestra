"use client";

import { usePathname } from "next/navigation";
import * as React from "react";

type NavigationStatusContextValue = {
  isNavigating: boolean;
};

const NavigationStatusContext =
  React.createContext<NavigationStatusContextValue>({
    isNavigating: false,
  });

export function useNavigationStatus() {
  return React.useContext(NavigationStatusContext);
}

// Safety reset: if pathname never changes (cancelled nav, error), drop the
// loading flag so the spinner doesn't get stuck.
const SAFETY_TIMEOUT_MS = 5000;

export function NavigationStatusProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [isNavigating, setIsNavigating] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPathnameRef = React.useRef(pathname);

  const clearSafetyTimeout = React.useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Pathname change = navigation completed. Reset the flag.
  React.useEffect(() => {
    if (prevPathnameRef.current === pathname) return;
    prevPathnameRef.current = pathname;
    setIsNavigating(false);
    clearSafetyTimeout();
  }, [pathname, clearSafetyTimeout]);

  // Detect navigation start via document-level click capture on internal links.
  React.useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;

      const target = event.target as Element | null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "" && anchor.target !== "_self")
        return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      let url: URL;
      try {
        url = new URL(anchor.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }

      setIsNavigating(true);
      clearSafetyTimeout();
      timeoutRef.current = setTimeout(() => {
        setIsNavigating(false);
        timeoutRef.current = null;
      }, SAFETY_TIMEOUT_MS);
    };

    document.addEventListener("click", handler, true);
    return () => {
      document.removeEventListener("click", handler, true);
    };
  }, [clearSafetyTimeout]);

  React.useEffect(() => () => clearSafetyTimeout(), [clearSafetyTimeout]);

  const value = React.useMemo(() => ({ isNavigating }), [isNavigating]);

  return (
    <NavigationStatusContext.Provider value={value}>
      {children}
    </NavigationStatusContext.Provider>
  );
}
