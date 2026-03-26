import type { Action, Resource } from "@shared";
import { Fragment } from "react";
import { CodeText } from "@/components/code-text";
import { cn } from "@/lib/utils";

type PermissionRequirement = {
  resource: Resource;
  action: Action;
};

export function formatPermissionRequirement({
  resource,
  action,
}: PermissionRequirement): string {
  return `${resource}:${action}`;
}

export function PermissionRequirementHint({
  permissions,
  message = "Unavailable without required permission",
  className,
}: {
  permissions: PermissionRequirement[];
  message?: string;
  className?: string;
}) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {message}{" "}
      {permissions.map((permission, index) => (
        <Fragment key={formatPermissionRequirement(permission)}>
          {index > 0 ? ", " : null}
          <CodeText className="px-1.5 text-[11px] font-mono">
            {formatPermissionRequirement(permission)}
          </CodeText>
        </Fragment>
      ))}
      .
    </p>
  );
}
