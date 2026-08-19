import type { Permissions } from "@archestra/shared";
import type { ReactNode } from "react";
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

/**
 * One setting: label and description on the left, its control on the right,
 * and any full-width content below.
 *
 * Deliberately not a Card. A settings page is a list of small decisions, and
 * framing each one cost far more vertical space than it bought — a page of
 * six switches scrolled. Rows sit in a plain stack instead, the way the
 * Connection page reads.
 */
export function SettingsBlock({
  title,
  description,
  control,
  notice,
  children,
  id,
}: SettingsBlockProps) {
  return (
    <div id={id} data-slot="settings-block" className="scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && (
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {control && <div className="flex shrink-0 items-center">{control}</div>}
      </div>
      {notice && <div className="mt-2 text-[13px]">{notice}</div>}
      {children && <div className="mt-3">{children}</div>}
    </div>
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
    <div className="flex gap-3 sticky bottom-4 bg-background p-4 rounded-lg border border-border shadow-lg">
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
}

interface SettingsSectionStackProps {
  children: ReactNode;
  className?: string;
}

export function SettingsSectionStack({
  children,
  className,
}: SettingsSectionStackProps) {
  return <div className={cn("space-y-6", className)}>{children}</div>;
}
