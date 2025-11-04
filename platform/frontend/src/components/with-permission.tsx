import type { Permission, Role } from "@shared";
import { useRole } from "@/lib/auth.hook";
import { useHasPermissions } from "@/lib/auth.query";

export function WithPermission({
  children,
  permissions,
}: {
  children: React.ReactNode;
  permissions: Permission[];
}) {
  const hasPermissions = useHasPermissions(permissions);

  // While loading or retrying, don't render anything (prevents flash)
  if (hasPermissions.isLoading || hasPermissions.isFetching) {
    return null;
  }

  // If explicitly denied permission, don't render
  if (hasPermissions.data === false) {
    return null;
  }

  // Only render if permission check succeeded
  if (!hasPermissions.data) {
    return null;
  }

  return children;
}

export function WithPermissions({
  children,
  permissions,
}: {
  children: React.ReactNode;
  permissions: Permission[];
}) {
  const hasPermissions = useHasPermissions(permissions);
  if (!hasPermissions) {
    return null;
  }
  return children;
}

export function WithRole({
  children,
  requiredMinimalRole,
  requiredExactRole,
}: {
  children: React.ReactNode;
  requiredMinimalRole?: Role;
  requiredExactRole?: Role;
}) {
  const currentRole = useRole();

  if (requiredExactRole && currentRole === requiredExactRole) {
    return children;
  }

  if (requiredMinimalRole) {
    if (currentRole === "admin") {
      return children;
    }
    if (requiredMinimalRole === currentRole) {
      return children;
    }
  }
  return null;
}
