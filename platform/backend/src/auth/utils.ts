import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@shared";
import { auth as betterAuth } from "./better-auth";

export const hasPermission = async (
  permissions: Permissions,
  requestHeaders: IncomingHttpHeaders,
): Promise<{ success: boolean; error: Error | null }> => {
  const headers = new Headers(requestHeaders as HeadersInit);
  try {
    return await betterAuth.api.hasPermission({
      headers,
      body: {
        permissions,
      },
    });
  } catch (_error) {
    /**
     * Handle API key sessions that don't have organization context
     * API keys have all permissions by default (see auth config)
     */
    const authHeader = headers.get("authorization");

    if (authHeader) {
      try {
        // Verify if this is a valid API key
        const apiKeyResult = await betterAuth.api.verifyApiKey({
          body: { key: authHeader },
        });
        if (apiKeyResult?.valid) {
          // API keys have all permissions, so allow the request
          return { success: true, error: null };
        }
      } catch (_apiKeyError) {
        // Not a valid API key, return original error
        return { success: false, error: new Error("Invalid API key") };
      }
    }
    return { success: false, error: new Error("No API key provided") };
  }
};
