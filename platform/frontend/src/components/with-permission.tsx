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
  requiredRole,
}: {
  children: React.ReactNode;
  requiredRole: Role;
}) {
  const currentRole = useRole();
  if (currentRole === "admin") {
    return children;
  }
  if (requiredRole === currentRole) {
    return children;
  }
  return null;
}
