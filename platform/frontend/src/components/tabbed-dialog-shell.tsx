"use client";

import { XIcon } from "lucide-react";
import { createContext, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogDismissProvider,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { cn } from "@/lib/utils/tailwind";

export interface TabbedDialogNavItem<TSection extends string> {
  id: TSection;
  label: string;
}

interface TabbedDialogShellProps<TSection extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Render inside a DialogContent already owned by the caller. */
  contentOnly?: boolean;
  title: string;
  description?: string;
  sidebarLabel: string;
  sidebarDescription: string;
  sidebarIcon: ReactNode;
  activeSection: TSection;
  navItems: Array<TabbedDialogNavItem<TSection>>;
  onActiveSectionChange: (section: TSection) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer: ReactNode;
  sidebarFooter?: ReactNode;
  headerExtra?: ReactNode;
  className?: string;
  contentClassName?: string;
  sidebarClassName?: string;
  wrapForm?: (children: ReactNode) => ReactNode;
  getNavItemTestId?: (section: TSection) => string;
  isDirty?: boolean;
}

export function TabbedDialogShell<TSection extends string>({
  open,
  onOpenChange,
  contentOnly = false,
  title,
  description,
  sidebarLabel,
  sidebarDescription,
  sidebarIcon,
  activeSection,
  navItems,
  onActiveSectionChange,
  onSubmit,
  children,
  footer,
  sidebarFooter,
  headerExtra,
  className,
  contentClassName,
  sidebarClassName,
  wrapForm,
  getNavItemTestId,
  isDirty = false,
}: TabbedDialogShellProps<TSection>) {
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);
  const guard = useUnsavedChangesGuard({ isDirty, onOpenChange });
  const formContent = (
    <DialogForm className="contents" onSubmit={onSubmit}>
      <nav
        className={cn(
          "w-[240px] border-r flex flex-col shrink-0",
          sidebarClassName,
        )}
      >
        <div className="flex min-h-[72px] items-center border-b px-4 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted">
              {sidebarIcon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm truncate">
                {sidebarLabel}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {sidebarDescription}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-0.5 px-2 py-3 flex-1">
          {navItems.map((navItem) => (
            <Button
              key={navItem.id}
              type="button"
              variant="ghost"
              data-testid={getNavItemTestId?.(navItem.id)}
              className={cn(
                "justify-start h-9 px-3 font-normal w-full",
                activeSection === navItem.id &&
                  "bg-accent text-accent-foreground font-medium",
              )}
              onClick={() => onActiveSectionChange(navItem.id)}
            >
              {navItem.label}
            </Button>
          ))}
        </div>

        {sidebarFooter && (
          <div className="px-2 pb-3 flex flex-col gap-1.5">{sidebarFooter}</div>
        )}
      </nav>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex min-h-[72px] shrink-0 items-center justify-between gap-4 border-b px-4 py-4">
          <div className="min-w-0">
            <DialogTitle className="truncate">{title}</DialogTitle>
          </div>
          <div className="flex min-w-0 items-center justify-end gap-3">
            {headerExtra}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-xs opacity-70 hover:opacity-100"
              onClick={guard.requestClose}
            >
              <XIcon className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-6",
              contentClassName,
            )}
          >
            <TabbedDialogFooterSlot.Provider value={footerSlot}>
              {children}
            </TabbedDialogFooterSlot.Provider>
          </div>
        </div>
        <DialogStickyFooter className="group/footer mt-0">
          {/* Real boxes, not `display: contents`: the footer lifts its direct
              children above its painted background, and a contents box has
              nothing to lift, so its buttons were hidden under it. */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end group-has-[[data-section-actions]]/footer:hidden">
            {footer}
          </div>
          {/* A section that saves itself, such as permissions, puts its Save
              here, beside the dialog's own buttons. */}
          <div ref={setFooterSlot} className="flex-1 empty:hidden" />
        </DialogStickyFooter>
      </div>
    </DialogForm>
  );

  const content = (
    <>
      <DialogDescription className="sr-only">{description}</DialogDescription>
      <DialogDismissProvider requestClose={guard.requestClose}>
        {wrapForm ? wrapForm(formContent) : formContent}
      </DialogDismissProvider>
    </>
  );

  if (contentOnly) return content;

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        <DialogContent
          className={cn(
            "max-w-6xl h-[85vh] flex flex-row p-0 gap-0 overflow-hidden",
            className,
          )}
          showCloseButton={false}
        >
          {content}
        </DialogContent>
      </Dialog>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </>
  );
}

/**
 * The shell's footer, for a section that saves itself. `undefined` outside a
 * shell; `null` inside one until the footer mounts.
 */
export const TabbedDialogFooterSlot = createContext<
  HTMLDivElement | null | undefined
>(undefined);
