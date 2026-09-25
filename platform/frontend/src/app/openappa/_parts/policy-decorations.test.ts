// @vitest-environment node
import { expect, test } from "vitest";
import type { PolicyDeclarations } from "@/lib/openappa-batteries.query";
import { policyAnnotations } from "./policy-decorations";

function declarations(
  overrides: Partial<PolicyDeclarations> = {},
): PolicyDeclarations {
  return {
    batteries: [],
    unusedAliases: [],
    rootRevision: 3,
    lastError: null,
    managedInGithub: false,
    heldPull: null,
    ...overrides,
  };
}

function battery(
  overrides: Partial<PolicyDeclarations["batteries"][number]>,
): PolicyDeclarations["batteries"][number] {
  return {
    entry: "acme/policy.toml",
    name: "acme",
    source: "bundled",
    packageHash: null,
    status: "active",
    scope: "catalogs",
    composed: true,
    line: 1,
    servers: [],
    credentials: [],
    helpers: [],
    ...overrides,
  };
}

test("annotates every declared battery and unclaimed alias, in reading order", () => {
  expect(
    policyAnnotations(
      declarations({
        batteries: [
          battery({ name: "acme", status: "active", line: 9 }),
          battery({ name: "globex", status: "missing_credentials", line: 3 }),
        ],
        unusedAliases: [
          { namespace: "initech", servers: ["initech"], line: 6 },
        ],
      }),
    ),
  ).toEqual([
    { kind: "battery", line: 3, name: "globex", status: "missing_credentials" },
    { kind: "unusedAlias", line: 6, namespace: "initech" },
    { kind: "battery", line: 9, name: "acme", status: "active" },
  ]);
});

test("a failed composition reads every battery as refused", () => {
  expect(
    policyAnnotations(
      declarations({
        batteries: [
          battery({ name: "acme", status: "active", line: 2 }),
          battery({ name: "globex", status: "missing_credentials", line: 5 }),
        ],
        lastError: "acme: unknown trust rank",
      }),
    ),
  ).toEqual([
    { kind: "battery", line: 2, name: "acme", status: "refused" },
    { kind: "battery", line: 5, name: "globex", status: "refused" },
  ]);
});

test("a policy that declares nothing annotates nothing", () => {
  expect(policyAnnotations(declarations())).toEqual([]);
});
