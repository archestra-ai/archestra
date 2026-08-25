import { auth as betterAuth } from "@/auth/better-auth";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import logger from "@/logging";
import {
  OrganizationModel,
  SkillFileModel,
  SkillMarketplaceCredentialModel,
  SkillModel,
  SkillTeamModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import type { MaterializeSkillInput } from "./layout";

/**
 * The static marketplace endpoint: one URL for the whole deployment, cloned by
 * every user. Who the caller is decides what the repository contains, so the
 * URL can be pre-configured in every client without leaking anyone's skills.
 *
 * Credentials arrive over HTTP Basic (what `git` prompts for and stores in the
 * user's credential helper) or as a Bearer header. The value is either a
 * marketplace credential — the narrow, read-only token the setup script writes
 * into the client's marketplace URL — or one of the personal credentials the
 * platform already issues: a personal token from the account page, or an API
 * key, which is what someone typing at git's password prompt will have.
 */

/**
 * Whose view of the marketplace to serve, and what their role lets them see.
 * `userId` null is the anonymous view, which has no role and no admin bypass.
 */
export interface MarketplaceViewer {
  organizationId: string;
  userId: string | null;
  /** Holds `skill:admin`, so scope restrictions do not apply to them. */
  isSkillAdmin: boolean;
}

type ResolveViewerResult =
  | { status: "ok"; viewer: MarketplaceViewer }
  /** No usable credential — answer with a Basic challenge so git prompts. */
  | { status: "unauthenticated" }
  /** Authenticated, but the caller's role cannot read skills at all. */
  | { status: "forbidden" };

/**
 * Upper bound on skills served from one static marketplace, mirroring the
 * per-share-link cap. Keeps a single clone bounded no matter how large the
 * org's skill set grows; the overflow is logged, never silently dropped.
 */
const MAX_MARKETPLACE_SKILLS = 500;

export async function resolveMarketplaceViewer(params: {
  authorization: string | undefined;
}): Promise<ResolveViewerResult> {
  const credential = parseCredential(params.authorization);

  // A credential-free request is the anonymous view — but only where an
  // organization has opted into publishing it. Anything else gets the Basic
  // challenge. There is no credential to resolve an organization from, so the
  // lookup is by the setting itself: whoever publishes anonymously is who an
  // anonymous clone reaches.
  if (!credential) {
    const organization =
      await OrganizationModel.findWithAnonymousSkillMarketplace();
    if (!organization) {
      return { status: "unauthenticated" };
    }
    return {
      status: "ok",
      viewer: {
        organizationId: organization.id,
        userId: null,
        isSkillAdmin: false,
      },
    };
  }

  const identity = await resolveCredential(credential);
  // A bad credential never falls back to the anonymous view: the caller asked
  // to be someone, and silently serving them less would look like their token
  // worked.
  if (!identity) return { status: "unauthenticated" };

  const checker = await getSkillPermissionChecker(identity);
  if (!checker.canRead && !checker.isAdmin) return { status: "forbidden" };

  return {
    status: "ok",
    viewer: {
      organizationId: identity.organizationId,
      userId: identity.userId,
      isSkillAdmin: checker.isAdmin,
    },
  };
}

/**
 * The skills this viewer's marketplace contains: everything they may read
 * (org-scoped, their teams', their own, and skills shared with them), or —
 * for the anonymous view, which has no user to scope by — org-scoped only.
 */
export async function loadMarketplaceSkills(
  viewer: MarketplaceViewer,
): Promise<MaterializeSkillInput[]> {
  const accessibleSkillIds = await resolveAccessibleSkillIds(viewer);

  const skills = await SkillModel.findByOrganization({
    organizationId: viewer.organizationId,
    accessibleSkillIds,
    limit: MAX_MARKETPLACE_SKILLS + 1,
    sorting: { sortBy: "name", sortDirection: "asc" },
  });

  if (skills.length > MAX_MARKETPLACE_SKILLS) {
    logger.warn(
      {
        organizationId: viewer.organizationId,
        userId: viewer.userId,
        limit: MAX_MARKETPLACE_SKILLS,
      },
      "skill-marketplace: static marketplace truncated to the skill cap",
    );
    skills.length = MAX_MARKETPLACE_SKILLS;
  }

  const filesBySkill = await SkillFileModel.findBySkillIds(
    skills.map((skill) => skill.id),
  );

  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    license: skill.license ?? null,
    compatibility: skill.compatibility ?? null,
    allowedTools: skill.allowedTools ?? null,
    agentName: skill.agentName ?? null,
    templated: skill.templated ?? false,
    metadata: (skill.metadata ?? {}) as Record<string, string>,
    updatedAt: skill.updatedAt,
    files: filesBySkill.get(skill.id) ?? [],
  }));
}

// ===== Internal helpers =====

interface MarketplaceIdentity {
  userId: string;
  organizationId: string;
}

/**
 * The credential out of an Authorization header. Basic carries it as the
 * password (`git` sends whatever the user typed at the password prompt); some
 * clients instead put the token in the username and leave the password empty,
 * so both halves are considered.
 */
function parseCredential(authorization: string | undefined): string | null {
  if (!authorization) return null;

  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) return bearer[1].trim() || null;

  const basic = /^Basic\s+(.+)$/i.exec(authorization);
  if (!basic) return null;

  const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return decoded.trim() || null;

  const username = decoded.slice(0, separator).trim();
  const password = decoded.slice(separator + 1).trim();
  return password || username || null;
}

/**
 * Marketplace credential first — it is the one the setup script issues, so it
 * is by far the most common, and its prefix makes the check a cheap miss for
 * anything else. Then a personal token, then an API key. Service-account
 * tokens are not accepted.
 */
async function resolveCredential(
  credential: string,
): Promise<MarketplaceIdentity | null> {
  const marketplaceCredential =
    await SkillMarketplaceCredentialModel.validateToken(credential);
  if (marketplaceCredential) {
    return {
      userId: marketplaceCredential.userId,
      organizationId: marketplaceCredential.organizationId,
    };
  }

  const userToken = await UserTokenModel.validateToken(credential);
  if (userToken) {
    return {
      userId: userToken.userId,
      organizationId: userToken.organizationId,
    };
  }

  let apiKeyUserId: string | null = null;
  try {
    const result = await betterAuth.api.verifyApiKey({
      body: { key: credential },
    });
    apiKeyUserId = result?.valid ? (result.key?.referenceId ?? null) : null;
  } catch {
    // an unparseable key is just an invalid credential
    apiKeyUserId = null;
  }
  if (!apiKeyUserId) return null;

  const user = await UserModel.getById(apiKeyUserId);
  if (!user?.organizationId) return null;
  return { userId: user.id, organizationId: user.organizationId };
}

/**
 * Skill ids the viewer may read, or undefined for "no id restriction" (skill
 * admins see the whole org). Without a user id the lookup returns org-scoped
 * ids, which is exactly the anonymous view.
 */
async function resolveAccessibleSkillIds(
  viewer: MarketplaceViewer,
): Promise<string[] | undefined> {
  if (viewer.isSkillAdmin) return undefined;

  return SkillTeamModel.getUserAccessibleSkillIds({
    organizationId: viewer.organizationId,
    userId: viewer.userId ?? undefined,
  });
}
