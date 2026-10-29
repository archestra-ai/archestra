import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a callback whose identity never changes but which always calls the
 * latest `callback`. Use it to hand an event handler that closes over
 * fast-changing state (e.g. the streamed chat transcript) to a memoized child
 * without breaking the child's memoization on every update.
 *
 * Only for handlers invoked from events or effects — never call the returned
 * function during render, where it may still point at the previous callback.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
