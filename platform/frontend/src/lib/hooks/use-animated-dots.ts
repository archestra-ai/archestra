import { useEffect, useMemo, useState } from "react";

/**
 * Hook that returns animated dots cycling through ".", "..", "..."
 * Useful for loading/streaming indicators like "Loading..." or "Streaming..."
 */
export function useAnimatedDots(isActive: boolean) {
  const [dotCount, setDotCount] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setDotCount(0);
      return;
    }

    const interval = setInterval(() => {
      setDotCount((prev) => (prev + 1) % 4);
    }, 400);

    return () => clearInterval(interval);
  }, [isActive]);

  return useMemo(() => {
    const dots = ".".repeat(dotCount);
    const spaces = "\u00A0".repeat(3 - dotCount);
    return `${dots}${spaces}`;
  }, [dotCount]);
}
