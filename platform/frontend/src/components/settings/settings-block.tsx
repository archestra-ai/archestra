import type { Permissions } from "@shared";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";

interface SettingsBlockProps {
  title: string;
  description?: string;
  control: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
}

export function SettingsBlock({
  title,
  description,
  control,
  notice,
  children,
}: SettingsBlockProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold leading-none tracking-tight">
              {title}
            </h3>
            {description && (
              <p className="text-sm text-muted-foreground mt-1.5">
                {description}
              </p>
            )}
          </div>
          <div className="shrink-0">{control}</div>
        </div>
        {notice && <div className="text-sm mt-2">{notice}</div>}
      </CardHeader>
      {children && (
        <CardContent className="pt-6 border-t">{children}</CardContent>
      )}
    </Card>
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
