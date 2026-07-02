"use client";

import { usePathname } from "next/navigation";
import React from "react";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import {
  useCompleteOnboardingStep,
  useOnboardingSteps,
} from "./onboarding.query";
import {
  hasPendingOnboarding,
  isMenuStepDone,
  isSidebarTabDone,
  menuStepForUrl,
  menuStepsForPath,
  ONBOARDING_MENU_STEPS,
  type SidebarTab,
} from "./onboarding-steps";

interface OnboardingContextValue {
  /** Whether the sidebar item at `url` should show a red dot. */
  isMenuDotVisible: (url: string) => boolean;
  /** Whether a sidebar tab's rollup dot should show (all its items done?). */
  isTabDotVisible: (tab: SidebarTab) => boolean;
  /** Whether any dotted item is still pending (for the collapsed-sidebar dot). */
  hasPendingItems: boolean;
  /**
   * Report which onboarding step keys are actually visible to this user. The
   * sidebar (which filters items by RBAC + feature flags) is the source of
   * truth, so a step the user can't see never counts toward the tab rollup or
   * the collapsed-toggle nudge.
   */
  registerVisibleSteps: (keys: string[]) => void;
}

const NOOP_CONTEXT: OnboardingContextValue = {
  isMenuDotVisible: () => false,
  isTabDotVisible: () => false,
  hasPendingItems: false,
  registerVisibleSteps: () => {},
};

const OnboardingContext = React.createContext<OnboardingContextValue | null>(
  null,
);

export function OnboardingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const isAuthenticated = useIsAuthenticated();
  const pathname = usePathname();
  const { data: done } = useOnboardingSteps({ enabled: isAuthenticated });
  const { mutate: completeStep } = useCompleteOnboardingStep();
  // Guards against firing the same completion twice before the cache settles.
  const firedRef = React.useRef<Set<string>>(new Set());
  // Step keys the sidebar actually renders (RBAC + feature-flag filtered).
  // Empty until the sidebar registers, so parent dots don't count steps the
  // user can't reach.
  const [visibleStepKeys, setVisibleStepKeys] = React.useState<
    ReadonlySet<string>
  >(() => new Set());

  const registerVisibleSteps = React.useCallback((keys: string[]) => {
    setVisibleStepKeys((prev) => {
      if (prev.size === keys.length && keys.every((key) => prev.has(key))) {
        return prev;
      }
      return new Set(keys);
    });
  }, []);

  const markComplete = React.useCallback(
    (key: string) => {
      if (firedRef.current.has(key)) return;
      firedRef.current.add(key);
      // Drop the guard if the write fails so a later navigation can retry.
      completeStep(key, {
        onError: () => firedRef.current.delete(key),
      });
    },
    [completeStep],
  );

  // Visiting a menu item clears its dot.
  React.useEffect(() => {
    if (!isAuthenticated || !done) return;
    for (const step of menuStepsForPath(pathname)) {
      if (!done.has(step.key)) markComplete(step.key);
    }
  }, [pathname, isAuthenticated, done, markComplete]);

  const value = React.useMemo<OnboardingContextValue>(
    () => ({
      // Don't flash dots before progress has loaded.
      isMenuDotVisible: (url) => {
        if (!done) return false;
        const step = menuStepForUrl(url);
        return step ? !isMenuStepDone(step, done) : false;
      },
      isTabDotVisible: (tab) =>
        done
          ? !isSidebarTabDone(tab, done, ONBOARDING_MENU_STEPS, visibleStepKeys)
          : false,
      hasPendingItems: done
        ? hasPendingOnboarding(done, ONBOARDING_MENU_STEPS, visibleStepKeys)
        : false,
      registerVisibleSteps,
    }),
    [done, visibleStepKeys, registerVisibleSteps],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

/**
 * Access onboarding dot state. Returns a safe no-op outside the provider (e.g.
 * unauthenticated shells) so dot components never crash.
 */
export function useOnboarding(): OnboardingContextValue {
  return React.useContext(OnboardingContext) ?? NOOP_CONTEXT;
}
