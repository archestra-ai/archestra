import type { Permission } from "@shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "@/auth";

/**
 * Cache for permission checks (in-memory, 72h TTL)
 * Key: "userId:orgId:permission"
 */
const permissionCache = new Map<
  string,
  { result: boolean; timestamp: number }
>();
const PERMISSION_CACHE_TTL = 72 * 60 * 60 * 1000; // 72 hours

/**
 * Cache for role checks (in-memory, 1h TTL)
 * Key: "userId:orgId"
 */
const roleCache = new Map<string, { role: string | null; timestamp: number }>();
const ROLE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Get cache key for role check
 */
async function getRoleCacheKey(
  request: FastifyRequest,
): Promise<string | null> {
  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, value]) => {
    if (value) headers.append(key, value.toString());
  });

  try {
    const session = await auth.api.getSession({ headers });
    if (!session?.user) return null;

    // Verify user still exists in database (not deleted)
    const db = (await import("@/database")).default;
    const { schema } = await import("@/database");
    const { eq } = await import("drizzle-orm");

    const user = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, session.user.id))
      .limit(1);

    if (!user[0]) {
      console.warn(`⚠️ Session found for deleted user: ${session.user.id}`);
      return null;
    }

    const orgId = session.session.activeOrganizationId || "no-org";
    return `${session.user.id}:${orgId}`;
  } catch {
    return null;
  }
}

/**
 * Clear permission cache for a specific role or all
 * Call this when role definitions change (e.g., deploy new permission.ts)
 */
export function clearPermissionCache(role?: string) {
  if (role) {
    // Clear only for specific role
    for (const key of permissionCache.keys()) {
      if (key.startsWith(`${role}:`)) {
        permissionCache.delete(key);
      }
    }
  } else {
    // Clear all permission cache
    permissionCache.clear();
  }
}

/**
 * Clear role cache for a specific user/org
 * Call this when a user's role changes
 */
export function clearRoleCache(userId: string, organizationId?: string) {
  if (organizationId) {
    roleCache.delete(`${userId}:${organizationId}`);
  } else {
    // Clear all roles for this user across all orgs
    for (const key of roleCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        roleCache.delete(key);
      }
    }
  }
}

/**
 * Clear all expired cache entries (run periodically)
 */
function cleanExpiredCache() {
  const now = Date.now();

  // Clean permission cache (72h TTL)
  for (const [key, value] of permissionCache.entries()) {
    if (now - value.timestamp > PERMISSION_CACHE_TTL) {
      permissionCache.delete(key);
    }
  }

  // Clean role cache (1h TTL)
  for (const [key, value] of roleCache.entries()) {
    if (now - value.timestamp > ROLE_CACHE_TTL) {
      roleCache.delete(key);
    }
  }
}

// Clean expired cache every hour (aligned with shortest TTL)
setInterval(cleanExpiredCache, ROLE_CACHE_TTL);
/**
 * Check if user has a specific permission
 */
export async function checkPermission(
  request: FastifyRequest,
  permission: Permission,
): Promise<boolean> {
  const role = await getUserRole(request);
  if (!role) return false;

  // Check permission cache by role:permission
  const permissionCacheKey = `${role}:${permission}`;
  const cached = permissionCache.get(permissionCacheKey);
  if (cached && Date.now() - cached.timestamp < PERMISSION_CACHE_TTL) {
    return cached.result;
  }
  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, value]) => {
    if (value) headers.append(key, value.toString());
  });

  try {
    const [resource, action] = permission.split(":");

    if (!resource || !action) {
      console.error(
        `Invalid permission format: ${permission}. Expected "resource:action"`,
      );
      return false;
    }
    const { success } = await auth.api.hasPermission({
      headers,
      body: {
        permissions: {
          [resource]: [action],
        },
      },
    });
    if (permissionCacheKey) {
      permissionCache.set(permissionCacheKey, {
        result: success,
        timestamp: Date.now(),
      });
    }
    return success;
  } catch {
    return false;
  }
}

/**
 * Generic permission check middleware factory
 */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const hasPermission = await checkPermission(request, permission);

    if (!hasPermission) {
      return reply.status(403).send({
        error: `Permission denied. Required permission: ${permission}`,
      });
    }
  };
}

/**
 * Check multiple permissions (user must have ALL)
 */
export function requireAllPermissions(...permissions: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    for (const permission of permissions) {
      const hasPermission = await checkPermission(request, permission);
      if (!hasPermission) {
        return reply.status(403).send({
          error: `Permission denied. Required permission: ${permission}`,
        });
      }
    }
  };
}

/**
 * Check multiple permissions (user must have ANY)
 */
export function requireAnyPermission(...permissions: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    for (const permission of permissions) {
      const hasPermission = await checkPermission(request, permission);
      if (hasPermission) {
        return; // User has at least one permission
      }
    }

    return reply.status(403).send({
      error: `Permission denied. Required one of: ${permissions.join(", ")}`,
    });
  };
}

/**
 * Get user's role from session
 */
async function getUserRole(request: FastifyRequest): Promise<string | null> {
  const cacheKey = await getRoleCacheKey(request);
  if (cacheKey) {
    const cached = roleCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ROLE_CACHE_TTL) {
      return cached.role;
    }
  }
  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, value]) => {
    if (value) headers.append(key, value.toString());
  });

  try {
    const { role } = await auth.api.getActiveMemberRole({ headers });
    if (cacheKey) {
      roleCache.set(cacheKey, {
        role,
        timestamp: Date.now(),
      });
    }
    return role;
  } catch {
    return null;
  }
}

/**
 * Require admin or owner role
 * More efficient than checking multiple permissions
 */
export async function requireAdminOrOwner(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const role = await getUserRole(request);

  if (role !== "admin" && role !== "owner") {
    return reply.status(403).send({
      error: "Insufficient permissions. Admin or Owner role required.",
    });
  }
}

/**
 * Require any member (including admin and owner)
 */
export async function requireMember(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const role = await getUserRole(request);

  if (!role || !["member", "admin", "owner"].includes(role)) {
    return reply.status(403).send({
      error: "Organization membership required.",
    });
  }
}

/**
 * Require owner role only
 */
export async function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const role = await getUserRole(request);

  if (role !== "owner") {
    return reply.status(403).send({
      error: "Insufficient permissions. Owner role required.",
    });
  }
}
