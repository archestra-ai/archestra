import { rm } from "node:fs/promises";
import path from "node:path";

export type CleanupDevCachesOptions = {
  rootDir?: string;
  dryRun?: boolean;
  log?: (message: string) => void;
};

export type CleanupDevCachesResult = {
  removed: string[];
  failed: Array<{ target: string; error: unknown }>;
};

export const devCacheTargets = ["frontend/.next/dev/cache"] as const;

export async function cleanupDevCaches(
  options: CleanupDevCachesOptions = {},
): Promise<CleanupDevCachesResult> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const log = options.log ?? console.log;
  const removed: string[] = [];
  const failed: Array<{ target: string; error: unknown }> = [];

  for (const target of devCacheTargets) {
    const targetPath = path.resolve(rootDir, target);

    if (!isPathInside(rootDir, targetPath)) {
      failed.push({
        target,
        error: new Error(`Refusing to remove path outside root: ${targetPath}`),
      });
      continue;
    }

    try {
      if (options.dryRun) {
        log(`[dry-run] Would remove ${target}`);
      } else {
        await rm(targetPath, { force: true, recursive: true });
        log(`Removed ${target}`);
      }
      removed.push(target);
    } catch (error) {
      failed.push({ target, error });
    }
  }

  return { removed, failed };
}

async function main() {
  const args = new Set(process.argv.slice(2));

  const result = await cleanupDevCaches({
    dryRun: args.has("--dry-run"),
  });

  if (result.failed.length > 0) {
    for (const failure of result.failed) {
      console.error(`Failed to remove ${failure.target}:`, failure.error);
    }
    process.exitCode = 1;
  }
}

function isPathInside(rootDir: string, targetPath: string) {
  const relativePath = path.relative(rootDir, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
