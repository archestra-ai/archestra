interface InstallStatusRow {
  id: string;
  catalogId: string | null;
  localInstallationStatus?: string | null;
}

/**
 * Picks which completed installs get a "Successfully installed" toast.
 *
 * A single-tenant install owns its own deployment, so each successful one
 * gets its own toast. A multi-tenant catalog runs ONE shared deployment
 * behind every install row: one rollout flips all of those rows to success,
 * so the catalog gets one toast — on the last of its rows to finish, and only
 * once per batch.
 */
export function selectInstallSuccessToastIds<
  T extends InstallStatusRow,
>(params: {
  completedIds: string[];
  servers: T[];
  multitenantCatalogIds: ReadonlySet<string>;
}): string[] {
  const { completedIds, servers, multitenantCatalogIds } = params;
  const toastedCatalogIds = new Set<string>();
  const result: string[] = [];

  for (const id of completedIds) {
    const server = servers.find((s) => s.id === id);
    if (server?.localInstallationStatus !== "success") continue;

    const catalogId = server.catalogId;
    if (!catalogId || !multitenantCatalogIds.has(catalogId)) {
      result.push(id);
      continue;
    }

    if (toastedCatalogIds.has(catalogId)) continue;
    const siblingStillInstalling = servers.some(
      (s) =>
        s.catalogId === catalogId &&
        s.id !== id &&
        IN_PROGRESS_STATUSES.has(s.localInstallationStatus ?? ""),
    );
    if (siblingStillInstalling) continue;

    toastedCatalogIds.add(catalogId);
    result.push(id);
  }

  return result;
}

// ===

const IN_PROGRESS_STATUSES = new Set(["pending", "discovering-tools"]);
