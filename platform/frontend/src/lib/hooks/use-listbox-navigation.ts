"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

/** Shared navigation for searchable popovers. Only explicitly registered options
 * participate, so row actions (edit, connect, remove, etc.) keep their own keys. */
export function useListboxNavigation({
  open,
  onOpenChange,
  values,
  selectedValue,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Visible, enabled option values in display order. */
  values: string[];
  selectedValue?: string | null;
  onSelect: (value: string) => void;
}) {
  const listboxId = useId();
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  // Derive a valid target during render, including when async results or
  // selection limits remove/disable the highlighted option.
  const activeValue = !open
    ? null
    : highlightedValue !== null && values.includes(highlightedValue)
      ? highlightedValue
      : selectedValue != null && values.includes(selectedValue)
        ? selectedValue
        : highlightedValue !== null
          ? (values[0] ?? null)
          : null;

  useEffect(() => {
    if (!open) setHighlightedValue(null);
  }, [open]);

  useEffect(() => {
    if (activeValue !== null) {
      optionRefs.current
        .get(activeValue)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeValue]);

  const optionId = (value: string) =>
    `${listboxId}-option-${encodeURIComponent(value)}`;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      !open ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const isInput = event.currentTarget instanceof HTMLInputElement;
    // Do not intercept key events bubbling from ancillary row controls.
    const focusedValue = values.find(
      (value) => optionRefs.current.get(value) === event.target,
    );
    if (event.target !== event.currentTarget && focusedValue === undefined)
      return;
    const current = focusedValue ?? activeValue;
    let next: string | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!values.length) return;
      const index = current === null ? -1 : values.indexOf(current);
      const step = event.key === "ArrowDown" ? 1 : -1;
      next =
        index < 0
          ? step === 1
            ? values[0]
            : values.at(-1)
          : values[(index + step + values.length) % values.length];
    } else if (!isInput && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      next = event.key === "Home" ? values[0] : values.at(-1);
    } else if (
      (event.key === "Enter" || (!isInput && event.key === " ")) &&
      current !== null &&
      values.includes(current)
    ) {
      event.preventDefault();
      onSelect(current);
    }
    if (next !== undefined) {
      setHighlightedValue(next);
      // Search inputs use aria-activedescendant and retain their caret. If a
      // pointer focused an option, keep real focus in sync with navigation.
      if (focusedValue !== undefined) optionRefs.current.get(next)?.focus();
    }
  };

  return {
    activeValue,
    inputProps: {
      role: "combobox" as const,
      "aria-autocomplete": "list" as const,
      "aria-controls": listboxId,
      "aria-expanded": open,
      "aria-activedescendant":
        activeValue !== null ? optionId(activeValue) : undefined,
      onKeyDown,
    },
    listboxProps: {
      id: listboxId,
      onKeyDown,
      "aria-activedescendant":
        activeValue !== null ? optionId(activeValue) : undefined,
    },
    onTriggerKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (
        event.target !== event.currentTarget ||
        event.nativeEvent.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      setHighlightedValue(
        selectedValue != null && values.includes(selectedValue)
          ? selectedValue
          : ((event.key === "ArrowDown" ? values[0] : values.at(-1)) ?? null),
      );
      onOpenChange(true);
    },
    getOptionProps: (value: string) => ({
      id: optionId(value),
      tabIndex: -1,
      ref: (node: HTMLButtonElement | null) => {
        if (node) optionRefs.current.set(value, node);
        else optionRefs.current.delete(value);
      },
      onMouseMove: () => {
        if (values.includes(value)) setHighlightedValue(value);
      },
      onFocus: () => {
        if (values.includes(value)) setHighlightedValue(value);
      },
    }),
  };
}
