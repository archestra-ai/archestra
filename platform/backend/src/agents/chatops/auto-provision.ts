import { MEMBER_ROLE_NAME } from "@shared";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import { MemberModel, OrganizationModel, UserModel } from "@/models";
import type { ChatOpsProviderType } from "@/types/chatops";

const INVITATION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Auto-provision an Archestra user + member from a Slack/Teams interaction.
 *
 * Creates a `user` row and a `member` row (role: member, no team).
 * Does NOT create an `account` row — the user has no login credentials yet.
 * Also creates an `invitation` record that powers the signup-completion link.
 *
 * Handles the race condition where two messages arrive simultaneously for the
 * same unregistered user: catches the unique constraint violation on user.email
 * and falls back to a findByEmail lookup.
 */
export async function autoProvisionUser(params: {
  email: string;
  name: string;
  provider: ChatOpsProviderType;
}): Promise<{ userId: string; invitationId: string }> {
  const { email, name, provider } = params;
  const normalizedEmail = email.toLowerCase();

  const org = await OrganizationModel.getFirst();
  if (!org) {
    throw new Error("No organization found for auto-provisioning");
  }

  try {
    // Create user record (no account — no password/login yet)
    const userId = crypto.randomUUID();
    await db.insert(schema.usersTable).values({
      id: userId,
      name,
      email: normalizedEmail,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create member record linking user to organization
    await MemberModel.create(userId, org.id, MEMBER_ROLE_NAME);

    // Create invitation record for the signup-completion link
    const invitationId = crypto.randomUUID();
    await db.insert(schema.invitationsTable).values({
      id: invitationId,
      organizationId: org.id,
      email: normalizedEmail,
      role: MEMBER_ROLE_NAME,
      status: `auto-provisioned:${provider}`,
      expiresAt: new Date(Date.now() + INVITATION_EXPIRY_MS),
      inviterId: userId, // Self-referencing — auto-provisioned
    });

    logger.info(
      { userId, email: normalizedEmail, organizationId: org.id },
      "[ChatOps] Auto-provisioned user from chat platform",
    );

    return { userId, invitationId };
  } catch (error) {
    // Handle race condition: unique constraint violation on user.email
    if (
      error instanceof Error &&
      error.message.includes("unique") // Postgres unique violation
    ) {
      logger.debug(
        { email: normalizedEmail },
        "[ChatOps] Auto-provision race condition — user already exists",
      );
      const existingUser = await UserModel.findByEmail(normalizedEmail);
      if (existingUser) {
        return { userId: existingUser.id, invitationId: "" };
      }
    }
    throw error;
  }
}

/**
 * Check if any SSO identity provider is configured.
 */
export async function isSsoConfigured(): Promise<boolean> {
  const [idp] = await db
    .select({ id: schema.identityProvidersTable.id })
    .from(schema.identityProvidersTable)
    .limit(1);
  return !!idp;
}

/**
 * Build the ephemeral welcome message sent to auto-provisioned users.
 */
export function buildWelcomeMessage(params: {
  invitationId: string;
  email: string;
  isSso: boolean;
}): string {
  const { invitationId, email, isSso } = params;
  const baseUrl = config.frontendBaseUrl;

  if (isSso) {
    const signInUrl = `${baseUrl}/auth/sign-in`;
    return (
      `Welcome! We created an Archestra account for you (${email}). ` +
      `To access the full web app, sign in at: ${signInUrl}`
    );
  }

  const signUpUrl = `${baseUrl}/auth/sign-up-with-invitation?invitationId=${invitationId}&email=${encodeURIComponent(email)}`;
  return (
    `Welcome! We created an Archestra account for you (${email}). ` +
    `To set up your password and access the full web app, visit: ${signUpUrl}`
  );
}
