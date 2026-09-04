export function calculateVitestResourceLimits(params: {
  isCI: boolean;
  availableParallelism: number;
  totalMemoryBytes: number;
}): { maxWorkers: number; maxOldSpaceMb: number } {
  const { isCI, availableParallelism, totalMemoryBytes } = params;
  if (isCI) {
    const maxWorkers = Math.min(
      availableParallelism,
      Math.max(1, Math.floor(totalMemoryBytes / CI_MEMORY_PER_WORKER_BYTES)),
    );
    return {
      maxWorkers,
      maxOldSpaceMb: Math.max(
        MIN_CI_OLD_SPACE_MB,
        Math.floor(
          (totalMemoryBytes * CI_OLD_SPACE_MEMORY_FRACTION) /
            maxWorkers /
            BYTES_PER_MIB,
        ),
      ),
    };
  }

  // Forks duplicate the module graph and PGlite database. Keep interactive
  // machines responsive while retaining enough parallelism to beat one or two
  // workers on representative backend suites.
  const cpuWorkers = Math.max(
    1,
    Math.min(
      MAX_LOCAL_WORKERS,
      Math.floor(availableParallelism * LOCAL_CPU_FRACTION),
    ),
  );
  const memoryWorkers = Math.max(
    1,
    Math.floor(
      (totalMemoryBytes * LOCAL_MEMORY_FRACTION) /
        ESTIMATED_LOCAL_WORKER_RSS_BYTES,
    ),
  );
  const maxWorkers = Math.min(cpuWorkers, memoryWorkers);
  const memoryBudgetPerWorkerMb = Math.floor(
    (totalMemoryBytes * LOCAL_MEMORY_FRACTION) / maxWorkers / BYTES_PER_MIB,
  );

  return {
    maxWorkers,
    maxOldSpaceMb: Math.max(
      MIN_LOCAL_OLD_SPACE_MB,
      Math.min(MAX_LOCAL_OLD_SPACE_MB, memoryBudgetPerWorkerMb),
    ),
  };
}

const BYTES_PER_MIB = 1024 ** 2;
const BYTES_PER_GIB = 1024 ** 3;

const CI_MEMORY_PER_WORKER_BYTES = 5 * BYTES_PER_GIB;
const CI_OLD_SPACE_MEMORY_FRACTION = 0.75;
const MIN_CI_OLD_SPACE_MB = 2048;

const LOCAL_CPU_FRACTION = 0.25;
const LOCAL_MEMORY_FRACTION = 0.25;
const MAX_LOCAL_WORKERS = 4;
const ESTIMATED_LOCAL_WORKER_RSS_BYTES = 3 * BYTES_PER_GIB;
const MIN_LOCAL_OLD_SPACE_MB = 1536;
const MAX_LOCAL_OLD_SPACE_MB = 3072;
