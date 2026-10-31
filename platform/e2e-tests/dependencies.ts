/**
 * biome-ignore-all lint/correctness/noEmptyPattern: Playwright requires the
 * destructuring pattern as a fixture's first parameter
 */
import { type TestInfo, test } from "@playwright/test";

/**
 * Dependencies a spec needs beyond the platform itself.
 *
 * Tag a test or a describe group with `@needs-kubernetes` when it installs a
 * local MCP server or otherwise needs the Kubernetes orchestrator, and with
 * `@needs-keycloak` when it needs the e2e Keycloak realm. A stack that does
 * not run one of them names it in `E2E_UNAVAILABLE` (comma-separated:
 * `kubernetes`, `keycloak`), and the tagged tests report as skipped with the
 * reason instead of failing. CI runs both and sets nothing.
 *
 * Both fixture bases (`fixtures.ts`, `tests/api-fixtures.ts`) register
 * `skipWithoutDependencies` as an automatic fixture, so every test gets the
 * check. The fixture runs after the group's `beforeAll` hooks: a group whose
 * `beforeAll` itself needs the dependency also calls `skipWhenUnavailable`
 * in its body, which skips the whole group before any hook runs.
 */
const DEPENDENCY_TAGS = {
  "@needs-kubernetes": "kubernetes",
  "@needs-keycloak": "keycloak",
} as const;

type Dependency = (typeof DEPENDENCY_TAGS)[keyof typeof DEPENDENCY_TAGS];

const DEPENDENCIES = Object.values(DEPENDENCY_TAGS) as Dependency[];

/** The dependencies `E2E_UNAVAILABLE` names. An unknown name is an error. */
function unavailableDependencies(
  value = process.env.E2E_UNAVAILABLE,
): Set<Dependency> {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter(
    (name) => !DEPENDENCIES.includes(name as Dependency),
  );
  if (unknown.length > 0) {
    throw new Error(
      `E2E_UNAVAILABLE names unknown dependencies: ${unknown.join(", ")} (known: ${DEPENDENCIES.join(", ")})`,
    );
  }
  return new Set(names as Dependency[]);
}

/** The first dependency among the tags that the environment does not run. */
function missingDependency(tags: readonly string[]): Dependency | undefined {
  const unavailable = unavailableDependencies();
  for (const tag of tags) {
    const dependency = DEPENDENCY_TAGS[tag as keyof typeof DEPENDENCY_TAGS];
    if (dependency && unavailable.has(dependency)) {
      return dependency;
    }
  }
  return undefined;
}

function skipReason(dependency: Dependency): string {
  return `needs ${dependency}, which this stack does not run (E2E_UNAVAILABLE)`;
}

/**
 * Call in a describe body: skips the whole group at collection time when the
 * dependency is unavailable, before any `beforeAll` hook runs.
 */
export function skipWhenUnavailable(dependency: Dependency): void {
  test.skip(unavailableDependencies().has(dependency), skipReason(dependency));
}

/**
 * Automatic fixture: skips the test when a dependency its tags name is
 * unavailable. Registered by both fixture bases as
 * `[skipWithoutDependencies, { auto: true }]`.
 */
export async function skipWithoutDependencies(
  {}: object,
  use: (value: undefined) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const dependency = missingDependency(testInfo.tags);
  if (dependency) {
    testInfo.skip(true, skipReason(dependency));
  }
  await use(undefined);
}
