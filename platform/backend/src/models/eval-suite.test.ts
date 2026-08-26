import { expect, test } from "@/test";
import EvalCaseModel from "./eval-case";
import EvalSuiteModel from "./eval-suite";

const SAMPLE_ASSERTIONS = [
  {
    type: "contains" as const,
    values: ["hello"],
    mode: "all" as const,
    caseSensitive: false,
  },
];

test("create returns the suite and enforces per-org name uniqueness", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const user = await makeUser();

  const suite = await EvalSuiteModel.create({
    organizationId: org.id,
    name: "Smoke",
    description: "smoke tests",
    createdBy: user.id,
  });
  expect(suite.name).toBe("Smoke");
  expect(suite.organizationId).toBe(org.id);

  await expect(
    EvalSuiteModel.create({ organizationId: org.id, name: "Smoke" }),
  ).rejects.toThrow('An eval suite named "Smoke" already exists');

  // Same name in another org is fine.
  const foreign = await EvalSuiteModel.create({
    organizationId: otherOrg.id,
    name: "Smoke",
  });
  expect(foreign.id).not.toBe(suite.id);
});

test("soft delete hides the suite and frees its name", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const suite = await EvalSuiteModel.create({
    organizationId: org.id,
    name: "Recycled",
  });

  expect(await EvalSuiteModel.softDelete(suite.id, org.id)).toBe(true);
  expect(await EvalSuiteModel.findById(suite.id, org.id)).toBeNull();

  // Name is reusable after soft delete.
  const reborn = await EvalSuiteModel.create({
    organizationId: org.id,
    name: "Recycled",
  });
  expect(reborn.id).not.toBe(suite.id);

  // Deleting again reports not-found.
  expect(await EvalSuiteModel.softDelete(suite.id, org.id)).toBe(false);
});

test("findById and update are org-scoped", async ({ makeOrganization }) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const suite = await EvalSuiteModel.create({
    organizationId: org.id,
    name: "Scoped",
  });

  expect(await EvalSuiteModel.findById(suite.id, otherOrg.id)).toBeNull();
  expect(
    await EvalSuiteModel.update({
      id: suite.id,
      organizationId: otherOrg.id,
      updates: { name: "Hijacked" },
    }),
  ).toBeNull();

  const updated = await EvalSuiteModel.update({
    id: suite.id,
    organizationId: org.id,
    updates: { name: "Renamed", description: "new desc" },
  });
  expect(updated?.name).toBe("Renamed");
  expect(updated?.description).toBe("new desc");
});

test("listByOrganization returns case counts and skips deleted suites", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const withCases = await EvalSuiteModel.create({
    organizationId: org.id,
    name: "With cases",
  });
  const empty = await EvalSuiteModel.create({
    organizationId: org.id,
    name: "Empty",
  });
  const deleted = await EvalSuiteModel.create({
    organizationId: org.id,
    name: "Deleted",
  });
  await EvalSuiteModel.softDelete(deleted.id, org.id);

  for (const name of ["a", "b"]) {
    await EvalCaseModel.create({
      organizationId: org.id,
      insert: {
        suiteId: withCases.id,
        name,
        input: "say hello",
        assertions: SAMPLE_ASSERTIONS,
      },
    });
  }

  const suites = await EvalSuiteModel.listByOrganization({
    organizationId: org.id,
    limit: 10,
    offset: 0,
  });
  expect(suites.map((s) => s.id).sort()).toEqual(
    [withCases.id, empty.id].sort(),
  );
  expect(suites.find((s) => s.id === withCases.id)?.caseCount).toBe(2);
  expect(suites.find((s) => s.id === empty.id)?.caseCount).toBe(0);
  expect(
    await EvalSuiteModel.countByOrganization({ organizationId: org.id }),
  ).toBe(2);
});

test("findByIdForAudit snapshots the case list", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();
  const suite = await EvalSuiteModel.create({
    organizationId: org.id,
    name: "Audited",
  });
  await EvalCaseModel.create({
    organizationId: org.id,
    insert: {
      suiteId: suite.id,
      name: "case one",
      input: "hi",
      assertions: SAMPLE_ASSERTIONS,
    },
  });

  const snapshot = await EvalSuiteModel.findByIdForAudit(suite.id, org.id);
  expect(snapshot).toMatchObject({
    id: suite.id,
    name: "Audited",
    cases: [
      {
        name: "case one",
        input: "hi",
        position: 1,
        assertions: SAMPLE_ASSERTIONS,
      },
    ],
  });

  const foreignOrg = await makeOrganization();
  expect(
    await EvalSuiteModel.findByIdForAudit(suite.id, foreignOrg.id),
  ).toBeNull();
});
