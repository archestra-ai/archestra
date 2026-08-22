import {
  isSafePluginPath,
  PLUGIN_MAX_FILE_BYTES,
  PLUGIN_MAX_FILES,
  PLUGIN_MAX_TOTAL_BYTES,
} from "@/types";
import type { GithubTreeItem } from "./github-tree";

interface PluginTreeFileCandidate {
  repoPath: string;
  relativePath: string;
  mode: "100644" | "100755";
  size: number;
  sizeKnown: boolean;
}

export function collectPluginTreeFiles(params: {
  tree: GithubTreeItem[];
  subdir: string;
  exclude?: string[];
}): {
  candidates: PluginTreeFileCandidate[];
  skippedFiles: string[];
  unsafePath: string | null;
} {
  const candidates: PluginTreeFileCandidate[] = [];
  const skippedFiles: string[] = [];
  let totalBytes = 0;
  for (const item of params.tree) {
    if (item.type !== "blob" || !item.path) continue;
    const relativePath = relativeToSubdir(item.path, params.subdir);
    if (relativePath === null) continue;
    if (!isSafePluginPath(relativePath)) {
      return { candidates, skippedFiles, unsafePath: relativePath };
    }
    if (
      item.mode === "120000" ||
      isHardExcluded(relativePath) ||
      (params.exclude ?? []).some((pattern) =>
        matchesGlob(relativePath, pattern),
      )
    ) {
      skippedFiles.push(relativePath);
      continue;
    }
    const size = item.size ?? 0;
    const sizeKnown = item.size !== undefined;
    if (
      size > PLUGIN_MAX_FILE_BYTES ||
      candidates.length >= PLUGIN_MAX_FILES ||
      totalBytes + size > PLUGIN_MAX_TOTAL_BYTES
    ) {
      skippedFiles.push(relativePath);
      continue;
    }
    totalBytes += size;
    candidates.push({
      repoPath: item.path,
      relativePath,
      mode: item.mode === "100755" ? "100755" : "100644",
      size,
      sizeKnown,
    });
  }
  return { candidates, skippedFiles, unsafePath: null };
}

function relativeToSubdir(repoPath: string, subdir: string): string | null {
  if (!subdir) return repoPath;
  const prefix = `${subdir}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
}

function isHardExcluded(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower === ".gitignore" ||
    lower === ".gitattributes" ||
    lower === "codeowners" ||
    lower.startsWith(".github/")
  );
}

function matchesGlob(path: string, glob: string): boolean {
  const normalizedGlob = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  const escaped = normalizedGlob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replaceAll("**", "\u0000").replaceAll("*", "[^/]*");
  const pattern = regex.replaceAll("\u0000", ".*");
  return new RegExp(`^${pattern}$`).test(path);
}
