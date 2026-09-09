"use client";

import type { Permissions } from "@archestra/shared";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { cn } from "@/lib/utils";

interface SettingsBlockProps {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
  /** Anchor for a link that points at this specific setting. */
  id?: string;
  contentClassName?: string;
}

export function SettingsBlock({
  title,
  description,
  control,
  notice,
  children,
  id,
  contentClassName,
}: SettingsBlockProps) {
  const hasControl = control != null;

  return (
    <section id={id} className="scroll-mt-24">
      <div
        className={cn(
          "grid gap-4",
          hasControl &&
            "lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] lg:gap-8",
        )}
      >
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-medium leading-5">{title}</h2>
          {description && (
            <div className="text-sm leading-5 text-muted-foreground">
              {description}
            </div>
          )}
          {notice && <div className="pt-2 text-sm leading-5">{notice}</div>}
        </div>
        {hasControl && (
          <div className="flex min-w-0 items-start lg:justify-end">
            {control}
          </div>
        )}
      </div>
      {children && (
        <div className={cn("mt-4", contentClassName)}>{children}</div>
      )}
    </section>
  );
}

/**
 * The floating card the save rows across the app ride in: a settings page's
 * Save/Cancel, and the Save/Discard rows on the agent, MCP gateway, skill and
 * plugin detail pages. It keeps the actions in reach at the foot of a long
 * form without the reader scrolling to the bottom for them.
 *
 * Inside a {@link SettingsSectionStack} the card belongs to the stack's slot,
 * not to wherever the page declared it (see that component for why).
 *
 * Outside a stack it has to float on its own. A plain `position: sticky` bar
 * declared in the page content is enough on a settings page, but a detail page
 * asks {@link PageLayout} for a `min-width` floor, which wraps its content in
 * an `overflow-x` box — and that box is itself a scroll container, so a sticky
 * bar inside it pins to the foot of the *content* (scrolled past with it)
 * rather than to the viewport. To float for the whole page regardless, the bar
 * portals up to the page's real scroll container and borrows the content
 * column's horizontal box from an in-flow anchor left where it was declared.
 * With no such container to find (a bare unit test, or a surface that never
 * sets one) it falls back to sticking from where it stands.
 */
export function FloatingActionBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const slot = useContext(SaveBarSlotContext);
  const anchorRef = useRef<HTMLDivElement>(null);
  // The scroll container to portal into, plus the content column's offset and
  // width within it, so the floating card lines up with the form above it.
  const [portal, setPortal] = useState<{
    target: HTMLElement;
    left: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    // A stack owns placement through its slot; nothing to measure or portal.
    if (slot) return;
    const anchor = anchorRef.current;
    const target = anchor?.closest<HTMLElement>("[data-page-scroll-container]");
    if (!anchor || !target) return;

    const measure = () => {
      const box = anchor.getBoundingClientRect();
      // Hidden (display:none ancestor) — keep the last good measurement rather
      // than snapping the bar to the top-left corner.
      if (box.width === 0) return;
      const targetBox = target.getBoundingClientRect();
      const left = box.left - targetBox.left;
      const width = box.width;
      // Skip no-op updates: this also runs on every scroll (below), and a fresh
      // object each time would re-render the card on plain vertical scroll.
      setPortal((prev) =>
        prev && prev.left === left && prev.width === width
          ? prev
          : { target, left, width },
      );
    };

    measure();
    // Re-measure when the column reflows: a sidebar collapse/expand, a window
    // resize, the content growing a scrollbar.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(anchor);
    observer?.observe(target);
    window.addEventListener("resize", measure);
    // On a viewport narrower than the content column, PageLayout's `overflow-x`
    // box scrolls the form sideways under the bar; that moves the anchor's left
    // edge without resizing anything, so track scroll too. Capture phase, since
    // scroll does not bubble from the inner container.
    document.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [slot]);

  const bar = (
    <div
      className={cn(
        "flex flex-wrap gap-3 bg-background p-4 rounded-lg border border-border shadow-lg",
        className,
      )}
    >
      {children}
    </div>
  );

  if (slot) return createPortal(bar, slot);

  return (
    <>
      {/* Left where the bar was declared, so its geometry tracks the content
          column even as the portaled card floats elsewhere. */}
      <div ref={anchorRef} aria-hidden className="h-0" />
      {portal ? (
        createPortal(
          <div
            className="sticky bottom-4 z-10"
            style={{ marginLeft: portal.left, width: portal.width }}
          >
            {bar}
          </div>,
          portal.target,
        )
      ) : (
        <div className="sticky bottom-4 z-10">{bar}</div>
      )}
    </>
  );
}

interface SettingsSaveBarProps {
  hasChanges: boolean;
  isSaving: boolean;
  permissions: Permissions;
  onSave: () => void;
  onCancel: () => void;
  disabledSave?: boolean;
}

export function SettingsSaveBar({
  hasChanges,
  isSaving,
  permissions,
  onSave,
  onCancel,
  disabledSave,
}: SettingsSaveBarProps) {
  if (!hasChanges) return null;

  return (
    <FloatingActionBar>
      <PermissionButton
        permissions={permissions}
        onClick={onSave}
        disabled={isSaving || disabledSave}
      >
        {isSaving ? "Saving..." : "Save"}
      </PermissionButton>
      <Button variant="outline" onClick={onCancel} disabled={isSaving}>
        Cancel
      </Button>
    </FloatingActionBar>
  );
}

interface SettingsSectionStackProps {
  children: ReactNode;
  className?: string;
}

export function SettingsSectionStack({
  children,
  className,
}: SettingsSectionStackProps) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  return (
    <div className={cn("space-y-8", className)}>
      <SaveBarSlotContext.Provider value={slot}>
        {children}
      </SaveBarSlotContext.Provider>
      {/* Every save bar on the page renders here rather than at its own place
          in the stack. `position: sticky` with a `bottom` offset only lifts a
          box that would otherwise fall below the viewport, so a bar declared
          between two sections floats only until you scroll level with it and
          then rides away with the section above — and a second bar declared
          further down pins to the same offset and covers it. One slot at the
          end of the stack keeps every bar floating for the whole page and
          stacks them instead. */}
      <div
        ref={setSlot}
        className="sticky bottom-4 z-10 space-y-3 empty:hidden"
      />
    </div>
  );
}

/**
 * The stack's save-bar slot, or null for a bar rendered outside any stack.
 * Read by {@link SettingsSaveBar}; there is nothing for a page to set.
 */
const SaveBarSlotContext = createContext<HTMLDivElement | null>(null);
