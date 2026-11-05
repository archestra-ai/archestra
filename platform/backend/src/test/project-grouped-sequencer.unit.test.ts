import { expect, test } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import { ProjectGroupedSequencer } from "./project-grouped-sequencer";

const ROOT = "/repo/backend";

test("every file runs on exactly one shard, and each project is split evenly", async () => {
  const files = [
    ...specs("mocked", 7),
    ...specs("clean", 20),
    ...specs("unit", 5),
  ];
  const shards = await Promise.all(
    [1, 2, 3].map((index) => sequencer({ index, count: 3 }).shard(files)),
  );

  expect(shards.flat().map(path).sort()).toEqual(files.map(path).sort());
  for (const project of ["mocked", "clean", "unit"]) {
    const counts = shards.map(
      (shard) => shard.filter((file) => file.project.name === project).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  }
});

test("shards agree on the split whatever order they receive the files in", async () => {
  const files = [...specs("mocked", 6), ...specs("clean", 9)];
  const forward = await sequencer({ index: 1, count: 2 }).shard(files);
  const reversed = await sequencer({ index: 1, count: 2 }).shard(
    [...files].reverse(),
  );
  expect(reversed.map(path).sort()).toEqual(forward.map(path).sort());
});

// ===

function sequencer(shard: { index: number; count: number }) {
  return new ProjectGroupedSequencer({
    config: { root: ROOT, shard, sequence: { seed: 1 }, maxWorkers: 1 },
  } as unknown as Vitest);
}

function specs(project: string, count: number): TestSpecification[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        moduleId: `${ROOT}/src/${project}/file-${i}.test.ts`,
        project: { name: project },
      }) as unknown as TestSpecification,
  );
}

function path(file: TestSpecification): string {
  return file.moduleId;
}
