import { useEffect, useRef } from 'react';

/**
 * Custom hook for polling data at a specified interval
 * @param callback - Function to call on each interval
 * @param delay - Delay in milliseconds (null to disable)
 */
export function usePolling(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback);

  // Remember the latest callback
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  // Set up the interval
  useEffect(() => {
    if (delay === null) {
      return;
    }

    const id = setInterval(() => {
      savedCallback.current();
    }, delay);

    return () => clearInterval(id);
  }, [delay]);
}
