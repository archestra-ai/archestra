import type { Permissions } from "@archestra/shared";
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

const {
  WithPermissions: WithPermissionsEE,
  WithoutPermissions: WithoutPermissionsEE,
} = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: EE-only permission components
    await import("./with-permissions.ee")
  : {
      WithPermissions: ({ children }: WithPermissionsProps) => {
        // Free version: always allow, no permission checks
        return typeof children === "function"
          ? children({ hasPermission: true })
          : children;
      },
      WithoutPermissions: () => {
        // Free version: never render (user always has permissions)
        return null;
      },
    };

export function WithPermissions(props: WithPermissionsProps) {
  return <WithPermissionsEE {...props} />;
}

export function WithoutPermissions({
  children,
  permissions,
}: {
  permissions: Permissions;
  children: React.ReactNode;
}) {
  return (
    <WithoutPermissionsEE permissions={permissions}>
      {children}
    </WithoutPermissionsEE>
  );
}
