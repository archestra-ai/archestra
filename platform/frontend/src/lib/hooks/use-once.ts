import { useMemo, useRef } from "react";

export type Once = {
  /** Pure read — `true` until `done()` is called. Safe to call during render. */
  pending: () => boolean;
  /** Latches the flag. Call from an effect, never during render. */
  done: () => void;
};

export function useOnce(): Once {
  const doneRef = useRef(false);
  return useMemo(
    () => ({
      pending: () => !doneRef.current,
      done: () => {
        doneRef.current = true;
      },
    }),
    [],
  );
}
