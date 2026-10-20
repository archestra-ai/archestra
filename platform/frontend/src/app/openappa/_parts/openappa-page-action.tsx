"use client";

import { createContext, type ReactNode, useContext, useEffect } from "react";
import { createPortal } from "react-dom";

export const OpenAppaPageActionSlotContext =
  createContext<HTMLDivElement | null>(null);

/** Where a detail page draws its own name, state and gloss in the shared header. */
export const OpenAppaPageHeaderSlotsContext = createContext<{
  title: HTMLSpanElement | null;
  status: HTMLSpanElement | null;
  description: HTMLSpanElement | null;
}>({ title: null, status: null, description: null });

/** Lets a page ask for the compact detail header (no section tabs). */
export const OpenAppaHeaderModeContext = createContext<
  (mode: { back: boolean } | null) => void
>(() => undefined);

/**
 * Switches the shared Guardrails header to the compact detail form while the
 * calling page is mounted; fill it with `OpenAppaPageHeader`. `back` adds the
 * arrow that leads to the Validations list.
 */
export function useOpenAppaDetailHeader(mode: { back: boolean } | null) {
  const setMode = useContext(OpenAppaHeaderModeContext);
  const back = mode?.back;
  useEffect(() => {
    setMode(back === undefined ? null : { back });
    return () => setMode(null);
  }, [setMode, back]);
}

export function OpenAppaPageAction({ children }: { children: ReactNode }) {
  const slot = useContext(OpenAppaPageActionSlotContext);
  return slot ? createPortal(children, slot) : null;
}

/**
 * Fills the shared Guardrails header on a detail page, so the record's name,
 * state and path sit in the header row instead of a second header below it.
 */
export function OpenAppaPageHeader({
  title,
  status,
  description,
}: {
  title: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
}) {
  const slots = useContext(OpenAppaPageHeaderSlotsContext);
  return (
    <>
      {slots.title && createPortal(title, slots.title)}
      {slots.status && status && createPortal(status, slots.status)}
      {slots.description &&
        description &&
        createPortal(description, slots.description)}
    </>
  );
}
