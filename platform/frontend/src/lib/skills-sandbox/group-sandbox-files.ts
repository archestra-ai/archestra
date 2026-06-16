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
  const byProject = new Map<
    string,
    { id: string | null; files: SandboxFileRow[] }
  >();
  for (const file of data.files) {
    if (file.projectId == null || file.projectName == null) {
      own.push(file);
    } else {
      const entry = byProject.get(file.projectName) ?? {
        id: file.projectId,
        files: [],
      };
      entry.files.push(file);
      byProject.set(file.projectName, entry);
    }
  }

  const groups: SandboxFileGroup[] = [];
  if (own.length > 0)
    groups.push({ project: null, projectId: null, files: own });
  for (const name of [...byProject.keys()].sort((a, b) => a.localeCompare(b))) {
    const entry = byProject.get(name);
    if (!entry) continue;
    groups.push({ project: name, projectId: entry.id, files: entry.files });
  }
  return groups;
}
