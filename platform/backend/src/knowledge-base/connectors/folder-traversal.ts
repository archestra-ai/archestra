export interface FolderTraversalAdapter {
  listDirectSubfolders(parentId: string): Promise<string[]>;
}

export interface FolderTraversalOptions {
  rootFolderId: string;
  recursive?: boolean;
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 50;

export async function* traverseFolders(
  adapter: FolderTraversalAdapter,
  options: FolderTraversalOptions,
  log?: {
    debug: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  },
): AsyncGenerator<string> {
  const {
    rootFolderId,
    recursive = true,
    maxDepth = DEFAULT_MAX_DEPTH,
  } = options;

  const queue: Array<[string, number]> = [[rootFolderId, 0]];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    const [currentFolderId, depth] = entry;

    yield currentFolderId;

    if (!recursive) continue;

    if (depth >= maxDepth) {
      log?.debug(
        { folderId: currentFolderId, depth, maxDepth },
        "Max depth reached, not descending further",
      );
      continue;
    }

    try {
      const childFolders = await adapter.listDirectSubfolders(currentFolderId);
      for (const childId of childFolders) {
        queue.push([childId, depth + 1]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.warn(
        { folderId: currentFolderId, depth, error: message },
        "Failed to list subfolders, skipping branch",
      );
    }
  }
}
