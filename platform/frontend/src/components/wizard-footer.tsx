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
      className="flex flex-col border-t bg-background sm:sticky sm:bottom-0 sm:z-10 sm:-mb-6 sm:flex-row sm:items-center sm:gap-x-4"
    >
      {/* The version shares the buttons' line to keep the bar short; on a
          phone, where the bar does not stick, it goes under them. */}
      <div
        {...{ [VERSION_SLOT_ATTRIBUTE]: "" }}
        className="order-last shrink-0 pb-3 text-center empty:hidden sm:order-first sm:pb-0 sm:text-left"
      />
      {/* No side padding: the buttons line up with the edges of the fields
          above. */}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col items-stretch gap-2 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between [&>button]:w-full [&>div]:w-full [&>div]:flex-col [&>div>button]:w-full sm:[&>button]:w-auto sm:[&>div]:w-auto sm:[&>div]:flex-row sm:[&>div>button]:w-auto",
          className,
        )}
      >
        {children}
      </div>
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
