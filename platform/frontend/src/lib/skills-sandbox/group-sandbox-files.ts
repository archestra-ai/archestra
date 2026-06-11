import type { archestraApiTypes } from "@archestra/shared";

type FilesResponse = archestraApiTypes.GetSkillSandboxFilesResponses["200"];
export type SandboxFileRow = FilesResponse["files"][number];

export type SandboxFileGroup = {
  /** Folder name; null = top-level files (rendered first, without a header). */
  folder: string | null;
  /** Row id of the folder; null for the root group and hand-made directories. */
  folderId: string | null;
  files: SandboxFileRow[];
};

/**
 * Order the PFS listing for rendering: top-level files first, then one group
 * per folder sorted by name. Empty folders keep their group (so a freshly
 * created folder is visible); files keep the API's newest-first order.
 */
export function groupSandboxFiles(
  data: FilesResponse | null | undefined,
): SandboxFileGroup[] {
  if (!data) return [];

  const byFolder = new Map<string, SandboxFileRow[]>();
  const rootFiles: SandboxFileRow[] = [];
  for (const file of data.files) {
    if (file.folder == null) {
      rootFiles.push(file);
    } else {
      const list = byFolder.get(file.folder) ?? [];
      list.push(file);
      byFolder.set(file.folder, list);
    }
  }

  const folderNames = new Set<string>([
    ...data.folders.map((f) => f.name),
    ...byFolder.keys(),
  ]);
  const folderIdByName = new Map(data.folders.map((f) => [f.name, f.id]));

  const groups: SandboxFileGroup[] = [];
  if (rootFiles.length > 0) {
    groups.push({ folder: null, folderId: null, files: rootFiles });
  }
  for (const name of [...folderNames].sort((a, b) => a.localeCompare(b))) {
    groups.push({
      folder: name,
      folderId: folderIdByName.get(name) ?? null,
      files: byFolder.get(name) ?? [],
    });
  }
  return groups;
}
