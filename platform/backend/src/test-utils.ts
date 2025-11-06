import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import db, { schema } from "@/database";

/**
 * Creates a test user in the database
 * This is needed for tests that use access control since user_id has a foreign key constraint
 * Returns the created user ID (UUID)
 */
export async function createTestUser(email?: string): Promise<string> {
  const userId = crypto.randomUUID();
  await db.insert(schema.usersTable).values({
    id: userId,
    name: `Test User ${userId.substring(0, 8)}`,
    email: email || `${userId}@test.com`,
    emailVerified: true,
    role: MEMBER_ROLE_NAME,
  });
  return userId;
}

/**
 * Creates a test admin user in the database
 * Returns the created user ID (UUID)
 */
export async function createTestAdmin(email?: string): Promise<string> {
  const userId = crypto.randomUUID();
  await db.insert(schema.usersTable).values({
    id: userId,
    name: `Admin User ${userId.substring(0, 8)}`,
    email: email || `${userId}@test.com`,
    emailVerified: true,
    role: ADMIN_ROLE_NAME,
  });
  return userId;
}

/**
 * Creates a test organization in the database
 * Returns the created organization ID
 */
export async function createTestOrganization(name?: string): Promise<string> {
  const orgId = crypto.randomUUID();
  await db.insert(schema.organizationsTable).values({
    id: orgId,
    name: name || `Test Org ${orgId.substring(0, 8)}`,
    slug: `test-org-${orgId.substring(0, 8)}`,
    createdAt: new Date(),
  });
  return orgId;
}
