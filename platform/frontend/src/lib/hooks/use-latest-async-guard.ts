import { useCallback, useMemo, useRef } from "react";

export function useLatestAsyncGuard() {
  const latestTokenRef = useRef(0);

  const start = useCallback(() => {
    latestTokenRef.current += 1;
    return latestTokenRef.current;
  }, []);

  const isCurrent = useCallback((token: number) => {
    return token === latestTokenRef.current;
  }, []);

  const invalidate = useCallback(() => {
    latestTokenRef.current += 1;
  }, []);

  return useMemo(
    () => ({
      start,
      isCurrent,
      invalidate,
    }),
    [start, isCurrent, invalidate],
  );
}
