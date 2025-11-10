import { useEffect, useRef } from "react";

export function useOnUnmount(callback: () => void) {
  const callbackRef = useRef(callback);

  // Update the ref when callback changes
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    return () => {
      callbackRef.current();
    };
  }, []);
}
