"use client";

import { type ReactNode, useEffect } from "react";
import {
  VERSION_IN_FOOTER_CLASS,
  VERSION_SLOT_ATTRIBUTE,
  VERSION_SLOT_GENERATION_ATTRIBUTE,
} from "@/components/version";
import { cn } from "@/lib/utils/tailwind";

/**
 * Shared action row for full-page create/edit wizards. It sticks to the
 * bottom of the window, so it holds a slot the app's version line moves
 * into: otherwise the line would scroll away underneath it.
 */
export function WizardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  useOffersVersionSlot();
  return (
    <div
      data-wizard-footer
      // The negative margin takes back the page's bottom padding, so at the
      // end of the scroll the bar still meets the window's edge, as it does
      // while it sticks, instead of floating on a strip of background.
      className="flex flex-col border-t bg-background sm:sticky sm:bottom-0 sm:z-10 sm:-mb-6"
    >
      {/* No side padding: the buttons line up with the edges of the fields
          above. */}
      <div
        className={cn(
          "flex min-w-0 flex-col items-stretch gap-2 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:py-3 [&>button]:w-full [&>div]:w-full [&>div]:flex-col [&>div>button]:w-full sm:[&>button]:w-auto sm:[&>div]:w-auto sm:[&>div]:flex-row sm:[&>div>button]:w-auto",
          className,
        )}
      >
        {children}
      </div>
      {/* The version is a centred caption under the buttons, where the page's
          own version line used to sit, rather than competing with them. It
          pulls up into the row's bottom padding and keeps the same padding
          below itself, so the buttons and caption sit centred in the bar. */}
      <div
        {...{ [VERSION_SLOT_ATTRIBUTE]: "" }}
        className="-mt-2 pb-4 text-center empty:hidden sm:-mt-1.5 sm:pb-3"
      />
    </div>
  );
}

/**
 * Tells the version line a footer slot is on screen. Counted, so one footer
 * unmounting does not send it back while another is still showing.
 */
function useOffersVersionSlot() {
  useEffect(() => {
    footersMounted += 1;
    // A footer replacing another leaves the class as it was, so the slot it
    // brings is announced with an attribute that changes on every mount.
    document.body.setAttribute(
      VERSION_SLOT_GENERATION_ATTRIBUTE,
      String(++generation),
    );
    document.body.classList.add(VERSION_IN_FOOTER_CLASS);
    return () => {
      footersMounted -= 1;
      if (footersMounted === 0) {
        document.body.classList.remove(VERSION_IN_FOOTER_CLASS);
      }
    };
  }, []);
}

let footersMounted = 0;
let generation = 0;
