"use client";

import { useLayoutEffect } from "react";

export function useValidationHistoryGuard(
  isDirty: boolean,
  onDiscard?: () => void,
) {
  useLayoutEffect(() => {
    if (!isDirty) return;
    const navigation = window.navigation;
    if (!navigation) return;
    const guard = (event: NavigateEvent) => {
      const destination = new URL(event.destination.url);
      if (
        event.navigationType !== "traverse" ||
        !event.cancelable ||
        !event.destination.sameDocument ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      )
        return;
      if (window.confirm("Discard unsaved validation changes?")) onDiscard?.();
      else event.preventDefault();
    };
    navigation.addEventListener("navigate", guard);
    return () => navigation.removeEventListener("navigate", guard);
  }, [isDirty, onDiscard]);
}
