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
    composition: {
      served: {
        kind: "current",
        rootRevision: 3,
        composedAt: "2026-09-18T12:00:00Z",
      },
      refusal: null,
    },
    managedInGithub: false,
    heldPull: null,
    credentialBindings: [],
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
    served: {
      status: overrides.status ?? "active",
      composed: overrides.composed ?? true,
    },
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

test("a refusal reads each battery as the composition the runtime still enforces holds it", () => {
  const refusal = {
    message: "acme: unknown trust rank",
    at: "2026-09-18T13:00:00Z",
    rootRevision: 4,
  };
  const batteries = [
    battery({ name: "acme", status: "active", line: 2 }),
    battery({
      name: "globex",
      status: "missing_credentials",
      composed: false,
      line: 5,
      served: null,
    }),
  ];
  expect(
    policyAnnotations(
      declarations({
        batteries,
        lastError: refusal.message,
        composition: {
          served: {
            kind: "previous",
            rootRevision: 3,
            composedAt: "2026-09-18T12:00:00Z",
            batteries: [{ name: "acme", status: "active", composed: true }],
          },
          refusal,
        },
      }),
    ),
  ).toEqual([
    { kind: "battery", line: 2, name: "acme", status: "active" },
    { kind: "battery", line: 5, name: "globex", status: "pending" },
  ]);
  expect(
    policyAnnotations(
      declarations({
        batteries,
        lastError: refusal.message,
        composition: { served: { kind: "root_only" }, refusal },
      }),
    ).map((annotation) =>
      annotation.kind === "battery" ? annotation.status : null,
    ),
  ).toEqual(["refused", "refused"]);
});

test("a policy that declares nothing annotates nothing", () => {
  expect(policyAnnotations(declarations())).toEqual([]);
});
