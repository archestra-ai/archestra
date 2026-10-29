"use client";

import { useEffect, useState } from "react";

/**
 * The start of the current minute, as epoch ms, ticking only while `ticking`.
 * A relative range resolved against it moves with the clock while keeping one
 * value per minute, so queries built from it keep a stable key in between.
 */
export function useMinute(ticking: boolean) {
  const [minute, setMinute] = useState(() => startOfMinute(Date.now()));
  useEffect(() => {
    if (!ticking) return;
    setMinute(startOfMinute(Date.now()));
    const timer = window.setInterval(
      () => setMinute(startOfMinute(Date.now())),
      15_000,
    );
    return () => window.clearInterval(timer);
  }, [ticking]);
  return minute;
}

function startOfMinute(ms: number) {
  return Math.floor(ms / 60_000) * 60_000;
}
