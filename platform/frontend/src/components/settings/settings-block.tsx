import type { Permissions } from "@shared";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { cn } from "@/lib/utils";

interface SettingsBlockProps {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  notice?: ReactNode;
  children?: ReactNode;
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
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
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
}: SettingsBlockProps) {
  return (
    <Card>
      <SettingsCardHeader
        title={title}
        description={description}
        action={control}
        notice={notice}
      />
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

interface SettingsSectionStackProps {
  children: ReactNode;
  className?: string;
}

export function SettingsSectionStack({
  children,
  className,
}: SettingsSectionStackProps) {
  return <div className={cn("space-y-5", className)}>{children}</div>;
}
