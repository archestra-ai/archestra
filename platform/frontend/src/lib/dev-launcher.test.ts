import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getDevNodeOptions } from "../../scripts/dev.mjs";

describe("dev server heap budget", () => {
  it("bounds Node's effective heap and prevents Next's half-RAM override", () => {
    const child = readChildOptions();
    expect(child.oldSpace).toBe(4096);
    expect(child.heapLimit).toBeGreaterThanOrEqual(4096 * 1024 ** 2);
    expect(child.heapLimit).toBeLessThan(4608 * 1024 ** 2);
  });

  it.each([
    "--max-old-space-size=1536",
    "--max_old_space_size=1536",
  ])("preserves the explicit budget %s", (option) => {
    const child = readChildOptions(option);
    expect(child.oldSpace).toBe(1536);
    expect(child.heapLimit).toBeLessThan(2048 * 1024 ** 2);
  });

  it("preserves unrelated options and quoted values", () => {
    const child = readChildOptions(
      '--enable-source-maps --title="dev preview" --max-old-space-size=1536',
    );
    expect(child.oldSpace).toBe(1536);
    expect(child.sourceMaps).toBe(true);
    expect(child.title).toBe("dev preview");
  });
});

// Exercise Node's flag parsing and Next's actual launcher option handling:
// underscore/hyphen aliases must survive both, including explicit overrides.
function readChildOptions(nodeOptions?: string) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `
        const { getMaxOldSpaceSize } = require('next/dist/server/lib/utils');
        console.log(JSON.stringify({
          oldSpace: getMaxOldSpaceSize(),
          heapLimit: require('node:v8').getHeapStatistics().heap_size_limit,
          sourceMaps: process.sourceMapsEnabled,
          title: process.title,
        }));
        `,
      ],
      {
        env: { ...process.env, NODE_OPTIONS: getDevNodeOptions(nodeOptions) },
        encoding: "utf8",
      },
    ),
  );
}
