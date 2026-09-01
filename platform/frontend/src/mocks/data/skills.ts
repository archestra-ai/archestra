import type { archestraApiTypes } from "@archestra/shared";

type SkillsList = archestraApiTypes.GetSkillsResponses["200"];
type SkillListItem = SkillsList["data"][number];
type SkillDetail = archestraApiTypes.GetSkillResponses["200"];
type CatalogSearch = archestraApiTypes.SearchSkillCatalogResponses["200"];
type GithubDiscover = archestraApiTypes.DiscoverGithubSkillsResponses["200"];
type DiscoveredSkill = GithubDiscover["skills"][number];
type GithubPreview = archestraApiTypes.PreviewGithubSkillResponses["200"];
type GithubImport = archestraApiTypes.ImportGithubSkillsResponses["200"];
type ImportedSkill = GithubImport["created"][number];

/**
 * The organization's skills. `jira-task` is the heavily used one the usage
 * demo hangs off; the others give the list something to sort and the Usage tab
 * its quieter and never-used cases.
 */
export const demoSkills: SkillListItem[] = [
  makeSkillListItem({
    id: "skill-jira-task",
    name: "jira-task",
    description:
      "Perform Jira issue operations via the Atlassian Cloud MCP server.",
    fileCount: 4,
    usageCount: 207,
    usageUserCount: 41,
    lastUsedAt: minutesAgo(43),
  }),
  makeSkillListItem({
    id: "skill-release-checklist",
    name: "release-checklist",
    description: "Walk a release through its pre-flight checks and sign-off.",
    fileCount: 2,
    usageCount: 10,
    usageUserCount: 2,
    lastUsedAt: minutesAgo(180),
  }),
  makeSkillListItem({
    id: "skill-incident-postmortem",
    name: "incident-postmortem",
    description: "Draft a blameless postmortem from an incident timeline.",
    scope: "team",
    sourceType: "github",
    sourceRef: "acme/skills@main",
    githubSyncInterval: "1h",
    githubSyncRef: "main",
    lastSyncedAt: minutesAgo(12),
    fileCount: 3,
    usageCount: 0,
    usageUserCount: 0,
    lastUsedAt: null,
  }),
];

export const skillsListSeed: SkillsList = {
  data: demoSkills,
  pagination: {
    currentPage: 1,
    limit: 10,
    total: demoSkills.length,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  },
};

/** The detail behind one list row, for `/skills/[id]`. */
export function makeSkillDetail(id: string): SkillDetail {
  const item =
    demoSkills.find((skill) => skill.id === id) ??
    (demoSkills[0] as SkillListItem);
  const {
    fileCount: _fileCount,
    authorName: _authorName,
    usageUserCount: _usageUserCount,
    ...rest
  } = item;
  return {
    ...rest,
    id,
    files: [
      {
        id: `${id}-file-notes`,
        skillId: id,
        path: "reference/fields.md",
        content: "# Field reference\n\nThe fields this skill reads.",
        encoding: "utf8",
        digest: null,
        kind: "reference",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  };
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function makeSkillListItem(
  overrides: Partial<SkillListItem> & Pick<SkillListItem, "id" | "name">,
): SkillListItem {
  return {
    organizationId: "test-org",
    authorId: "test-user-admin",
    authorName: "Admin User",
    labels: [],
    createdBy: null,
    scope: "org",
    description: "",
    content: `---\nname: ${overrides.name}\ndescription: A demo skill.\n---\n\nDo the thing, carefully.`,
    digest: null,
    latestVersion: 3,
    license: null,
    compatibility: null,
    allowedTools: null,
    agentName: null,
    templated: false,
    metadata: {},
    sourceType: "manual",
    sourceRef: null,
    sourceCommit: null,
    githubSyncInterval: null,
    githubSyncRef: null,
    githubAppConfigId: null,
    githubPatId: null,
    lastSyncedAt: null,
    lastSyncError: null,
    usageCount: 0,
    usageUserCount: 0,
    lastUsedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    fileCount: 1,
    teams: [],
    users: [],
    environments: [],
    ...overrides,
  };
}

// The one skill the crawled public-GitHub catalog "knows about" in tests.
export const catalogSkillSeed: CatalogSearch["results"][number] = {
  repo: "acme/skills",
  skillPath: "skills/target",
  name: "Target skill",
  description: "Seeded catalog entry for the skills import specs.",
  compatibility: null,
  fileCount: 2,
};

// A skill living at the repository root (empty skillPath) — the select step
// must render and select it even though its path is a falsy string.
export const catalogRootSkillSeed: CatalogSearch["results"][number] = {
  repo: "acme/root-skill",
  skillPath: "",
  name: "Root skill",
  description: "Seeded repo-root catalog entry.",
  compatibility: null,
  fileCount: 1,
};

export const skillCatalogSearchSeed: CatalogSearch = {
  results: [catalogSkillSeed, catalogRootSkillSeed],
  totalCount: 2,
};

function makeDiscoveredSkill(
  overrides: Partial<DiscoveredSkill> = {},
): DiscoveredSkill {
  return {
    skillPath: "skills/alpha",
    name: "Alpha skill",
    description: "A discovered skill.",
    compatibility: null,
    allowedTools: null,
    templated: false,
    fileCount: 1,
    exists: false,
    ...overrides,
  };
}

export const githubDiscoverSeed: GithubDiscover = {
  repoUrl: "acme/skills",
  ref: "main",
  skills: [
    makeDiscoveredSkill({ skillPath: "skills/alpha", name: "Alpha skill" }),
    makeDiscoveredSkill({ skillPath: "skills/beta", name: "Beta skill" }),
  ],
};

export const githubPreviewSeed: GithubPreview = {
  name: catalogSkillSeed.name,
  description: catalogSkillSeed.description,
  content: `---\nname: target-skill\ndescription: ${catalogSkillSeed.description}\n---\n\nDo the thing.`,
  license: null,
  compatibility: null,
  allowedTools: null,
  agentName: null,
  templated: false,
  metadata: {},
  files: [],
  skippedFiles: [],
  sourceRef: "main",
  sourceCommit: "0000000000000000000000000000000000000000",
};

export function makeImportedSkill(
  overrides: Partial<ImportedSkill> = {},
): ImportedSkill {
  return {
    id: "test-skill-imported",
    organizationId: "test-org",
    authorId: "test-user-admin",
    scope: "personal",
    agentName: null,
    name: catalogSkillSeed.name,
    description: catalogSkillSeed.description,
    content: githubPreviewSeed.content,
    digest: null,
    latestVersion: 1,
    license: null,
    compatibility: null,
    allowedTools: null,
    templated: false,
    metadata: {},
    sourceType: "github",
    sourceRef: "main",
    sourceCommit: "0000000000000000000000000000000000000000",
    githubSyncInterval: null,
    githubSyncRef: null,
    githubAppConfigId: null,
    githubPatId: null,
    lastSyncedAt: null,
    lastSyncError: null,
    usageCount: 0,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}
