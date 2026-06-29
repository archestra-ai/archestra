import { useEffect, useState } from "react";

/**
 * Returns a copy of `value` that only updates after `delayMs` of no changes.
 * Useful for debouncing search inputs that drive network requests.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
