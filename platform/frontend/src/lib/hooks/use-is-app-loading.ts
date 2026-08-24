"use client";

import { useIsFetching } from "@tanstack/react-query";

/**
 * Whether anything on screen is still waiting for its first bytes.
 *
 * Only queries with nothing to show count. A background revalidation of data
 * the user is already reading is not news, and counting it would leave the
 * indicator spinning through every poll — the app polls health, deployments
 * and notifications continuously.
 *
 * This is the single signal behind the sidebar toggle's spinner, which is the
 * one place the app reports that it is loading. Pages deliberately do not draw
 * their own: a loader that appears mid-page moves the eye, and stacking
 * several of them at different heights is what made boot feel jumpy.
 */
export function useIsAppLoading(): boolean {
  return (
    useIsFetching({
      predicate: (query) =>
        query.state.data === undefined &&
        query.state.fetchStatus === "fetching",
    }) > 0
  );
}
