import { AUTO_PROVISIONED_INVITATION_STATUS } from "@archestra/shared";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  MemberModel,
  OrganizationModel,
  UserModel,
} from "@/models";
import type { ChatOpsProviderType, User } from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

const INVITATION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Auto-provision an Archestra user + member from a Slack/Teams interaction.
 *
 * Creates a `user` row and a `member` row (org default role, no team).
 * Does NOT create an `account` row — the user has no login credentials yet.
 * Also creates an `invitation` record that powers the signup-completion link.
 *
 * Handles the race condition where two messages arrive simultaneously for the
 * same unregistered user: catches the unique constraint violation on user.email
 * and falls back to a findByEmail lookup, returning `invitationId: null` for
 * that already-existing user so callers suppress the welcome message.
 */
export async function autoProvisionUser(params: {
  email: string;
  name: string;
  provider: ChatOpsProviderType;
}): Promise<{ userId: string; invitationId: string | null }> {
  const { email, name, provider } = params;
  const normalizedEmail = email.toLowerCase();

  const org = await OrganizationModel.getFirst();
  if (!org) {
    throw new Error("No organization found for auto-provisioning");
  }

  // Org-configured default role for new users (falls back to "member").
  const defaultRole = await OrganizationModel.getDefaultMemberRole(org.id);

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
    await MemberModel.create(userId, org.id, defaultRole);

    // Create personal default chat agent for the new member
    try {
      await AgentModel.ensurePersonalChatAgent({
        userId,
        organizationId: org.id,
      });
    } catch (error) {
      logger.error(
        { err: error, userId },
        "[ChatOps] Failed to create personal chat agent",
      );
    }

    // Create personal MCP gateway for the new member
    try {
      await AgentModel.ensurePersonalMcpGateway({
        userId,
        organizationId: org.id,
      });
    } catch (error) {
      logger.error(
        { err: error, userId },
        "[ChatOps] Failed to create personal MCP gateway",
      );
    }

    // Create invitation record for the signup-completion link
    const invitationId = crypto.randomUUID();
    await db.insert(schema.invitationsTable).values({
      id: invitationId,
      organizationId: org.id,
      email: normalizedEmail,
      role: defaultRole,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:${provider}`,
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
    if (isUniqueConstraintError(error)) {
      logger.debug(
        { email: normalizedEmail },
        "[ChatOps] Auto-provision race condition — user already exists",
      );
      const existingUser = await UserModel.findByEmail(normalizedEmail);
      if (existingUser) {
        return { userId: existingUser.id, invitationId: null };
      }
    }
    throw error;
  }
}

/**
 * Resolve a chat sender to an Archestra user, auto-provisioning on first sight.
 *
 * Returns the existing user with `invitationId: null` when already registered, or
 * the freshly provisioned user with the invitation id (callers gate the welcome on
 * `invitationId !== null`). Returns `null` when provisioning succeeded but the user
 * could not be re-resolved afterwards. `resolveDisplayName` is only invoked when a
 * new user is actually provisioned.
 */
export async function ensureProvisionedUser(params: {
  email: string;
  resolveDisplayName: () => Promise<string>;
  provider: ChatOpsProviderType;
}): Promise<{ user: User; invitationId: string | null } | null> {
  const { email, resolveDisplayName, provider } = params;
  const normalizedEmail = email.toLowerCase();

  const existing = await UserModel.findByEmail(normalizedEmail);
  if (existing) {
    return { user: existing, invitationId: null };
  }

  const name = await resolveDisplayName();
  const { invitationId } = await autoProvisionUser({ email, name, provider });

  const user = await UserModel.findByEmail(normalizedEmail);
  if (!user) {
    return null;
  }

  return { user, invitationId };
}

type SignupWelcomeMode = "signup" | "login" | "none";

/**
 * How (and whether) to welcome a newly auto-provisioned user:
 * - "none"   — ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED=false (deployments
 *   whose chatops users don't get web app access), or there is no working way
 *   into the web app to point at: the finish-signup flow needs both
 *   invitations and basic sign-in enabled, and no SSO provider exists.
 * - "login"  — an SSO identity provider is configured: no invitation to
 *   complete, the welcome just links to the sign-in page.
 * - "signup" — default: the welcome links to the finish-signup page for the
 *   user's invitation.
 */
export async function resolveSignupWelcomeMode(): Promise<SignupWelcomeMode> {
  if (!config.chatops.signupWelcomeEnabled) return "none";
  if (await isSsoConfigured()) return "login";
  if (config.auth.disableInvitations || config.auth.disableBasicAuth) {
    return "none";
  }
  return "signup";
}

interface WelcomeMessage {
  text: string;
  actionUrl: string;
  actionLabel: string;
}

/**
 * Build the welcome message sent to auto-provisioned users via DM.
 */
export async function buildWelcomeMessage(params: {
  mode: Exclude<SignupWelcomeMode, "none">;
  invitationId: string;
  email: string;
  name: string;
}): Promise<WelcomeMessage> {
  const { mode, invitationId, email, name } = params;
  const baseUrl = config.frontendBaseUrl;
  const appName = await OrganizationModel.getAppName();

  if (mode === "login") {
    return {
      text: `Hey there 👋 We created a ${appName} user for you (${email}). Sign in to access the ${appName} web app.`,
      actionUrl: `${baseUrl}/auth/sign-in`,
      actionLabel: "Sign In",
    };
  }

  return {
    text: `Hey there 👋 We created a ${appName} user for you (${email}). Finish signing up to access the ${appName} web app.`,
    actionUrl: `${baseUrl}/auth/sign-up-with-invitation?invitationId=${invitationId}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`,
    actionLabel: "Finish Signup",
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Check if any SSO identity provider is configured.
 */
async function isSsoConfigured(): Promise<boolean> {
  const [idp] = await db
    .select({ id: schema.identityProvidersTable.id })
    .from(schema.identityProvidersTable)
    .limit(1);
  return !!idp;
}
