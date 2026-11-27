import { useCallback, useRef } from "react";

/**
 * Wraps an async action so that a call made while the previous one is still
 * running does nothing.
 *
 * A confirm button is disabled from the mutation's `isPending`, but that flag
 * reaches the button a render later than the click that started the request.
 * The second click of a double click lands inside that gap and sends the
 * request again: for a delete or a restore the repeat is answered "Skill not
 * found", about a request that had just worked. The ref closes the gap, since
 * it is set in the same tick as the first call.
 */
export function useSingleFlight<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown>,
): (...args: Args) => Promise<void> {
  const actionRef = useRef(action);
  actionRef.current = action;
  const inFlightRef = useRef(false);
  return useCallback(async (...args: Args) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await actionRef.current(...args);
    } finally {
      inFlightRef.current = false;
    }
  }, []);
}
