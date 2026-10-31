import { DocsPage, getDocsUrl } from "@archestra/shared";
import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";

/** How long the hint stays after the pointer leaves it or its icon. */
const CLOSE_DELAY_MS = 150;

/**
 * The (i) next to the Pools column header and the Pooled switch: what a pool
 * does, with a link to the docs. The same hint in the table and the dialog,
 * so nobody opens a form to read it.
 *
 * A popover rather than a tooltip, because the hint holds a link: the pointer
 * opens it in passing without taking focus, and Enter or Space on the icon
 * opens it with the link in the Tab order. Escape closes it and returns focus
 * to the icon.
 */
export function PooledHint() {
  const [open, setOpen] = useState(false);
  // Opened by the pointer, the hint closes when the pointer leaves and takes
  // no focus. Opened by a press, it stays until Escape, a press outside or a
  // second press on the icon.
  const byPointer = useRef(false);
  // Why the hint closed decides where focus goes: Escape hands it back to the
  // icon; a press or a focus elsewhere, and the pointer leaving, leave it be.
  const interactedOutside = useRef(false);
  const returnFocusToIcon = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  // A close still pending when the hint unmounts must not fire.
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  const openByPointer = (event: React.PointerEvent) => {
    if (event.pointerType === "touch") return;
    cancelClose();
    if (!open) {
      byPointer.current = true;
      setOpen(true);
    }
  };
  const closeAfterPointer = () => {
    if (!byPointer.current) return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      returnFocusToIcon.current = false;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        cancelClose();
        if (!next) {
          returnFocusToIcon.current =
            !byPointer.current && !interactedOutside.current;
        }
        interactedOutside.current = false;
        byPointer.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        asChild
        onPointerEnter={openByPointer}
        onPointerLeave={closeAfterPointer}
        // A press while the pointer already opened the hint makes it stay
        // instead of toggling it shut, and moves focus inside as a press on a
        // closed icon would, so Tab reaches the link.
        onClick={(event) => {
          if (open && byPointer.current) {
            event.preventDefault();
            byPointer.current = false;
            contentRef.current?.focus();
          }
        }}
      >
        <UnstyledButton
          ref={triggerRef}
          aria-label="About pooled tiers"
          className="text-muted-foreground hover:text-foreground"
        >
          <Info className="size-3.5" />
        </UnstyledButton>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        sideOffset={6}
        aria-label="About pooled tiers"
        className="w-fit max-w-xs px-3 py-1.5 text-xs text-balance"
        onPointerEnter={cancelClose}
        onPointerLeave={closeAfterPointer}
        // Passing the pointer over the icon must not take focus from whatever
        // the person is editing.
        onOpenAutoFocus={(event) => {
          if (byPointer.current) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!triggerRef.current?.contains(event.target as Node | null)) {
            interactedOutside.current = true;
          }
        }}
        // Radix would skip the icon after any press outside, including the
        // press on the icon that made a pointer-opened hint stay.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusToIcon.current) triggerRef.current?.focus();
          returnFocusToIcon.current = false;
        }}
      >
        Agent runs start much quicker from pool of runtime instances. Managed
        automatically. Pooled instances reserve part of cluster's capacity.{" "}
        <ExternalDocsLink
          href={getDocsUrl(DocsPage.PlatformAgentRuntimeSetup, "warm-pools")}
        >
          Learn more
        </ExternalDocsLink>
      </PopoverContent>
    </Popover>
  );
}
