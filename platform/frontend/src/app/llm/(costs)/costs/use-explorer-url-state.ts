"use client";

import type { StatisticsTimeFrame } from "@archestra/shared";
import { useSearchParams } from "next/navigation";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Native history keeps explorer changes shareable without refetching the page shell. */
export function useExplorerUrlState<T>({
  keys,
  decode,
  encode,
  timeframe,
}: {
  keys: readonly string[];
  decode: (params: URLSearchParams) => T;
  encode: (state: T) => URLSearchParams;
  timeframe: StatisticsTimeFrame;
}) {
  const searchParams = useSearchParams();
  const params = new URLSearchParams(
    searchParams?.toString() ??
      (typeof window === "undefined" ? "" : window.location.search),
  );
  const owned = new URLSearchParams();
  for (const key of keys)
    for (const value of params.getAll(key)) owned.append(key, value);
  const urlState = owned.toString();
  const [state, setState] = useState(() => decode(params));
  const current = useRef(state);
  const pending = useRef(false);
  const mounted = useRef(true);
  const lastWritten = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (pending.current || encode(current.current).toString() === urlState)
      return;
    const actual = new URLSearchParams();
    const locationParams = new URLSearchParams(window.location.search);
    for (const key of keys)
      for (const value of locationParams.getAll(key)) actual.append(key, value);
    if (lastWritten.current !== null && actual.toString() !== urlState) return;
    const restored = decode(new URLSearchParams(urlState));
    current.current = restored;
    setState(restored);
  }, [urlState, decode, encode, keys]);
  const set = useCallback(
    <K extends keyof T>(key: K, action: SetStateAction<T[K]>) => {
      const value =
        typeof action === "function"
          ? (action as (previous: T[K]) => T[K])(current.current[key])
          : action;
      const next = { ...current.current, [key]: value };
      current.current = next;
      setState(next);
      // One history entry per interaction, even when it changes several controls.
      if (pending.current) return;
      pending.current = true;
      queueMicrotask(() => {
        pending.current = false;
        if (!mounted.current) return;
        const params = new URLSearchParams(window.location.search);
        for (const key of keys) params.delete(key);
        const encoded = encode(current.current);
        lastWritten.current = encoded.toString();
        for (const [key, value] of encoded) params.append(key, value);
        if (!params.has("timeframe"))
          params.set("timeframe", String(timeframe));
        const url = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
        if (
          url !==
          `${window.location.pathname}${window.location.search}${window.location.hash}`
        )
          window.history.pushState(null, "", url);
      });
    },
    [keys, encode, timeframe],
  );
  return [state, set] as const;
}
