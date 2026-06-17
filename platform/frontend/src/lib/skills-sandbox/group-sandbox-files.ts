import type { archestraApiTypes } from "@archestra/shared";

type FilesResponse = archestraApiTypes.GetSkillSandboxFilesResponses["200"];
export type SandboxFileRow = FilesResponse["files"][number];

export type SandboxFileGroup = {
  /** Project name; null = the user's own files (rendered first, no header). */
  project: string | null;
  projectId: string | null;
  files: SandboxFileRow[];
};

/**
 * Order the PFS listing for rendering: the user's own files first, then one
 * group per project sorted by name. Files keep the API's newest-first order.
 */
export function groupSandboxFiles(
  data: FilesResponse | null | undefined,
): SandboxFileGroup[] {
  if (!data) return [];

  const own: SandboxFileRow[] = [];
  // keyed by projectId, NOT name: the merged list can contain two distinct
  // accessible projects (own + shared) that happen to share a name.
  const byProject = new Map<
    string,
    { name: string; files: SandboxFileRow[] }
  >();
  for (const file of data.files) {
    if (file.projectId == null || file.projectName == null) {
      own.push(file);
    } else {
      const entry = byProject.get(file.projectId) ?? {
        name: file.projectName,
        files: [],
      };
      entry.files.push(file);
      byProject.set(file.projectId, entry);
    }
  }

  const groups: SandboxFileGroup[] = [];
  if (own.length > 0) {
    groups.push({ project: null, projectId: null, files: own });
  }
  const projectGroups = [...byProject.entries()]
    .sort(
      ([idA, a], [idB, b]) =>
        a.name.localeCompare(b.name) || idA.localeCompare(idB),
    )
    .map(([projectId, entry]) => ({
      project: entry.name,
      projectId,
      files: entry.files,
    }));
  groups.push(...projectGroups);
  return groups;
}
