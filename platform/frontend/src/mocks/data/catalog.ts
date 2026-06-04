import type { archestraApiTypes } from "@shared";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/** Catalog item with permissive defaults; overrides shallow-merged on top. */
export function makeCatalogItem(
  overrides: Partial<CatalogItem> = {},
): CatalogItem {
  return {
    id: "test-catalog",
    name: "test-catalog",
    version: null,
    description: null,
    instructions: null,
    repository: null,
    installationCommand: null,
    requiresAuth: false,
    authDescription: null,
    authFields: null,
    serverType: "local",
    multitenant: false,
    serverUrl: null,
    docsUrl: null,
    clientSecretId: null,
    localConfigSecretId: null,
    localConfig: null,
    deploymentSpecYaml: null,
    userConfig: null,
    oauthConfig: null,
    enterpriseManagedConfig: null,
    icon: null,
    organizationId: null,
    authorId: null,
    scope: "org",
    environmentId: null,
    clonedFrom: null,
    catalogReinstallRequired: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    labels: [],
    teams: [],
    toolCount: 0,
    ...overrides,
  };
}

export const catalogSeed: archestraApiTypes.GetInternalMcpCatalogResponses["200"] =
  [
    makeCatalogItem({
      id: "test-catalog-filesystem",
      name: "filesystem",
      version: "1.0.0",
      description: "Read and write files on the local filesystem.",
      toolCount: 3,
    }),
    makeCatalogItem({
      id: "test-catalog-github",
      name: "github",
      version: "2.0.0",
      description:
        "Interact with GitHub repositories, issues, and pull requests.",
      requiresAuth: true,
      serverType: "remote",
      multitenant: true,
      toolCount: 8,
    }),
  ];
