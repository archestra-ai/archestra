"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { formatThousands } from "@/lib/utils";

/**
 * Index just past the `count`-th digit of `text`, used to put the caret back
 * where the typing left it. Separators the formatter inserted shift every
 * position after them, so the caret is tracked by digits typed rather than by
 * character offset.
 */
function caretAfterDigits(text: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] >= "0" && text[index] <= "9") {
      seen++;
      if (seen === count) return index + 1;
    }
  }
  return text.length;
}

function countDigits(text: string): number {
  return text.replace(/\D/g, "").length;
}

interface GroupedNumberInputProps
  extends Omit<
    React.ComponentProps<typeof Input>,
    "value" | "onChange" | "type"
  > {
  /**
   * Digits only, without separators — the canonical form, and what callers
   * store. The separators exist for reading and are never part of the value.
   */
  value: string;
  onChange: (value: string) => void;
}

/**
 * A whole-number input that shows thousands separators as you type: 128000
 * reads back as "128,000". Large token counts are hard to eyeball otherwise —
 * 128000 and 1280000 look alike at a glance.
 *
 * The value handed to `onChange` stays digits-only, so validators and parsers
 * never see a separator. Non-digits are dropped on the way in, which also makes
 * pasting an already-formatted number work.
 */
export function GroupedNumberInput({
  value,
  onChange,
  ref,
  ...props
}: GroupedNumberInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Set only by an edit, then consumed by the layout effect below. Restoring
  // the caret on every render would fight the user when focus moves elsewhere.
  const pendingCaret = useRef<number | null>(null);

  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    if (caret !== null) {
      inputRef.current?.setSelectionRange(caret, caret);
    }
  });

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const typed = event.target.value;
    const caret = event.target.selectionStart ?? typed.length;
    const digits = typed.replace(/\D/g, "");
    // Measured against what was typed, not against the previous value: an edit
    // in the middle of the number must leave the caret in the middle.
    pendingCaret.current = caretAfterDigits(
      formatThousands(digits),
      countDigits(typed.slice(0, caret)),
    );
    onChange(digits);
  };

  return (
    <Input
      {...props}
      ref={setRefs}
      // `text`, not `number`: a number input renders its own spinner, rejects
      // the separators outright, and reports an empty value for anything it
      // considers malformed.
      type="text"
      inputMode="numeric"
      value={formatThousands(value)}
      onChange={handleChange}
    />
  );
}
