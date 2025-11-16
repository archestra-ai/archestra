import type { IncomingHttpHeaders } from "node:http";
import { ac, adminRole, memberRole, type Permissions } from "@shared";
import { MemberModel, OrganizationRoleModel } from "@/models";
import { auth as betterAuth } from "./better-auth";

export const hasPermission = async (
  permissions: Permissions,
  requestHeaders: IncomingHttpHeaders,
): Promise<{ success: boolean; error: Error | null }> => {
  const headers = new Headers(requestHeaders as HeadersInit);

  try {
    // First, get the session to understand the user context
    const sessionResult = await betterAuth.api.getSession({
      headers,
    });

    if (!sessionResult?.user || !sessionResult?.session?.activeOrganizationId) {
      // No session - throw to trigger API key fallback
      throw new Error("No active session");
    }

    const { user, session } = sessionResult;
    const organizationId = session.activeOrganizationId;

    if (!user.id || !organizationId) {
      throw new Error("Missing user ID or organization ID");
    }

    // Get user's member record to find their role
    const memberRecord = await MemberModel.getByUserAndOrganization(
      user.id,
      organizationId,
    );

    if (!memberRecord) {
      return {
        success: false,
        error: new Error("User not a member of organization"),
      };
    }

    // Start with predefined roles
    const acRoles = {
      admin: adminRole,
      member: memberRole,
    } as Record<string, ReturnType<typeof ac.newRole>>;

    // Load custom roles from database (but don't override predefined ones)
    const customRoles =
      await OrganizationRoleModel.getAllCustomRoles(organizationId);

    for (const customRole of customRoles) {
      // Skip if it conflicts with predefined roles
      if (customRole.name in acRoles) continue;

      // Create a new role with the stored permissions
      // biome-ignore lint/suspicious/noExplicitAny: Custom role permissions are stored as Partial type
      acRoles[customRole.name] = ac.newRole(customRole.permission as any);
    }

    // Check if the user's role has the required permissions
    const userRole = acRoles[memberRecord.role];
    if (!userRole) {
      return {
        success: false,
        error: new Error(`Role ${memberRecord.role} not found`),
      };
    }

    // Empty permissions should always be allowed
    if (Object.keys(permissions).length === 0) {
      return { success: true, error: null };
    }

    const result = userRole.authorize(permissions);
    return { success: result?.success || false, error: null };
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
