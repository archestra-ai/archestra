import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@shared";
import { auth as betterAuth } from "./better-auth";

export const hasPermission = async (
  permissions: Permissions,
  headers: IncomingHttpHeaders,
): Promise<{ success: boolean; error: Error | null }> =>
  betterAuth.api.hasPermission({
    headers: new Headers(headers as HeadersInit),
    body: {
      permissions,
    },
  });
