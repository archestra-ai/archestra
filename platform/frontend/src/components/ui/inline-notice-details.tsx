"use client";

import { useId, useState } from "react";

import { cn } from "@/lib/utils/tailwind";

/**
 * The exact text behind an `<InlineNotice>` — a server's raw error, a
 * provider's response — collapsed behind a "Show details" toggle so the
 * notice stays one line tall until someone asks for it.
 *
 * The toggle sits on the notice's row, beside any trailing action. The opened
 * text always takes the last row, in monospace, coloured by the notice's
 * variant like everything else in it.
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
        className="underline underline-offset-2 opacity-80 hover:opacity-100"
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
            "order-last max-h-40 basis-full overflow-auto whitespace-pre-wrap break-words rounded-sm bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed",
            className,
          )}
        >
          {children}
        </pre>
      )}
    </>
  );
}
