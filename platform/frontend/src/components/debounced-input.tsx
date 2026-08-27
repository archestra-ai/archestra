import { forwardRef, useEffect, useRef, useState } from "react";
import { Input } from "./ui/input";

/**
 * How long the pending window is held open past the debounce when the caller
 * never commits the new value back as `initialValue`.
 *
 * The window normally ends the moment the committed value catches up, which is
 * also the moment the caller's own fetch starts — so an indicator driven by it
 * hands over without blinking. Callers that keep the query somewhere other than
 * `initialValue` (a purely local `onSearchChange`) would otherwise leave it
 * open forever, so it is bounded: long enough to cover a client-side
 * navigation, short enough that a stuck indicator is impossible.
 */
const PENDING_HANDOFF_MS = 200;

type DebouncedInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "onChange" | "value"
> & {
  initialValue: string;
  onChange: (value: string) => void;
  debounceMs?: number;
  /**
   * Called when the input starts and stops holding a keystroke the caller has
   * not seen yet. Pass a stable callback (a `useState` setter, or `useCallback`).
   *
   * The window opens on the keystroke rather than when the debounce fires:
   * "I typed and nothing acknowledged it" is the whole gap it exists to cover.
   */
  onPendingChange?: (isPending: boolean) => void;
};

export const DebouncedInput = forwardRef<HTMLInputElement, DebouncedInputProps>(
  function DebouncedInput(
    {
      initialValue,
      onChange,
      debounceMs = 800,
      onPendingChange,
      ...props
    }: DebouncedInputProps,
    ref,
  ) {
    const [value, setValue] = useState(initialValue);
    const [isPending, setIsPending] = useState(false);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const handoffTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const isTypingRef = useRef(false);
    // The debounce callback closes over the value committed at the time it was
    // scheduled, which is stale by the time it runs.
    const committedValueRef = useRef(initialValue);

    // Sync internal state when initialValue changes externally (e.g., browser back/forward)
    // but not while the user is actively typing to prevent eating characters
    useEffect(() => {
      committedValueRef.current = initialValue;
      if (isTypingRef.current) return;
      setValue(initialValue);
      // The caller has the new query, so whatever it kicked off owns the
      // feedback from here.
      clearTimeoutRef(handoffTimeoutRef);
      setIsPending(false);
    }, [initialValue]);

    useEffect(() => {
      onPendingChange?.(isPending);
    }, [isPending, onPendingChange]);

    useEffect(() => {
      return () => {
        clearTimeoutRef(timeoutRef);
        clearTimeoutRef(handoffTimeoutRef);
      };
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setValue(newValue);
      isTypingRef.current = true;
      // Typing back to what the caller already has leaves nothing to wait for.
      clearTimeoutRef(handoffTimeoutRef);
      setIsPending(newValue !== committedValueRef.current);

      clearTimeoutRef(timeoutRef);
      timeoutRef.current = setTimeout(() => {
        isTypingRef.current = false;
        onChange(newValue);
        if (newValue === committedValueRef.current) {
          // A commit that changes nothing produces no new committed value, so
          // nothing else would ever close the window.
          setIsPending(false);
          return;
        }
        handoffTimeoutRef.current = setTimeout(
          () => setIsPending(false),
          PENDING_HANDOFF_MS,
        );
      }, debounceMs);
    };

    return <Input ref={ref} value={value} onChange={handleChange} {...props} />;
  },
);
DebouncedInput.displayName = "DebouncedInput";

function clearTimeoutRef(ref: {
  current: ReturnType<typeof setTimeout> | null;
}) {
  if (!ref.current) return;
  clearTimeout(ref.current);
  ref.current = null;
}
