import type { archestraApiTypes } from "@archestra/shared";

type SkillsList = archestraApiTypes.GetSkillsResponses["200"];
type OrgSkill = SkillsList["data"][number];
type ShareLink =
  archestraApiTypes.GetSkillShareLinksResponses["200"]["links"][number];
type CreateShareLinkResult =
  archestraApiTypes.CreateSkillShareLinkResponses["200"];

function makeOrgSkill(id: string, name: string): OrgSkill {
  return {
    id,
    organizationId: "test-org",
    authorId: "test-user-admin",
    scope: "org",
    name,
    description: `${name} description`,
    content: `# ${name}`,
    latestVersion: 1,
    license: null,
    compatibility: null,
    allowedTools: null,
    templated: false,
    metadata: {},
    sourceType: "manual",
    sourceRef: null,
    sourceCommit: null,
    fileCount: 0,
    teams: [],
    authorName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const skillAlpha = makeOrgSkill("11111111-1111-4111-8111-111111111111", "pdf");
const skillBeta = makeOrgSkill("22222222-2222-4222-8222-222222222222", "csv");

/** Two shareable org skills; the step snapshots exactly these ids. */
export const shareableSkillsSeed: SkillsList = {
  data: [skillAlpha, skillBeta],
  pagination: {
    currentPage: 1,
    limit: 100,
    total: 2,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  },
};

export const shareableSkillIds = [skillAlpha.id, skillBeta.id];

/**
 * An active link covering both seeded skills. `expiresAt` is load-bearing:
 * the default rotate handler only succeeds when the client forwards exactly
 * this value, so the spec's refresh test pins the payload.
 */
export const activeShareLinkSeed: ShareLink = {
  id: "33333333-3333-4333-8333-333333333333",
  organizationId: "test-org",
  createdByUserId: "test-user-admin",
  tokenStart: "archestra_skl_AAAAAAAA",
  name: null,
  marketplaceName: "archestra-test-org-skills",
  expiresAt: "2026-09-01T00:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  status: "active",
  skills: shareableSkillsSeed.data.map(({ id, name, description }) => ({
    id,
    name,
    description,
  })),
};

/** Same link but covering only one of the two seeded skills. */
export const staleShareLinkSeed: ShareLink = {
  ...activeShareLinkSeed,
  skills: activeShareLinkSeed.skills.slice(0, 1),
};

export function makeShareLinkCreateResult(
  token: string,
): CreateShareLinkResult {
  return {
    link: {
      ...activeShareLinkSeed,
      id: `44444444-4444-4444-8444-${token.padEnd(12, "0").slice(0, 12)}`,
      tokenStart: `archestra_skl_${token}`,
    },
    rawToken: `archestra_skl_${token}-raw`,
    cloneUrl: `https://app.example.test/skills/m/archestra_skl_${token}-raw/repo.git`,
    marketplaceName: activeShareLinkSeed.marketplaceName,
  };
}
