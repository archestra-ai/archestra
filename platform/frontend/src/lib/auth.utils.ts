import type { Permissions } from "@shared";
import { authClient } from "@/lib/clients/auth/auth-client";

export const hasPermission = async (permissions: Permissions) => {
  try {
    const { data } = await authClient.organization.hasPermission({
      permissions,
    });
    return data?.success ?? false;
  } catch (_error) {
    return false;
  }
};
