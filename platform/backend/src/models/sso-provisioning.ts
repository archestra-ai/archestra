import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { UserModel, MemberModel, OrganizationModel } from "@/models";
import type { SsoProvider } from "@/types";
import logger from "@/logging";

interface ProvisionedUser {
  userId: string;
  organizationId: string;
  memberId: string;
  isNewUser: boolean;
}

/**
 * Provision a user from SSO authentication
 * Creates user if they don't exist, assigns them to organization, and sets up member role
 */
export async function provisionSsoUser(
  provider: SsoProvider,
  userInfo: {
    email: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    organizationId?: string;
    organizationName?: string;
  },
): Promise<ProvisionedUser> {
  // Map attributes based on provider configuration
  const email =
    userInfo.email ||
    (provider.attributeMapping?.email
      ? extractAttribute(userInfo, provider.attributeMapping.email)
      : null);

  if (!email) {
    throw new Error("Email is required for user provisioning");
  }

  const name =
    userInfo.name ||
    (provider.attributeMapping?.name
      ? extractAttribute(userInfo, provider.attributeMapping.name)
      : null) ||
    `${userInfo.firstName || ""} ${userInfo.lastName || ""}`.trim() ||
    email.split("@")[0];

  // Determine organization
  let organizationId = provider.organizationId;

  // If attribute mapping specifies organization, try to use it
  if (provider.attributeMapping?.organizationId) {
    const mappedOrgId = extractAttribute(
      userInfo,
      provider.attributeMapping.organizationId,
    );
    if (mappedOrgId) {
      // Verify the organization exists
      const org = await OrganizationModel.getById(mappedOrgId);
      if (org) {
        organizationId = mappedOrgId;
      }
    }
  }

  // Get or create user
  let user = await UserModel.getByEmail(email);
  let isNewUser = false;

  if (!user) {
    // Create new user
    const [createdUser] = await db
      .insert(schema.usersTable)
      .values({
        id: crypto.randomUUID(),
        email,
        name,
        emailVerified: true, // SSO users are considered verified
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    user = createdUser;
    isNewUser = true;

    logger.info(`✅ Created new user from SSO: ${email}`);
  } else {
    // Update existing user if needed
    if (user.name !== name) {
      await db
        .update(schema.usersTable)
        .set({ name, updatedAt: new Date() })
        .where(eq(schema.usersTable.id, user.id));
      user.name = name;
    }
  }

  // Ensure user is a member of the organization
  const existingMembers = await db
    .select()
    .from(schema.membersTable)
    .where(
      and(
        eq(schema.membersTable.userId, user.id),
        eq(schema.membersTable.organizationId, organizationId),
      ),
    )
    .limit(1);

  let member = existingMembers[0];

  if (!member) {
    // Create member with default role
    const [createdMember] = await db
      .insert(schema.membersTable)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        organizationId,
        role: "member", // Default to member role
        createdAt: new Date(),
      })
      .returning();

    member = createdMember;

    logger.info(
      `✅ Added user ${email} to organization ${organizationId} via SSO`,
    );
  }

  return {
    userId: user.id,
    organizationId,
    memberId: member.id,
    isNewUser,
  };
}

/**
 * Extract attribute value from user info using dot notation
 * Example: "user.email" -> userInfo.user.email
 */
function extractAttribute(
  userInfo: Record<string, any>,
  path: string,
): string | null {
  const parts = path.split(".");
  let value: any = userInfo;

  for (const part of parts) {
    if (value && typeof value === "object" && part in value) {
      value = value[part];
    } else {
      return null;
    }
  }

  return typeof value === "string" ? value : String(value || "");
}
