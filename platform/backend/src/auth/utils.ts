import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@shared";
import config from "@/config";

export async function hasPermission(
  ...args: [Permissions, IncomingHttpHeaders]
): Promise<{ success: boolean; error: Error | null }> {
  const { hasPermission } = config.enterpriseLicenseActivated
    ? // biome-ignore lint/style/noRestrictedImports: conditional EE import
      await import("./utils.ee")
    : {
        hasPermission: async (
          _permissions: Permissions,
          _requestHeaders: IncomingHttpHeaders,
        ): Promise<{ success: boolean; error: Error | null }> => {
          return {
            success: true, // Always allow - no permission check in non-enterprise version
            error: null,
          };
        },
      };
  return hasPermission.apply(null, args);
}
