"use client";

import { useId, useState } from "react";

import { cn } from "@/lib/utils/tailwind";

/**
 * The exact text behind an `<InlineNotice>` — a server's raw error, a
 * provider's response — collapsed behind a "Show details" toggle so the
 * notice stays one line tall until someone asks for it.
 *
 * Place it last inside the notice. Its presence turns the notice into a grid:
 * the toggle sits under the message, aligned with the text after the icon
 * (or with the text itself below `sm`, where the notice hides its icon),
 * the trailing action is centred across those two lines, and the opened text
 * takes its own row below in monospace, coloured by the notice's variant.
 */
export function InlineNoticeDetails({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        data-slot="inline-notice-details-toggle"
        className="col-start-1 row-start-2 justify-self-start sm:col-start-2 underline underline-offset-2 opacity-80 hover:opacity-100"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide details" : "Show details"}
      </button>
      {open && (
        <pre
          id={id}
          data-slot="inline-notice-details"
          className={cn(
            "col-start-1 col-end-3 row-start-3 max-h-40 sm:col-start-2 sm:col-end-4 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed",
            className,
          )}
        >
          {children}
        </pre>
      )}
    </>
  );
}
