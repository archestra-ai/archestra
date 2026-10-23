import assert from "node:assert/strict";
import test from "node:test";
import { comparisonVariants } from "./comparison-options.mjs";

test("paired comparisons bind each build to a distinct pinned revision", () => {
  const args = [
    "a".repeat(40),
    "b".repeat(40),
    "/tmp/baseline",
    "/tmp/candidate",
  ];
  const variants = comparisonVariants(args);
  assert.deepEqual(
    variants.map(({ commit, dist }) => [commit, dist]),
    [
      [args[0], args[2]],
      [args[1], args[3]],
    ],
  );
  assert.notEqual(variants[0].offset, variants[1].offset);
  for (const invalid of [
    args.slice(0, 3),
    [...args, "extra"],
    ["main", ...args.slice(1)],
    [args[0], args[0], ...args.slice(2)],
    [...args.slice(0, 2), "relative-build", args[3]],
    [...args.slice(0, 3), "/tmp/baseline/../baseline"],
  ])
    assert.throws(() => comparisonVariants(invalid));
});
