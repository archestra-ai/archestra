import type { archestraApiTypes } from "@archestra/shared";

type SkillsList = archestraApiTypes.GetSkillsResponses["200"];
type CatalogSearch = archestraApiTypes.SearchSkillCatalogResponses["200"];
type GithubDiscover = archestraApiTypes.DiscoverGithubSkillsResponses["200"];
type DiscoveredSkill = GithubDiscover["skills"][number];
type GithubPreview = archestraApiTypes.PreviewGithubSkillResponses["200"];
type GithubImport = archestraApiTypes.ImportGithubSkillsResponses["200"];
type ImportedSkill = GithubImport["created"][number];

export const skillsListSeed: SkillsList = {
  data: [],
  pagination: {
    currentPage: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  },
};

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
    name: catalogSkillSeed.name,
    description: catalogSkillSeed.description,
    content: githubPreviewSeed.content,
    latestVersion: 1,
    license: null,
    compatibility: null,
    allowedTools: null,
    templated: false,
    metadata: {},
    sourceType: "github",
    sourceRef: "main",
    sourceCommit: "0000000000000000000000000000000000000000",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
