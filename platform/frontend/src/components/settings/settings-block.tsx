"use client";

import type { Permissions } from "@archestra/shared";
import type { ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { cn } from "@/lib/utils";

interface SettingsBlockProps {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
  /** Anchor for a link that points at this specific setting. */
  id?: string;
}

interface SettingsCardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  notice?: ReactNode;
}

export function SettingsCardHeader({
  title,
  description,
  action,
  notice,
}: SettingsCardHeaderProps) {
  return (
    <CardHeader>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1.5">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action && <div className="flex shrink-0 items-center">{action}</div>}
      </div>
      {notice && <div className="text-sm mt-2">{notice}</div>}
    </CardHeader>
  );
}

export function SettingsBlock({
  title,
  description,
  control,
  notice,
  children,
  id,
}: SettingsBlockProps) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] lg:gap-8">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-medium leading-5">{title}</h2>
          {description && (
            <div className="text-sm leading-5 text-muted-foreground">
              {description}
            </div>
          )}
          {notice && <div className="pt-2 text-sm leading-5">{notice}</div>}
        </div>
        {control && (
          <div className="flex min-w-0 items-start lg:justify-end">
            {control}
          </div>
        )}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
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
  const slot = useContext(SaveBarSlotContext);

  if (!hasChanges) return null;

  const bar = (
    <div className="flex gap-3 bg-background p-4 rounded-lg border border-border shadow-lg">
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
    </div>
  );

  // Inside a stack the bar belongs to the stack's slot, not to wherever the
  // page declared it. Outside one there is nothing to move it into, so it
  // sticks from where it stands.
  return slot ? (
    createPortal(bar, slot)
  ) : (
    <div className="sticky bottom-4 z-10">{bar}</div>
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
