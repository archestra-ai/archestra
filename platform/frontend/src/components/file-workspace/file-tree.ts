/** What a file workspace needs of each file it lists. */
export interface WorkspaceFile {
  /** Unique among the files of one workspace. */
  key: string;
  /** Repository-style path, such as "references/api.md". */
  path: string;
  /** The path's last segment. */
  name: string;
  /** Listed, struck through, and cannot be opened. */
  disabled?: boolean;
}

export type FileTreeNode<F> =
  | { type: "dir"; name: string; path: string; children: FileTreeNode<F>[] }
  | { type: "file"; name: string; path: string; file: F };

/**
 * The files as folders: folders first, then files, each alphabetical. A folder
 * whose only child is a folder merges with it ("batteries/archestra"), as an
 * IDE's compact folders do. `folders` adds folders that hold no file yet.
 */
export function buildFileTree<F extends { path: string; name: string }>(
  files: F[],
  folders: string[] = [],
): FileTreeNode<F>[] {
  const top: FileTreeNode<F>[] = [];
  const dirAt = (segments: string[]) => {
    let level = top;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let dir = level.find(
        (node): node is Extract<FileTreeNode<F>, { type: "dir" }> =>
          node.type === "dir" && node.name === segment,
      );
      if (!dir) {
        dir = { type: "dir", name: segment, path: prefix, children: [] };
        level.push(dir);
      }
      level = dir.children;
    }
    return level;
  };
  for (const folder of folders) dirAt(folder.split("/").filter(Boolean));
  for (const file of files) {
    dirAt(file.path.split("/").slice(0, -1)).push({
      type: "file",
      name: file.name,
      path: file.path,
      file,
    });
  }
  return compact(sort(top));
}

function sort<F>(nodes: FileTreeNode<F>[]): FileTreeNode<F>[] {
  return nodes
    .map((node) =>
      node.type === "dir" ? { ...node, children: sort(node.children) } : node,
    )
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function compact<F>(nodes: FileTreeNode<F>[]): FileTreeNode<F>[] {
  return nodes.map((node) => {
    if (node.type === "file") return node;
    let dir = node;
    while (dir.children.length === 1 && dir.children[0].type === "dir") {
      const only = dir.children[0];
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return { ...dir, children: compact(dir.children) };
  });
}
