import { describe, expect, test } from "vitest";
import { JEV_SESSION_SPEC, type ScorerSpec, specHash } from "./spec";

/** Every string leaf of the question set, as a path from `questions`. */
function questionTextPaths(value: unknown, path: string[] = []): string[][] {
  if (typeof value === "string") return [path];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    questionTextPaths(child, [...path, key]),
  );
}

function withEditedText(spec: ScorerSpec, path: string[]): ScorerSpec {
  const copy = structuredClone(spec);
  let node: Record<string, unknown> = copy.questions;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  node[leaf] = `${node[leaf]} (edited)`;
  return copy;
}

function reverseKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reverseKeys);
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([k, v]) => [k, reverseKeys(v)]),
  );
}

describe("specHash", () => {
  const baseline = specHash(JEV_SESSION_SPEC);

  test.each(
    questionTextPaths(JEV_SESSION_SPEC.questions).map((path) => [
      path.join("."),
      path,
    ]),
  )("changes when %s changes", (_, path) => {
    expect(specHash(withEditedText(JEV_SESSION_SPEC, path))).not.toBe(baseline);
  });

  test("changes with the model or the state template version", () => {
    expect(specHash({ ...JEV_SESSION_SPEC, model: "jev-1.14.0" })).not.toBe(
      baseline,
    );
    expect(
      specHash({
        ...JEV_SESSION_SPEC,
        stateTemplateVersion: JEV_SESSION_SPEC.stateTemplateVersion + 1,
      }),
    ).not.toBe(baseline);
  });

  test("changes when criteria are reordered", () => {
    const criteria = [...JEV_SESSION_SPEC.questions.tier_needed.criteria];
    const reordered = structuredClone(JEV_SESSION_SPEC);
    reordered.questions.tier_needed.criteria = criteria.reverse();
    expect(specHash(reordered)).not.toBe(baseline);
  });

  test("is stable under object key reordering", () => {
    const reordered = reverseKeys(JEV_SESSION_SPEC) as ScorerSpec;
    expect(JSON.stringify(reordered)).not.toBe(
      JSON.stringify(JEV_SESSION_SPEC),
    );
    expect(specHash(reordered)).toBe(baseline);
  });
});
