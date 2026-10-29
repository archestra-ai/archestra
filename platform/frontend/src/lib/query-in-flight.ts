import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The answer of the request already running for `queryKey`, once it lands.
 * Undefined when none is running or it fails; never starts one.
 *
 * For a query whose answer another, broader query may already hold (a lookup
 * by id next to the list it is in): its fetch waits for the broader request
 * started alongside it on the same page load, instead of sending its own at
 * the same moment. Only a running request is reused, so a refetch of the
 * narrower query never answers from the broader one's older data.
 */
export async function inFlightQueryData<TData>(
  client: QueryClient,
  queryKey: QueryKey,
): Promise<TData | undefined> {
  const query = client.getQueryCache().find<TData>({ queryKey, exact: true });
  if (query?.state.fetchStatus !== "fetching" || !query.promise) {
    return undefined;
  }
  try {
    return await query.promise;
  } catch {
    return undefined;
  }
}
