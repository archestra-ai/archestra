import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Shuffles the test files with the run's seed, as `sequence.shuffle` does,
 * but keeps each project's files together, and retires the database-backed
 * shared workers after about FILES_PER_SHARED_WORKER files each.
 *
 * Vitest keeps a shared (`isolate: false`) worker only when the next file in
 * its queue belongs to the same project. With every project's files shuffled
 * into one queue, the next file was usually from another project, so the
 * clean project's workers stopped after almost every file and lost what
 * sharing them saves: the imported backend and the kept test database.
 *
 * A worker that runs hundreds of files, though, accumulates what they leave
 * behind (heap, caches, slow-burning state) and starts failing tests
 * intermittently. So the clean project runs in chunks with a few isolated
 * files between them: a worker that takes one of those ends, and the next
 * chunk starts in fresh workers.
 *
 * The isolated files left over run first: they are the slowest, so the run
 * does not end waiting on them.
 */
export class ProjectGroupedSequencer extends BaseSequencer {
  override async sort(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const byProject = new Map<string, TestSpecification[]>();
    for (const file of shuffle(files, this.ctx.config.sequence.seed)) {
      const name = file.project.name;
      const group = byProject.get(name) ?? [];
      group.push(file);
      byProject.set(name, group);
    }
    const take = (names: string[]) =>
      names.flatMap((name) => byProject.get(name) ?? []);
    const isolated = take(ISOLATED_PROJECTS);
    const recycled = take([RECYCLED_PROJECT]);
    const others = take(
      [...byProject.keys()]
        .filter(
          (name) =>
            name !== RECYCLED_PROJECT && !ISOLATED_PROJECTS.includes(name),
        )
        .sort(),
    );

    const workers = Math.max(1, Number(this.ctx.config.maxWorkers) || 1);
    const chunkSize = workers * FILES_PER_SHARED_WORKER;
    const chunked: TestSpecification[] = [];
    for (let start = 0; start < recycled.length; start += chunkSize) {
      if (start > 0) chunked.push(...isolated.splice(-workers, workers));
      chunked.push(...recycled.slice(start, start + chunkSize));
    }
    return [...isolated, ...chunked, ...others];
  }
}

// ===== Internal helpers =====

/** Isolated projects, slowest first. Their files also separate the chunks. */
const ISOLATED_PROJECTS = ["mocked", "unit-mocked"];

/** The shared project whose workers carry a database and the backend. */
const RECYCLED_PROJECT = "clean";

const FILES_PER_SHARED_WORKER = 25;

/** Fisher-Yates with a seeded generator, so a seed replays the same order. */
function shuffle<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0;
  const random = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}
