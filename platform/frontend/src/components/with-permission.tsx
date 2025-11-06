import type { Permission } from "@shared";
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
