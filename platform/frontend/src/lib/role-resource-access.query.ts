"use client";

import {
  archestraApiSdk,
  type RoleResourceAccess,
  UNRESTRICTED_ROLE_RESOURCE_ACCESS,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/auth.query";
import { throwOnApiError } from "@/lib/utils";

export const roleResourceAccessKeys = {
  mine: () => ["role-resource-access", "mine"] as const,
};

/**
 * Which entries of the built-in catalogs the signed-in user's role allows.
 *
 * A `null` list means unrestricted, so every catalog hook falls back to the
 * full catalog while this is loading — the pickers render their normal
 * contents rather than flashing empty, and the API refuses anything the role
 * does not actually allow regardless.
 */
export function useMyResourceAccess(): RoleResourceAccess {
  // Read defensively: this hook sits behind every catalog picker, and the
  // suites that render those mock `@/lib/auth/auth.query` wholesale.
  const session = useSession()?.data;
  const { data } = useQuery({
    queryKey: roleResourceAccessKeys.mine(),
    queryFn: async () => {
      const response = await archestraApiSdk.getUserResourceAccess();
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? UNRESTRICTED_ROLE_RESOURCE_ACCESS;
    },
    enabled: !!session?.user,
    staleTime: 5 * 60 * 1000,
  });
  return data ?? UNRESTRICTED_ROLE_RESOURCE_ACCESS;
}
