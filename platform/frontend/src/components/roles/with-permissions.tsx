import type { Permissions } from "@shared";
import type React from "react";
import config from "@/lib/config";

type WithPermissionsProps = {
  permissions: Permissions;
} & (
  | {
      noPermissionHandle: "tooltip";
      children: ({
        hasPermission,
      }: {
        hasPermission: boolean | undefined;
      }) => React.ReactNode;
    }
  | {
      noPermissionHandle: "hide";
      children: React.ReactNode;
    }
);

const PermissionWrapper = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: EE-only permission components
    await import("./with-permissions.ee")
  : {
      WithPermissions: ({ children }: WithPermissionsProps) => {
        // Free version: always allow, no permission checks
        return typeof children === "function"
          ? children({ hasPermission: true })
          : children;
      },
      // OSS version: never render (user always has permissions)
      WithoutPermissions: () => null,
    };

export function WithPermissions(props: WithPermissionsProps) {
  return <PermissionWrapper.WithPermissions {...props} />;
}

export function WithoutPermissions({
  children,
  permissions,
}: {
  permissions: Permissions;
  children: React.ReactNode;
}) {
  return (
    <PermissionWrapper.WithoutPermissions permissions={permissions}>
      {children}
    </PermissionWrapper.WithoutPermissions>
  );
}
