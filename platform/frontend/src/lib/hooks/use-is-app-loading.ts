"use client";

import { useIsFetching } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether anything on screen is still waiting for its first bytes.
 *
 * Only queries with nothing to show count. A background revalidation of data
 * the user is already reading is not news, and counting it would leave the
 * indicator spinning through every poll — the app polls health, deployments
 * and notifications continuously.
 *
 * This is the single signal behind the sidebar toggle's spinner, which is the
 * one place the app reports that it *itself* is loading — booting, or moving
 * between pages. A search box reporting its own wait is the documented
 * exception; see {@link useReportSearchInFlight}.
 */
export function useIsAppLoading(): boolean {
  const searchesInFlight = useSyncExternalStore(
    searchActivity.subscribe,
    searchActivity.getSnapshot,
    searchActivity.getServerSnapshot,
  );

  const isFetching =
    useIsFetching({
      predicate: (query) =>
        query.state.data === undefined &&
        query.state.fetchStatus === "fetching",
    }) > 0;

  // A search already accounts for its own wait twice over — the box is lit and
  // the table it filters is drawing a progress bar across its top edge. Adding
  // the sidebar's spinner to that puts a third indicator on screen for one
  // wait, in the corner furthest from where the user is looking.
  //
  // Note this cannot be inferred from the query alone. Changing the search term
  // changes the query key, so the new cache entry has `data === undefined` and
  // matches the predicate above even on the lists that keep their previous page
  // on screen via `placeholderData` — the previous page lives on the observer,
  // not in the entry being fetched. The search box is the only thing that knows
  // this wait is a search.
  return isFetching && searchesInFlight === 0;
}

/**
 * Report that a search box is waiting, for as long as it is.
 *
 * Called by `SearchInput` with the state driving its own spinner, so the two
 * indicators cannot disagree about whether a search is in flight.
 */
export function useReportSearchInFlight(isInFlight: boolean): void {
  useEffect(() => {
    if (!isInFlight) return;
    return searchActivity.begin();
  }, [isInFlight]);
}

/**
 * How many search boxes are waiting right now.
 *
 * A counter rather than a boolean because a page can hold more than one search
 * box, and two overlapping waits must not have the first to finish speak for
 * the second.
 */
class SearchActivity {
  private count = 0;
  private listeners = new Set<() => void>();

  begin = (): (() => void) => {
    this.count += 1;
    this.emit();

    let hasEnded = false;
    return () => {
      // Effect cleanups can run more than once under StrictMode's
      // mount/unmount rehearsal; double-decrementing would strand the count
      // below zero and suppress the spinner for the rest of the session.
      if (hasEnded) return;
      hasEnded = true;
      this.count -= 1;
      this.emit();
    };
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this.count;

  /** Nothing is in flight during SSR, and the count must not vary per render. */
  getServerSnapshot = (): number => 0;

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const searchActivity = new SearchActivity();
